/**
 * CachingService - RSU 缓存命中率实时计算服务
 *
 * 职责:
 * 1. 根据车辆实时位置追踪各 RSU 走廊的车辆分布
 * 2. 计算实时的 Prob_Route（路线概率）
 * 3. 加载 MATLAB 输出的 CacheDecision 和 psi
 * 4. 计算加权缓存命中率
 * 5. 周期性触发 MATLAB 重算
 * 6. 通过 WebSocket 广播 RSU 数据
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeRSUDeployment } from '../utils/rsuDeployment.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')

// 算法参数（与 MATLAB 默认值一致）
const ALGO_PARAMS = {
  E: 3,
  X: 150,
  alpha: 0.8,
  Capacity_Scale: 1.2,
  allowed_layers_per_block: [3, 4, 4],
  layer_profit_ranges: {
    Raw: [25, 35],
    Geo: [15, 25],
    Sem: [8, 15],
    Dyn: [-5, 5],
  },
}

// 纬度容差（判断车辆是否在某个走廊内）
// 以区域中心纬度 ±0.01（约 ±1.1km），覆盖各路线的主要行驶范围
const REGION_TOLERANCE = 0.01

// 块（Chunk）模型参数
const CHUNKS_PER_VEHICLE = 100  // 每辆车请求的数据块数量
const RSU_PROXIMITY_M = 300     // 车辆-RSU 近距离匹配阈值（米）

// 6 条车辆路线定义（与 simulationService.js 一致）
const ROUTE_DEFS = [
  { id: 1, name: '古平岗→新庄' },
  { id: 2, name: '草场门→九华山' },
  { id: 3, name: '汉中门→西安门' },
  { id: 4, name: '古平岗→汉中门' },
  { id: 5, name: '新模范马路→新街口' },
  { id: 6, name: '新庄→西安门' },
]

/**
 * Haversine 距离计算（米）
 */
