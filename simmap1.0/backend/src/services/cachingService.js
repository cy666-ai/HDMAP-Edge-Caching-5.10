/**
 * CachingService - RSU 缓存命中率实时计算服务 (v5.10)
 *
 * 职责:
 * 1. 按路线（6条）管理 RSU 数据和车辆分布
 * 2. 每 5 个时间片触发 Python 执行 MWC 算法（每条路线单独计算）
 * 3. 加载 Python 输出的每路线 CacheDecision（各 RSU 缓存哪些内容块）
 * 4. 每当车辆进入 RSU 覆盖范围时，对比 RSU 缓存内容与车辆需求计算命中率
 * 5. 通过 WebSocket 广播 RSU 数据和命中率
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
  alpha: 0.055,
  Capacity_Scale: 2.0,
  allowed_layers_per_block: [3, 4, 4],
  layer_profit_ranges: {
    Raw: [25, 35],
    Geo: [15, 25],
    Sem: [8, 15],
    Dyn: [-5, 5],
  },
}

// 每 RSU 的内容块数（每条路线每个 RSU 管理 X 个内容块）
const CHUNKS_PER_RSU = 100

// 车辆-RSU 近距离匹配阈值（米）
const RSU_PROXIMITY_M = 300

// 算法重算间隔（时间片数）
const ALGO_INTERVAL_TICKS = 5

// 6 条车辆路线定义
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

    // 动态加载 RSU 部署数据（每个 RSU 已有 routeId 字段）
    const deployment = computeRSUDeployment()
    this.rsuPositions = deployment.intersections

    // ========== 6 条路线数据模型 ==========
    // 每条路线维护自己的 RSU 列表和缓存决策
    this.routeData = {}
    for (const def of ROUTE_DEFS) {
      this.routeData[def.id] = {
        routeId: def.id,
        name: def.name,
        rsus: [],           // 该路线的 RSU 列表
        E: 0,               // RSU 数量
        X: CHUNKS_PER_RSU,  // 每 RSU 内容块数
        vehicleCount: 0,    // 当前该路线的车辆数
        cacheDecision: null, // MWC 输出的布尔数组（长度 = E × X）
        psi: null,           // 概率分布
        cachedCount: 0,      // 该路线所有 RSU 缓存的内容块总数
        maxTiles: 0,         // 该路线总内容块数（E × X）
        hitRate: 0,          // 该路线命中率
      }
    }

    // 按 routeId 将 RSU 分配到各路线
    for (const rsu of this.rsuPositions) {
      const rd = this.routeData[rsu.routeId]
      if (rd) {
        rd.rsus.push(rsu)
        rd.E++
        rd.maxTiles = rd.E * rd.X
      }
    }

    console.log(`[Caching] 已加载 ${this.rsuPositions.length} 个 RSU，按路线分布:`)
    for (const rd of Object.values(this.routeData)) {
      if (rd.E > 0) console.log(`  路线 ${rd.routeId} ${rd.name}: ${rd.E} 个 RSU, ${rd.maxTiles} 个内容块`)
    }

    // ========== 运行时状态 ==========
    this.tickCount = 0
    this.vehicleCount = 0
    this.totalHitRate = 0

    // 每辆车的 tile 收集状态
    // vehicleId → { visitedRSUs: Set<rsuIndex>, collectedTiles: Set<tileId>, routeId: number }
    this.vehicleTileState = new Map()

    this.lastAlgorithmRun = null
    this.algorithmRunning = false
    this.algorithmError = null
    this.broadcastTimer = null
    this.matlabTimer = null

    // 确保 data 目录存在
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
  }

  // ==================== 每 Tick 调用 ====================

  /**
   * 每 tick 被 SimulationService 调用
   * @param {Array} vehicles - 当前所有车辆
   * @param {number} tickCount - 当前时间片编号
   */
  onVehicleTick(vehicles, tickCount) {
    this.tickCount = tickCount
    this.vehicleCount = vehicles.length

    this.updateRouteCounts(vehicles)
    this.trackVehicleTiles(vehicles)
    this.computeHitRate()

    // 每 ALGO_INTERVAL_TICKS 个时间片触发一次算法重算
    if (this.tickCount % ALGO_INTERVAL_TICKS === 0 && this.tickCount > 0) {
      this.triggerAlgorithm()
    }
  }

  // ==================== 车辆统计 ====================

  /**
   * 统计每条路线上的车辆数（仅统计未完成的车辆）
   */
  updateRouteCounts(vehicles) {
    // 重置计数
    for (const rd of Object.values(this.routeData)) {
      rd.vehicleCount = 0
    }
    // 按 routeId 统计
    for (const v of vehicles) {
      if (v.completed) continue
      const rd = this.routeData[v.routeId]
      if (rd) rd.vehicleCount++
    }
  }

  // ==================== Tile 采集跟踪（命中率核心） ====================

  /**
   * 跟踪每辆车经过 RSU 时采集的内容块
   *
   * 核心逻辑：
   *   车辆进入 RSU 覆盖范围（≤ RSU_PROXIMITY_M）→ 标记该 RSU 已访问
   *   → 从该 RSU 的缓存决策（MWC 结果）中获取内容块 → 加入车辆的收集集合
   *
   * 命中率 = 车辆收集到的内容块数 / 该路线总内容块数
   */
  trackVehicleTiles(vehicles) {
    // 为新车辆初始化状态
    for (const v of vehicles) {
      if (!v.completed && !this.vehicleTileState.has(v.id)) {
        const rd = this.routeData[v.routeId]
        if (!rd) continue
        this.vehicleTileState.set(v.id, {
          visitedRSUs: new Set(),
          collectedTiles: new Set(),
          routeId: v.routeId,
          requestedBlocks: new Set(v.requestedBlocks || []),
          aheadRsuIds: v.routeRsuIds || [],           // 该车将要途经的RSU ID（已过滤掉后方RSU）
        })
      }
    }

    // 检查每辆车是否经过新的 RSU
    for (const v of vehicles) {
      if (v.completed) continue
      const state = this.vehicleTileState.get(v.id)
      if (!state) continue

      const rd = this.routeData[state.routeId]
      if (!rd || rd.rsus.length === 0 || !rd.cacheDecision) continue

      // 遍历该路线的所有 RSU，检查车辆是否进入覆盖范围
      for (let rsuIdx = 0; rsuIdx < rd.rsus.length; rsuIdx++) {
        if (state.visitedRSUs.has(rsuIdx)) continue

        const rsu = rd.rsus[rsuIdx]
        const dist = haversineDist(v.latitude, v.longitude, rsu.latitude, rsu.longitude)

        if (dist < RSU_PROXIMITY_M) {
          state.visitedRSUs.add(rsuIdx)

          // 命中块 = 车辆申请的内容块 ∩ RSU缓存的内容块
          // 块号按 RSU 全局标号计算: (rsu.id - 1) * X + offset + 1
          const cacheDec = rd.cacheDecision
          const X = rd.X
          const startIdx = rsuIdx * X
          const endIdx = Math.min(startIdx + X, cacheDec.length)

          for (let offset = 0; offset < endIdx - startIdx; offset++) {
            const cacheIdx = startIdx + offset
            if (cacheDec[cacheIdx]) {
              const blockNumber = (rsu.id - 1) * X + offset + 1
              if (state.requestedBlocks.has(blockNumber)) {
                state.collectedTiles.add(blockNumber)
              }
            }
          }
        }
      }
    }

    // 清理已移除的车辆
    const activeIds = new Set(vehicles.map(v => v.id))
    for (const id of this.vehicleTileState.keys()) {
      if (!activeIds.has(id)) {
        this.vehicleTileState.delete(id)
      }
    }
  }

  /**
   * 在 MATLAB 重算后，根据新的 cacheDecision 重新计算各车的采集块
   * （保留 visitedRSUs 避免车辆重复访问，只更新块内容）
   */
  recalculateVehicleTiles() {
    for (const state of this.vehicleTileState.values()) {
      state.collectedTiles.clear()
      const rd = this.routeData[state.routeId]
      if (!rd || !rd.cacheDecision) continue

      const X = rd.X
      for (const rsuIdx of state.visitedRSUs) {
        const rsu = rd.rsus[rsuIdx]
        if (!rsu) continue
        const startIdx = rsuIdx * X
        const endIdx = Math.min(startIdx + X, rd.cacheDecision.length)
        for (let offset = 0; offset < endIdx - startIdx; offset++) {
          const cacheIdx = startIdx + offset
          // 块号按 RSU 全局标号计算: (rsu.id - 1) * X + offset + 1
          if (rd.cacheDecision[cacheIdx]) {
            const blockNumber = (rsu.id - 1) * X + offset + 1
            if (state.requestedBlocks.has(blockNumber)) {
              state.collectedTiles.add(blockNumber)
            }
          }
        }
      }
    }
    console.log(`[Caching] 已重新计算 ${this.vehicleTileState.size} 辆车的命中块状态`)
  }

  // ==================== 命中率计算 ====================

  /**
   * 计算每条路线的缓存命中率
   *
   * 路线命中率 = 该路线所有车辆已收集的瓦片总数 /
   *              路线上每一辆车申请的总内容块数量之和
   * 其中每辆车申请的内容块数量 = 该车将要经过的RSU数量 × RSU容量上限(100)
   * 系统总命中率 = 所有路线命中率的车辆数加权平均
   */
  computeHitRate() {
    let totalWeighted = 0
    let totalVehicles = 0

    for (const rd of Object.values(this.routeData)) {
      if (rd.E === 0) {
        rd.hitRate = 0
        continue
      }

      let routeCollectedSum = 0
      let routeRequestedSum = 0
      let vehicleCountOnRoute = 0

      for (const state of this.vehicleTileState.values()) {
        if (state.routeId !== rd.routeId) continue
        routeCollectedSum += state.collectedTiles.size
        routeRequestedSum += state.requestedBlocks.size
        vehicleCountOnRoute++
      }

      rd.hitRate = routeRequestedSum > 0
        ? routeCollectedSum / routeRequestedSum
        : 0

      totalWeighted += rd.hitRate * vehicleCountOnRoute
      totalVehicles += vehicleCountOnRoute
    }

    // 总命中率 = 加权平均
    this.totalHitRate = totalVehicles > 0 ? totalWeighted / totalVehicles : 0
  }

  // ==================== 算法触发（Python） ====================

  /**
   * 构建算法输入数据（每条路线独立参数）
   */
  buildAlgorithmInput() {
    return {
      algorithmParams: { ...ALGO_PARAMS },
      routes: Object.values(this.routeData)
        .filter(r => r.E > 0)
        .map(r => ({
          routeId: r.routeId,
          routeName: r.name,
          E: r.E,
          X: r.X,
          vehicleCount: r.vehicleCount,
        })),
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * 触发 Python 算法重算
   */
  async triggerAlgorithm() {
    if (this.algorithmRunning) {
      console.log(`[Caching] 算法正在运行中，跳过本次触发 (tick=${this.tickCount})`)
      return
    }

    this.algorithmRunning = true
    this.algorithmError = null
    console.log(`[Caching] 触发 Python 算法重算 (tick=${this.tickCount})...`)

    try {
      // 1. 写入输入 JSON
      const input = this.buildAlgorithmInput()
      const inputPath = path.join(DATA_DIR, '_vehicle_input.json')
      fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), 'utf-8')

      // 2. 记录各路线输入的 E 和 X（用于后续验证）
      const routeParams = {}
      for (const r of input.routes) {
        routeParams[r.routeId] = { E: r.E, X: r.X }
      }
      this._lastInputRouteParams = routeParams

      // 3. 启动 Python 算法
      const result = await this.runAlgorithmProcess()

      if (result.success) {
        // 4. 加载结果
        const loaded = this.loadResults()
        if (loaded) {
          // 5. 使用新缓存决策重新计算所有车辆的采集状态
          this.recalculateVehicleTiles()
          this.computeHitRate()
        }
      } else {
        this.algorithmError = result.error
        console.error(`[Caching] 算法运行失败: ${result.error}`)
      }
    } catch (err) {
      this.algorithmError = err.message
      console.error(`[Caching] 算法异常: ${err.message}`)
    } finally {
      this.algorithmRunning = false
    }
  }

  /**
   * 执行 Python 算法子进程
   */
  runAlgorithmProcess() {
    return new Promise((resolve) => {
      const scriptPath = path.resolve(__dirname, '../../../../algorithm/hm_export_cache_decision.py')
      const algoDir = path.resolve(__dirname, '../../../../algorithm')

      console.log(`[Caching] 启动 Python 算法: ${scriptPath}`)

      const child = spawn('python', [
        scriptPath,
      ], {
        cwd: algoDir,
        timeout: 120000,
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
          // 输出各路线结果摘要
          const routeMatches = stdout.matchAll(/路线 (\d+): E=(\d+), X=(\d+), .*?缓存块数:\s*(\d+)\/(\d+)/g)
          for (const m of routeMatches) {
            console.log(`[Caching] 路线 ${m[1]}: ${m[4]}/${m[5]} 块缓存`)
          }
          resolve({ success: true, stdout, stderr })
        } else {
          resolve({
            success: false,
            error: `Python 算法退出码 ${code}: ${stderr || stdout.slice(-200)}`,
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, error: err.message })
      })
    })
  }

  // ==================== 加载算法结果 ====================

  /**
   * 从算法输出的 cache_decision.json 加载每路线的缓存决策
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

      if (!data.routes || !Array.isArray(data.routes)) {
        console.log('[Caching] cache_decision.json 无 routes 字段')
        return false
      }

      let loadedCount = 0
      for (const routeResult of data.routes) {
        const rd = this.routeData[routeResult.routeId]
        if (!rd) {
          console.warn(`[Caching] 未知路线 ID: ${routeResult.routeId}`)
          continue
        }

        // 将 CacheDecision 转为布尔数组
        if (routeResult.CacheDecision && Array.isArray(routeResult.CacheDecision)) {
          rd.cacheDecision = routeResult.CacheDecision.map(v => v === 1)
        }
        if (routeResult.psi && Array.isArray(routeResult.psi)) {
          rd.psi = routeResult.psi
        }

        rd.cachedCount = routeResult.Total_Cached_Tiles || 0
        rd.maxTiles = (routeResult.E || rd.E) * (routeResult.X || rd.X)

        loadedCount++
        console.log(`[Caching] 路线 ${rd.routeId} (${rd.name}): ${rd.cachedCount}/${rd.maxTiles} 块缓存, ${rd.E} 个 RSU`)
      }

      this.lastAlgorithmRun = data.timestamp || new Date().toISOString()
      this.algorithmError = null
      console.log(`[Caching] 已加载 ${loadedCount} 条路线的算法结果`)
      return loadedCount > 0
    } catch (err) {
      console.error(`[Caching] 加载结果失败: ${err.message}`)
      return false
    }
  }

  /**
   * 获取指定车辆尚未途经的 RSU ID 列表（供 simulationService 的 vehicle:update 使用）
   * @param {number} vehicleId
   * @returns {number[]}
   */
  getUpcomingRsuIds(vehicleId) {
    const state = this.vehicleTileState.get(vehicleId)
    if (!state) return []
    const rd = this.routeData[state.routeId]
    if (!rd) return []
    const aheadSet = new Set(state.aheadRsuIds || [])
    return rd.rsus
      .map((rsu, idx) => ({ id: rsu.id, idx }))
      .filter(({ idx, id }) => !state.visitedRSUs.has(idx) && aheadSet.has(id))
      .map(({ id }) => id)
  }

  // ==================== WebSocket 广播 ====================

  /**
   * 获取各车辆命中的内容块信息（供 DataDisplay 使用）
   */
  _getVehicleTiles() {
    const result = {}
    for (const [vid, state] of this.vehicleTileState) {
      // 车辆尚未途经的 RSU ID 列表
      const rd = this.routeData[state.routeId]
      let upcomingRsuIds = []
      if (rd) {
        const aheadSet = new Set(state.aheadRsuIds || [])
        upcomingRsuIds = rd.rsus
          .map((rsu, idx) => ({ id: rsu.id, idx }))
          .filter(({ idx, id }) => !state.visitedRSUs.has(idx) && aheadSet.has(id))
          .map(({ id }) => id)
      }

      result[vid] = {
        collectedCount: state.collectedTiles.size,
        tileIds: Array.from(state.collectedTiles),
        upcomingRsuIds,
      }
    }
    return result
  }

  /**
   * 获取当前 RSU 数据（供 WebSocket 广播和 API 使用）
   */
  getCurrentData() {
    const routeData = Object.values(this.routeData)
      .filter(r => r.E > 0)
      .map(r => ({
        id: r.routeId,
        name: r.name,
        hitRate: r.hitRate,
        vehicleCount: r.vehicleCount,
        collectedTiles: this._getRouteCollectedCount(r.routeId),
        E: r.E,
        X: r.X,
      }))
    // 调试：打印广播的路线数据
    console.log(`[Caching] 广播 ${routeData.length} 条路线:`, routeData.map(r => `${r.name}: ${r.E}个RSU, ${r.vehicleCount}辆车, ${r.collectedTiles}命中块`).join(' | '))
    return {
      rsus: this.rsuPositions.map(rsu => {
        // 查找该 RSU 在其路线中的索引
        const rd = this.routeData[rsu.routeId]
        let cachedTiles = []
        if (rd?.cacheDecision && rd.E > 0) {
          const rsuIndex = rd.rsus.indexOf(rsu)
          if (rsuIndex >= 0) {
            const X = rd.X
            const startIdx = rsuIndex * X
            const endIdx = Math.min(startIdx + X, rd.cacheDecision.length)
            for (let offset = 0; offset < endIdx - startIdx; offset++) {
              if (rd.cacheDecision[startIdx + offset]) {
                cachedTiles.push((rsu.id - 1) * X + offset + 1)
              }
            }
          }
        }
        return {
          ...rsu,
          cachedTiles,         // 该 RSU 缓存的内容块 ID 列表（来自 MWC 决策）
          cacheEnabled: cachedTiles.length > 0,
        }
      }),
      // 各车辆采集的内容块信息（供前端 DataDisplay 选中车辆详情使用）
      vehicleTiles: this._getVehicleTiles(),
      routes: routeData,
      totalHitRate: this.totalHitRate,
      matlabRunning: this.algorithmRunning,    // 保持前端字段名兼容
      matlabError: this.algorithmError,        // 保持前端字段名兼容
      lastMatlabRun: this.lastAlgorithmRun,    // 保持前端字段名兼容
      tick: this.tickCount,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * 获取某路线车辆已命中的内容块总数（去重后）
   * 命中 = 车辆申请的内容块恰好被 RSU 缓存
   */
  _getRouteCollectedCount(routeId) {
    const seenTiles = new Set()
    for (const state of this.vehicleTileState.values()) {
      if (state.routeId === routeId) {
        for (const tileId of state.collectedTiles) {
          seenTiles.add(tileId)
        }
      }
    }
    return seenTiles.size
  }

  // ==================== 生命周期管理 ====================

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
   * 启动算法周期（首次加载/触发）
   * 后续由 onVehicleTick 的每 5 tick 自动触发
   */
  startAlgorithmLoop() {
    // 尝试立即加载已有结果
    const loaded = this.loadResults()

    // 首次运行（如果没有缓存结果）
    if (!loaded) {
      this.triggerAlgorithm()
    }
  }

  /**
   * 重置（模拟重置时调用）
   */
  reset() {
    this.vehicleTileState.clear()
    this.tickCount = 0
    this.totalHitRate = 0
    this.algorithmError = null
    for (const rd of Object.values(this.routeData)) {
      rd.vehicleCount = 0
      rd.hitRate = 0
    }
    console.log('[Caching] 已重置')
  }

  /**
   * 停止所有定时器
   */
  stop() {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
    console.log('[Caching] 已停止')
  }
}
