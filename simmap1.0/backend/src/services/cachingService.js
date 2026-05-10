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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')

// ============ 常量定义（与 5.10/RSU_Positions_Nanjing.txt 一致）============

// 9 个 RSU 部署位置（南京鼓楼区 6 条道路的 9 个交叉口）
const RSU_POSITIONS = [
  // 区域1 (北走廊)
  { id: 1,  latitude: 32.072,  longitude: 118.770022, name: '中山北路 & 新模范马路', region: 1 },
  { id: 4,  latitude: 32.072,  longitude: 118.781833, name: '中央路 & 新模范马路',   region: 1 },
  { id: 7,  latitude: 32.072,  longitude: 118.752,    name: '虎踞路 & 新模范马路',   region: 1 },
  // 区域2 (中走廊)
  { id: 2,  latitude: 32.058,  longitude: 118.768778, name: '中山北路 & 北京西路', region: 2 },
  { id: 5,  latitude: 32.058,  longitude: 118.781444, name: '中央路 & 北京西路',   region: 2 },
  { id: 8,  latitude: 32.058,  longitude: 118.752,    name: '虎踞路 & 北京西路',   region: 2 },
  // 区域3 (南走廊)
  { id: 3,  latitude: 32.046,  longitude: 118.767711, name: '中山北路 & 汉中路', region: 3 },
  { id: 6,  latitude: 32.046,  longitude: 118.781111, name: '中央路 & 汉中路',   region: 3 },
  { id: 9,  latitude: 32.046,  longitude: 118.752,    name: '虎踞路 & 汉中路',   region: 3 },
]

// 3 个横向走廊区域（基于道路交叉口纬度分组）
const REGIONS = [
  { id: 1, name: '北侧走廊（新模范马路）', latitude: 32.072, rsuIds: [1, 4, 7] },
  { id: 2, name: '中间走廊（北京西路）',   latitude: 32.058, rsuIds: [2, 5, 8] },
  { id: 3, name: '南侧走廊（汉中路）',     latitude: 32.046, rsuIds: [3, 6, 9] },
]

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
const REGION_TOLERANCE = 0.001

export class CachingService {
  constructor(io) {
    this.io = io
    this.regionCounts = [0, 0, 0]
    this.probRoute = [1 / 3, 1 / 3, 1 / 3] // 初始均匀分布
    this.cacheDecision = null                // 450 元素布尔数组
    this.psi = null                          // 概率分布
    this.chr = {
      regions: [0, 0, 0],
      total: 0,
      algorithmResults: null,
    }
    this.lastMatlabRun = null
    this.matlabRunning = false
    this.matlabError = null
    this.broadcastTimer = null
    this.matlabTimer = null
    this.vehicleCount = 0

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
    this.computeHitRate()
  }

  /**
   * 更新各区域的车辆计数
   */
  updateRegionCounts(vehicles) {
    this.regionCounts = [0, 0, 0]
    for (const v of vehicles) {
      if (v.completed) continue
      for (let r = 0; r < REGIONS.length; r++) {
        if (Math.abs(v.latitude - REGIONS[r].latitude) < REGION_TOLERANCE) {
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
   * 使用 MATLAB 输出的 CacheDecision + psi 和实时的 Prob_Route 计算命中率
   *
   * 公式 (与 MATLAB HM_Sim_Main_Nanjing.m 第 274-304 行一致):
   *   CHR_r = Σ(Cached[r,k] * ψ[r,k]) * Prob_Route[r] / (Σ(ψ[r,k]) * Prob_Route[r])
   *   CHR_total = Σ(Hit_RSU_r) / Σ(Request_Weighted_r)
   */
  computeHitRate() {
    if (!this.cacheDecision || !this.psi) {
      this.chr.regions = [0, 0, 0]
      this.chr.total = 0
      return
    }

    const X = ALGO_PARAMS.X
    let totalHit = 0
    let totalReq = 0

    for (let r = 0; r < REGIONS.length; r++) {
      const start = r * X
      const end = start + X - 1
      let baseReq = 0
      let hit = 0

      for (let k = start; k <= end; k++) {
        const p = this.psi[k] || 0
        baseReq += p
        if (this.cacheDecision[k]) {
          hit += p
        }
      }

      const reqWeighted = baseReq * this.probRoute[r]
      const hitWeighted = hit * this.probRoute[r]
      totalReq += reqWeighted
      totalHit += hitWeighted
      this.chr.regions[r] = reqWeighted > 0 ? hitWeighted / reqWeighted : 0
    }

    this.chr.total = totalReq > 0 ? totalHit / totalReq : 0
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
      if (data.CHR_RSU && Array.isArray(data.CHR_RSU)) {
        this.chr.regions = data.CHR_RSU
      }
      if (typeof data.CHR_Total === 'number') {
        this.chr.total = data.CHR_Total
      }
      if (data.Algorithm_Comparison) {
        this.chr.algorithmResults = data.Algorithm_Comparison
      }

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
      algorithmParams: ALGO_PARAMS,
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
    return {
      rsus: RSU_POSITIONS.map(rsu => ({
        ...rsu,
        hitRate: this.chr.regions[rsu.region - 1] || 0,
      })),
      regions: REGIONS.map((r, i) => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude,
        rsuIds: r.rsuIds,
        hitRate: this.chr.regions[i] || 0,
        probRoute: this.probRoute[i],
        vehicleCount: this.regionCounts[i],
      })),
      totalHitRate: this.chr.total,
      algorithmResults: this.chr.algorithmResults,
      matlabRunning: this.matlabRunning,
      matlabError: this.matlabError,
      lastMatlabRun: this.lastMatlabRun,
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