function haversineDist(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export class CachingService {
  constructor(io) {
    this.io = io

    // 动态加载 RSU 部署数据
    const deployment = computeRSUDeployment()
    this.rsuPositions = deployment.intersections
    this.regions = [
      { id: 1, name: deployment.regionNames[0], latitude: deployment.regionLats[0], rsuCount: deployment.regionCounts[0] },
      { id: 2, name: deployment.regionNames[1], latitude: deployment.regionLats[1], rsuCount: deployment.regionCounts[1] },
      { id: 3, name: deployment.regionNames[2], latitude: deployment.regionLats[2], rsuCount: deployment.regionCounts[2] },
    ]
    this.totalRSU = deployment.totalRSU

    this.regionCounts = [0, 0, 0]
    this.probRoute = [1 / 3, 1 / 3, 1 / 3] // 初始均匀分布
    this.cacheDecision = null                // 450 元素布尔数组
    this.psi = null                          // 概率分布
    this.chr = {
      regions: [0, 0, 0],
      routeHitRates: new Array(ROUTE_DEFS.length).fill(0),
      routeVehicleCounts: new Array(ROUTE_DEFS.length).fill(0),
      routeTotalChunks: new Array(ROUTE_DEFS.length).fill(0),
      total: 0,
      algorithmResults: null,
    }
    this.lastMatlabRun = null
    this.matlabRunning = false
    this.matlabError = null
    this.broadcastTimer = null
    this.matlabTimer = null
    this.vehicleCount = 0

    // 块（Chunk）模型状态
    this.chunksPerRSU = []                // 每个 RSU 存储的数据块数（系统总块数 = vehicleCount × CHUNKS_PER_VEHICLE）
    this.rsuChunks = []                   // rsuChunks[i] = Set<tileId> — 每个 RSU 存储的具体瓦片 ID 集合
    this.vehicleChunkState = new Map()    // vehicleId → { visitedRSUs: Set<index>, collectedTiles: Set<tileId>, totalChunks: number, currentRegion: number, routeId: number }

    // 确保 data 目录存在
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
  }

  /**
   * 每 tick 被 SimulationService 调用
   */
  onVehicleTick(vehicles) {
    this.vehicleCount = vehicles.length
    this.updateRegionCounts(vehicles)
    this.updateProbRoute()
    this.trackVehicleChunks(vehicles)
    this.computeHitRate()
  }

  /**
   * 更新各区域的车辆计数
   */
  updateRegionCounts(vehicles) {
    this.regionCounts = [0, 0, 0]
    for (const v of vehicles) {
      if (v.completed) continue
      for (let r = 0; r < this.regions.length; r++) {
        if (Math.abs(v.latitude - this.regions[r].latitude) < REGION_TOLERANCE) {
          this.regionCounts[r]++
        }
      }
    }
  }

  /**
   * 从车辆计数计算 Prob_Route（与 exportVehicleData.mjs 算法一致）
   */
  updateProbRoute() {
    const maxCount = Math.max(...this.regionCounts, 1)
    this.probRoute = this.regionCounts.map(c => 0.5 + (c / maxCount) * 0.45)
  }

  /**
   * 基于块（Chunk）模型的命中率计算
   *
   * 每辆车需要收集 CHUNKS_PER_VEHICLE 个数据块，
   * 命中完成率 = 车辆收集的块数 / CHUNKS_PER_VEHICLE
   * 路线命中完成率 = 路线所有车辆收集块数之和 / (路线车辆数 × CHUNKS_PER_VEHICLE)
   */
  computeHitRate() {
    if (this.vehicleChunkState.size === 0) {
      this.chr.regions = [0, 0, 0]
      this.chr.routeHitRates = new Array(ROUTE_DEFS.length).fill(0)
      this.chr.routeVehicleCounts = new Array(ROUTE_DEFS.length).fill(0)
      this.chr.total = 0
      return
    }

    const routeChunksSum = new Array(ROUTE_DEFS.length).fill(0)
    const routeVehicleCount = new Array(ROUTE_DEFS.length).fill(0)
    let totalChunksSum = 0

    for (const state of this.vehicleChunkState.values()) {
      totalChunksSum += state.totalChunks
      if (state.routeId >= 1 && state.routeId <= ROUTE_DEFS.length) {
        routeChunksSum[state.routeId - 1] += state.totalChunks
        routeVehicleCount[state.routeId - 1]++
      }
    }

    // 总命中率 = 所有车辆收集块数之和 / (车辆数 × CHUNKS_PER_VEHICLE)
    this.chr.total = totalChunksSum / (this.vehicleChunkState.size * CHUNKS_PER_VEHICLE)
    // 路线命中率 = 该路线车辆收集块数之和 / (该路线车辆数 × CHUNKS_PER_VEHICLE)
    this.chr.routeHitRates = routeChunksSum.map((sum, i) =>
      routeVehicleCount[i] > 0 ? sum / (routeVehicleCount[i] * CHUNKS_PER_VEHICLE) : 0
    )
    this.chr.routeVehicleCounts = routeVehicleCount
    this.chr.routeTotalChunks = routeChunksSum // 各路线总收集块数（用于前端展示命中总数）
  }

  /**
   * 将物理 RSU 索引映射到 psi/cacheDecision 数组索引
   *
   * 物理 RSU 按区域连续排列（region 1 → region 2 → region 3），
   * 但 psi 数组中每个区域固定占 X 个位置（X=150）。
   * 物理 RSU 只占每个区域前 N_r 个位置（N_r = 该区域 RSU 数）。
   *
   * 映射: psiIndex = region × X + offsetInRegion
   */
  rsuIndexToPsiIndex(rsuIdx) {
    const X = ALGO_PARAMS.X
    let cumCount = 0
    for (let r = 0; r < this.regions.length; r++) {
      const count = this.regions[r].rsuCount
      if (rsuIdx < cumCount + count) {
        return r * X + (rsuIdx - cumCount)
      }
      cumCount += count
    }
    return -1
  }

  /**
   * 按 psi 权重从 450 个瓦片中不放回抽样 count 个瓦片 ID
   * @param {number} count — 需要抽样的瓦片数
   * @param {number[]} weights — psi 权重数组（长度 450）
   * @returns {Set<number>} 抽中的瓦片 ID 集合
   */
  _weightedSampleTileIds(count, weights) {
    const result = new Set()
    if (count <= 0 || !weights || weights.length === 0) return result

    const K = weights.length
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    if (totalWeight <= 0) return result

    // 不放回抽样：每次按权重比例随机选取一个，已选中的不再重复
    const probs = weights.map(w => w / totalWeight)
    const maxAttempts = count * 10
    let attempts = 0

    while (result.size < count && attempts < maxAttempts) {
      const r = Math.random()
      let cum = 0
      for (let i = 0; i < K; i++) {
        cum += probs[i]
        if (r < cum) {
          result.add(i)
          break
        }
      }
      attempts++
    }

    return result
  }

  /**
   * 将 (车辆数 × CHUNKS_PER_VEHICLE) 个数据块按 psi 权重分配到被缓存的 RSU 上
   * 每辆车沿途从 RSU 下载数据块，系统总块数 = vehicleCount × CHUNKS_PER_VEHICLE
   * 每次 cacheDecision/psi 更新后调用
   */
  computeChunksDistribution() {
    if (!this.cacheDecision || !this.psi || this.rsuPositions.length === 0) {
      this.chunksPerRSU = new Array(this.rsuPositions.length).fill(0)
      return
    }

    // 系统总数据块数 = 当前车辆数 × 每辆车请求的块数
    const totalSystemChunks = Math.max(this.vehicleCount, 1) * CHUNKS_PER_VEHICLE

    // 遍历物理 RSU，通过索引映射找到对应的 psi 值
    const N = this.rsuPositions.length
    let totalCachedPsi = 0
    const cachedPsiValues = new Array(N).fill(0)

    for (let i = 0; i < N; i++) {
      const psiIdx = this.rsuIndexToPsiIndex(i)
      if (psiIdx >= 0 && this.cacheDecision[psiIdx]) {
        const p = this.psi[psiIdx] || 0
        cachedPsiValues[i] = p
        totalCachedPsi += p
      }
    }

    if (totalCachedPsi <= 0) {
      this.chunksPerRSU = new Array(N).fill(0)
      console.log('[Caching] 块分布: 无可缓存的 RSU')
      return
    }

    // 按 psi 权重分配（向下取整）
    const chunks = new Array(N).fill(0)
    for (let i = 0; i < N; i++) {
      if (cachedPsiValues[i] > 0) {
        chunks[i] = Math.floor(totalSystemChunks * cachedPsiValues[i] / totalCachedPsi)
      }
    }

    // 将剩余块分配给小数部分最大的 RSU
    let remaining = totalSystemChunks - chunks.reduce((a, b) => a + b, 0)
    if (remaining > 0) {
      const remainders = []
      for (let i = 0; i < N; i++) {
        if (cachedPsiValues[i] > 0) {
          const exact = totalSystemChunks * cachedPsiValues[i] / totalCachedPsi
          remainders.push({ idx: i, rem: exact - Math.floor(exact) })
        }
      }
      remainders.sort((a, b) => b.rem - a.rem)

      for (let i = 0; i < Math.min(remaining, remainders.length); i++) {
        chunks[remainders[i].idx]++
      }
    }

    this.chunksPerRSU = chunks
    const assigned = chunks.reduce((a, b) => a + b, 0)
    const activeRSUs = chunks.filter(c => c > 0).length

    // 为每个 RSU 分配具体的瓦片 ID（按 psi 权重抽样）
    this.rsuChunks = new Array(N).fill(null).map(() => new Set())
    for (let i = 0; i < N; i++) {
      if (chunks[i] > 0 && cachedPsiValues[i] > 0) {
        const tiles = this._weightedSampleTileIds(chunks[i], this.psi)
        this.rsuChunks[i] = tiles
      }
    }

    console.log(`[Caching] 块分布完成: ${assigned} 个块分配到 ${activeRSUs} 个 RSU (${this.vehicleCount}辆车 × ${CHUNKS_PER_VEHICLE}块/车)`)
  }

  /**
   * 查找车辆附近的 RSU 索引
   * @returns {number} RSU 索引（无匹配返回 -1）
   */
  findNearbyRSU(lat, lng) {
    let closestIdx = -1
    let closestDist = RSU_PROXIMITY_M

    for (let i = 0; i < this.rsuPositions.length; i++) {
      const rsu = this.rsuPositions[i]
      const dist = haversineDist(lat, lng, rsu.latitude, rsu.longitude)
      if (dist < closestDist) {
        closestDist = dist
        closestIdx = i
      }
    }

    return closestIdx
  }

  /**
   * 追踪每辆车的 RSU 访问和块收集情况
   */
  trackVehicleChunks(vehicles) {
    // 为新车辆初始化状态
    for (const v of vehicles) {
      if (!v.completed && !this.vehicleChunkState.has(v.id)) {
        this.vehicleChunkState.set(v.id, {
          visitedRSUs: new Set(),
          collectedTiles: new Set(),
          totalChunks: 0,
          currentRegion: -1,
          routeId: v.routeId || -1,
        })
      }
    }

    // 检查每辆车的 RSU 访问
    for (const v of vehicles) {
      if (v.completed) continue
      const state = this.vehicleChunkState.get(v.id)
      if (!state) continue

      // 更新当前所在区域
      for (let r = 0; r < this.regions.length; r++) {
        if (Math.abs(v.latitude - this.regions[r].latitude) < REGION_TOLERANCE) {
          state.currentRegion = r
          break
        }
      }

      // 检查是否经过新的 RSU
      const rsuIdx = this.findNearbyRSU(v.latitude, v.longitude)
      if (rsuIdx !== -1 && this.chunksPerRSU[rsuIdx] > 0 && !state.visitedRSUs.has(rsuIdx)) {
        state.visitedRSUs.add(rsuIdx)

        // 收集该 RSU 存储的具体瓦片 ID（去重）
        const tiles = this.rsuChunks[rsuIdx]
        if (tiles) {
          for (const tileId of tiles) {
            state.collectedTiles.add(tileId)
          }
        }
        state.totalChunks = Math.min(CHUNKS_PER_VEHICLE, state.collectedTiles.size)
      }
    }

    // 清理已从数组中移除的车辆（保留已完成的车辆，其缓存数据继续参与统计）
    const activeIds = new Set(vehicles.map(v => v.id))
    for (const id of this.vehicleChunkState.keys()) {
      if (!activeIds.has(id)) {
        this.vehicleChunkState.delete(id)
      }
    }
  }

  /**
   * 在 MATLAB 重算后，根据新的 chunksPerRSU 重新计算各车的块数
   * （保留 visitedRSUs 避免归零）
   */
  recalculateVehicleChunks() {
    for (const state of this.vehicleChunkState.values()) {
      state.collectedTiles.clear()
      for (const rsuIdx of state.visitedRSUs) {
        const tiles = this.rsuChunks[rsuIdx]
        if (tiles) {
          for (const tileId of tiles) {
            state.collectedTiles.add(tileId)
          }
        }
      }
      state.totalChunks = Math.min(CHUNKS_PER_VEHICLE, state.collectedTiles.size)
    }
    console.log(`[Caching] 已重新计算 ${this.vehicleChunkState.size} 辆车的块总数`)
  }

  /**
   * 确保每个区域至少有一个 RSU 被缓存
   * 避免 MATLAB 算法将某个区域完全排除导致该区域路线命中率始终为 0
   */
  _ensureMinCachePerRegion() {
    if (!this.cacheDecision || !this.psi) return
    const X = ALGO_PARAMS.X
    let patched = false

    for (let r = 0; r < this.regions.length; r++) {
      const regionCount = this.regions[r].rsuCount
      const psiStart = r * X

      // 检查该区域是否有被缓存的 RSU
      let hasCached = false
      for (let j = 0; j < regionCount; j++) {
        if (this.cacheDecision[psiStart + j]) {
          hasCached = true
          break
        }
      }

      // 如果没有，启用该区域 psi 值最大的 RSU
      if (!hasCached && regionCount > 0) {
        let bestIdx = psiStart
        let bestPsi = this.psi[psiStart] || 0
        for (let j = 1; j < regionCount; j++) {
          const p = this.psi[psiStart + j] || 0
          if (p > bestPsi) {
            bestPsi = p
            bestIdx = psiStart + j
          }
        }
        this.cacheDecision[bestIdx] = true
        patched = true
        console.log(`[Caching] 区域 ${r + 1} (${this.regions[r].name}) 无缓存 RSU，已启用索引 ${bestIdx} (psi=${bestPsi.toFixed(4)})`)
      }
    }

    if (patched) {
      console.log('[Caching] 已补充区域内最少缓存 RSU，确保所有路线均有缓存数据')
    }
  }

  /**
   * 从 MATLAB 输出的 cache_decision.json 加载结果
   */
  loadResults() {
    const filePath = path.join(DATA_DIR, 'cache_decision.json')
    try {
      if (!fs.existsSync(filePath)) {
        console.log('[Caching] cache_decision.json 不存在，跳过加载')
        return false
      }
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw)

      // 转换 CacheDecision 为布尔数组
      if (data.CacheDecision && Array.isArray(data.CacheDecision)) {
        this.cacheDecision = data.CacheDecision.map(v => v === 1)
      }
      if (data.psi && Array.isArray(data.psi)) {
        this.psi = data.psi
      }

      // 确保每个区域至少有一个 RSU 被缓存，避免整条路线命中率为 0
      this._ensureMinCachePerRegion()

      // 基于新 cacheDecision/psi 重新计算块分布
      this.computeChunksDistribution()
      this.recalculateVehicleChunks()

      // 对比算法结果（来自 MATLAB 的概率公式计算，仅供参考）
      if (data.Algorithm_Comparison) {
        this.chr.algorithmResults = data.Algorithm_Comparison
      }

      // 注意: 不再使用 MATLAB 的 CHR_RSU / CHR_Total,
      //       改用 JS 端基于块（Chunk）模型的实时计算

      this.lastMatlabRun = data.timestamp || new Date().toISOString()
      this.matlabError = null
      console.log(`[Caching] 已加载 MATLAB 结果，总命中率: ${this.chr.total.toFixed(4)}`)
      return true
    } catch (err) {
      console.error(`[Caching] 加载结果失败: ${err.message}`)
      return false
    }
  }

  /**
   * 导出车辆数据并触发 MATLAB 重算
   */
  async triggerMatlab() {
    if (this.matlabRunning) {
      console.log('[Caching] MATLAB 正在运行中，跳过本次触发')
      return
    }

    this.matlabRunning = true
    this.matlabError = null
    console.log('[Caching] 触发 MATLAB 重算...')

    try {
      // 1. 写入输入 JSON
      const input = this.buildMatlabInput()
      const inputPath = path.join(DATA_DIR, '_vehicle_input.json')
      fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), 'utf-8')

      // 2. 启动 MATLAB
      const result = await this.runMatlabProcess()

      if (result.success) {
        // 3. 加载结果
        this.loadResults()
      } else {
        this.matlabError = result.error
        console.error(`[Caching] MATLAB 运行失败: ${result.error}`)
      }
    } catch (err) {
      this.matlabError = err.message
      console.error(`[Caching] MATLAB 异常: ${err.message}`)
    } finally {
      this.matlabRunning = false
    }
  }

  /**
   * 构建 MATLAB 输入数据
   */
  buildMatlabInput() {
    return {
      Prob_Route: this.probRoute,
      algorithmParams: {
        ...ALGO_PARAMS,
        totalRSU: this.totalRSU,
        RSU_per_region: this.regions.map(r => r.rsuCount),
        regionLats: this.regions.map(r => r.latitude),
      },
      regionCounts: this.regionCounts,
      vehicleCount: this.vehicleCount,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * 执行 MATLAB 子进程
   */
  runMatlabProcess() {
    return new Promise((resolve) => {
      const scriptName = 'HM_Export_CacheDecision'
      const matlabDir = path.resolve(__dirname, '../../../../5.10')

      console.log(`[Caching] 启动 MATLAB: ${scriptName} (目录: ${matlabDir})`)

      const child = spawn('matlab', [
        '-batch',
        scriptName,
        '-sd', matlabDir,  // 设置工作目录
      ], {
        cwd: matlabDir,
        timeout: 120000, // 2 分钟超时
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          // 查找输出中的关键行
          const hitRateMatch = stdout.match(/MWC 总命中率: ([\d.]+)/)
          if (hitRateMatch) {
            console.log(`[Caching] MATLAB 完成，MWC 命中率: ${hitRateMatch[1]}`)
          }
          resolve({ success: true, stdout, stderr })
        } else {
          resolve({
            success: false,
            error: `MATLAB 退出码 ${code}: ${stderr || stdout.slice(-200)}`,
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, error: err.message })
      })
    })
  }

  /**
   * 获取当前 RSU 数据（供 WebSocket 广播和 API 使用）
   */
  getCurrentData() {
    // 收集每辆车的瓦片收集信息
    const vehicleTiles = {}
    for (const [vid, state] of this.vehicleChunkState) {
      vehicleTiles[vid] = {
        collectedCount: state.totalChunks,
        tileIds: Array.from(state.collectedTiles),
      }
    }

    return {
      rsus: this.rsuPositions.map(rsu => ({
        ...rsu,
        hitRate: this.chr.regions[rsu.region - 1] || 0,
      })),
      regions: this.regions.map((r, i) => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude,
        hitRate: this.chr.regions[i] || 0,
        probRoute: this.probRoute[i],
        vehicleCount: this.regionCounts[i],
      })),
      routes: ROUTE_DEFS.map((r, i) => ({
        id: r.id,
        name: r.name,
        hitRate: this.chr.routeHitRates?.[i] || 0,
        vehicleCount: this.chr.routeVehicleCounts?.[i] || 0,
        totalChunks: this.chr.routeTotalChunks?.[i] || 0,
      })),
      totalHitRate: this.chr.total,
      algorithmResults: this.chr.algorithmResults,
      matlabRunning: this.matlabRunning,
      matlabError: this.matlabError,
      lastMatlabRun: this.lastMatlabRun,
      // 瓦片（Tile）模型数据
      rsuChunks: this.rsuChunks.map(s => Array.from(s)),   // 各 RSU 存储的瓦片 ID 列表
      vehicleTiles,                                         // 各车辆收集的瓦片信息
      tileStats: {
        totalTiles: this.psi ? this.psi.length : 0,        // 系统总瓦片数（450）
        totalCopies: this.chunksPerRSU.reduce((a, b) => a + b, 0),  // 已分配副本数
        activeRSUs: this.chunksPerRSU.filter(c => c > 0).length,    // 活跃 RSU 数
      },
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * 启动周期性广播（每 5 秒）
   */
  startBroadcast(intervalMs = 5000) {
    if (this.broadcastTimer) return
    console.log(`[Caching] 启动 RSU 数据广播 (每 ${intervalMs}ms)`)

    // 立即广播一次
    this.io.emit('rsu:update', this.getCurrentData())

    this.broadcastTimer = setInterval(() => {
      this.io.emit('rsu:update', this.getCurrentData())
    }, intervalMs)
  }

  /**
   * 启动周期性 MATLAB 重算（每 60 秒）
   */
  startMatlabLoop(intervalMs = 60000) {
    if (this.matlabTimer) return
    console.log(`[Caching] 启动 MATLAB 周期重算 (每 ${intervalMs}ms)`)

    // 尝试立即加载已有结果
    const loaded = this.loadResults()

    // 首次运行（如果没有缓存结果）
    if (!loaded) {
      this.triggerMatlab()
    }

    this.matlabTimer = setInterval(() => {
      this.triggerMatlab()
    }, intervalMs)
  }

  /**
   * 重置块收集状态（模拟重置时调用）
   */
  reset() {
    this.vehicleChunkState.clear()
    this.rsuChunks = []
  }

  /**
   * 停止所有定时器
   */
  stop() {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
    if (this.matlabTimer) {
      clearInterval(this.matlabTimer)
      this.matlabTimer = null
    }
    console.log('[Caching] 已停止')
  }
}
