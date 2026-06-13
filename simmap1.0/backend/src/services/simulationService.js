/**
 * 车辆行驶模拟服务
 *
 * 优先加载 data/roads.json 中的高德地图真实道路数据，
 * 文件不存在时回退到内置道路。
 *
 * Python 算法集成说明（v5.10）：
 * - CachingService 通过 child_process 直接调用 Python 算法
 * - Python脚本路径: ../../algorithm/hm_export_cache_decision.py
 * - 已移除 MATLAB 依赖，全部使用 Python (numpy/scipy/networkx) 计算
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadRouteCache, fetchAllAmapRoutes, saveRouteCache } from '../utils/amapRoute.js'
import { computeRSUDeployment } from '../utils/rsuDeployment.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_CACHE_FILE = path.resolve(__dirname, '../../data/route_paths.json')

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

/**
 * 计算路径数组中从起点到指定索引的累积距离（米）
 */
function computePathDistAt(path, pointIndex) {
  let dist = 0
  const end = Math.min(pointIndex, path.length - 1)
  for (let i = 0; i < end; i++) {
    dist += haversineDist(path[i].latitude, path[i].longitude, path[i + 1].latitude, path[i + 1].longitude)
  }
  return dist
}

export class SimulationService {
  constructor(io, routeConfig) {
    this.io = io
    this.timer = null
    this.running = false
    this.paused = false
    this.speedLevel = 5
    this.routeConfig = routeConfig || { routes: [], defaultVehicleCount: 5 }
    // 每条路线的目标车辆数，从 routeConfig 动态初始化
    this.routeVehicleCounts = Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, this.routeConfig.defaultVehicleCount || 5])
    )
    // 每条路线的独立速度（km/h），默认 35 km/h
    this.routeSpeeds = Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, 35])
    )
    this.tickCount = 0
    this.cachingService = null

    // 模拟参数（中心点: 南京鼓楼区）
    this.centerLat = 32.059000
    this.centerLng = 118.769000

    // 内置车辆配置
    this.vehicles = []
    this.vehiclePaths = []

    // 加载高德 API 缓存的路径数据（由 fetchVehicleRoutes.mjs 预生成）
    this.amapRoutePaths = loadRouteCache(ROUTE_CACHE_FILE)
    if (this.amapRoutePaths.size > 0) {
      console.log(`[Simulation] 已加载 ${this.amapRoutePaths.size} 条高德地图真实车辆路径`)
    }

    // 加载道路数据（优先从高德 API 缓存加载）
    this.roadNetwork = this._loadRoadData()

    if (this.roadNetwork.length === 0) {
      console.log('[Simulation] 使用内置道路数据（南京鼓楼区）')
      this.roadNetwork = [
        { id: 1, name: '中山北路',   start: [32.083000, 118.771000], end: [32.038000, 118.767000], points: this.generateRoadPoints(32.083000, 118.771000, 32.038000, 118.767000, 10) },
        { id: 2, name: '中央路',     start: [32.078000, 118.782000], end: [32.042000, 118.781000], points: this.generateRoadPoints(32.078000, 118.782000, 32.042000, 118.781000, 10) },
        { id: 3, name: '北京西路',   start: [32.058000, 118.750000], end: [32.058000, 118.792000], points: this.generateRoadPoints(32.058000, 118.750000, 32.058000, 118.792000, 10) },
        { id: 4, name: '汉中路',     start: [32.046000, 118.758000], end: [32.046000, 118.792000], points: this.generateRoadPoints(32.046000, 118.758000, 32.046000, 118.792000, 10) },
        { id: 5, name: '新模范马路', start: [32.072000, 118.758000], end: [32.072000, 118.792000], points: this.generateRoadPoints(32.072000, 118.758000, 32.072000, 118.792000, 10) },
        { id: 6, name: '虎踞路',     start: [32.076000, 118.752000], end: [32.038000, 118.752000], points: this.generateRoadPoints(32.076000, 118.752000, 32.038000, 118.752000, 10) },
      ]
    }

    // 车辆初始化延迟到 initialize() 中，确保高德API路径先加载完毕
    this._initialized = false
  }

  /**
   * 异步初始化：先加载高德API路径，再初始化车辆。
   * 必须在构造函数之后调用，禁止在 Amap 路径就绪前使用插值回退。
   */
  async initialize() {
    await this.fetchAmapRoutesAsync()
    this.initVehicles(this.routeVehicleCounts, this.routeSpeeds)
    this._initialized = true
    console.log('[Simulation] 异步初始化完成，所有路线使用高德API真实路径')
  }

  /**
   * 加载高德 API 获取的真实道路数据
   */
  _loadRoadData() {
    const roadsPath = path.resolve(__dirname, '../../data/roads.json')
    try {
      if (!fs.existsSync(roadsPath)) return []
      const raw = fs.readFileSync(roadsPath, 'utf-8')
      const data = JSON.parse(raw)
      if (!data.roads || data.roads.length === 0) return []

      const valid = data.roads.filter(r => r.points && r.points.length >= 2)
      if (valid.length > 0) {
        console.log(`[Simulation] 已加载 ${valid.length} 条高德地图真实道路数据`)
      }
      return valid
    } catch (err) {
      console.warn(`[Simulation] 道路数据加载失败，使用内置道路: ${err.message}`)
      return []
    }
  }

  /**
   * 生成道路坐标点
   */
  /**
   * 从航点数组插值生成路径（{latitude, longitude} 格式），用于无高德API路径时的回退
   * @param {Array<Array<number>>} waypoints - [[lat, lng], ...]
   * @param {number} totalPoints - 目标插值点数
   * @returns {Array<{latitude: number, longitude: number}>}
   */
  _interpolateWaypoints(waypoints, totalPoints = 50) {
    if (waypoints.length < 2) return []
    // 计算各段累积距离
    const segDists = []
    let totalDist = 0
    for (let i = 1; i < waypoints.length; i++) {
      const d = this._haversine(
        waypoints[i - 1][0], waypoints[i - 1][1],
        waypoints[i][0], waypoints[i][1]
      )
      segDists.push(d)
      totalDist += d
    }
    // 按距离等距插值
    const points = []
    for (let k = 0; k < totalPoints; k++) {
      const target = (k / (totalPoints - 1)) * totalDist
      let acc = 0
      let seg = 0
      for (; seg < segDists.length; seg++) {
        if (acc + segDists[seg] >= target || seg === segDists.length - 1) break
        acc += segDists[seg]
      }
      const segDist = segDists[seg] || 1
      const t = segDist > 0 ? Math.max(0, Math.min(1, (target - acc) / segDist)) : 0
      const lat = waypoints[seg][0] + (waypoints[seg + 1][0] - waypoints[seg][0]) * t
      const lng = waypoints[seg][1] + (waypoints[seg + 1][1] - waypoints[seg][1]) * t
      points.push({ latitude: lat, longitude: lng })
    }
    return points
  }

  _haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000
    const toRad = d => d * Math.PI / 180
    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  generateRoadPoints(lat1, lng1, lat2, lng2, count) {
    const points = []
    for (let i = 0; i <= count; i++) {
      const t = i / count
      const lat = lat1 + (lat2 - lat1) * t
      const lng = lng1 + (lng2 - lng1) * t
      points.push({
        latitude: lat,
        longitude: lng
      })
    }
    return points
  }

  /**
   * 计算两点之间的方向角（度）
   */
  calculateHeading(lat1, lng1, lat2, lng2) {
    const dLng = lng2 - lng1
    const dLat = lat2 - lat1
    const angle = Math.atan2(dLng, dLat) * (180 / Math.PI)
    return ((angle % 360) + 360) % 360
  }

  /**
   * 计算两点间距离（简易，单位：度）
   */
  distance(lat1, lng1, lat2, lng2) {
    return Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lng2 - lng1, 2))
  }

  /**
   * 初始化车辆（按路线分配，每条路线车辆数和速度独立配置）
   * @param {Object} routeVehicleCounts - { [routeId]: count }
   * @param {Object} [routeSpeeds] - { [routeId]: speedKmh }，默认 35 km/h
   */
  initVehicles(routeVehicleCounts, routeSpeeds) {
    this.vehicles = []
    this.vehiclePaths = []

    const counts = routeVehicleCounts || Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, this.routeConfig.defaultVehicleCount || 5])
    )
    const speeds = routeSpeeds || Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, 35])
    )

    // 获取RSU部署数据，用于计算每辆车的内容块
    const deployment = computeRSUDeployment(this.routeConfig.routes)

    // 按 routeId 分组 RSU，用于确定每辆车将要途经的 RSU
    const rsusByRoute = {}
    for (const rsu of deployment.intersections) {
      if (!rsusByRoute[rsu.routeId]) rsusByRoute[rsu.routeId] = []
      rsusByRoute[rsu.routeId].push(rsu)
    }

    let vehicleId = 0

    // 按路径顺序排序各路线 RSU
    for (const rid of Object.keys(rsusByRoute)) {
      rsusByRoute[rid].sort((a, b) => (a.pathDist || 0) - (b.pathDist || 0))
    }

    for (const route of this.routeConfig.routes) {
      // 优先使用高德API真实路径；缺失时从 waypoints 插值回退
      let path = this.amapRoutePaths.get(route.id)
      if (!path || path.length < 2) {
        const wps = route.waypoints || []
        if (wps.length < 2) {
          console.error(`[Simulation] 路线 ${route.id} (${route.name}) 缺少路径数据，已跳过`)
          continue
        }
        path = this._interpolateWaypoints(wps, Math.max(30, wps.length * 10))
        console.warn(`[Simulation] 路线 ${route.id} (${route.name}) 无高德API路径，`
          + `使用航点插值 (${wps.length} → ${path.length} 点)`)
      }

      const vehiclesPerRoute = counts[route.id] || this.routeConfig.defaultVehicleCount || 5
      console.log(`  [路线 ${route.id}] ${route.name}: ${path.length} 个路径点, ${vehiclesPerRoute}辆车 (高德API)`)

      for (let i = 0; i < vehiclesPerRoute; i++) {
        vehicleId++
        // 每路线车辆均匀分布，确保地图上清晰可见
        // 分别从路径不同位置起步，加 ±2% 微小随机抖动
        const maxStartIdx = Math.max(1, path.length - 2);
        const baseRatio = i / vehiclesPerRoute;
        const jitter = (Math.random() - 0.5) * 0.04;
        const startIdx = Math.floor(Math.max(0, Math.min(baseRatio + jitter, 0.90)) * maxStartIdx);

        const routeRsus = rsusByRoute[route.id] || []
        // 计算车辆起步位置的路径距离，过滤出前方 RSU
        const vehicleStartDist = computePathDistAt(path, startIdx)
        const aheadRsus = routeRsus.filter(rsu => (rsu.pathDist || 0) >= vehicleStartDist)

        this.vehicles.push({
          id: vehicleId,
          name: `车辆 ${vehicleId} (${route.name})`,
          latitude: path[startIdx].latitude,
          longitude: path[startIdx].longitude,
          speed: speeds[route.id] ?? 35,
          routeSpeedKmh: speeds[route.id] ?? 35,
          heading: 0,
          pathProgress: startIdx / (path.length - 1),
          completed: false,
          trajectory: [],
          maxTrajectory: 50,
          routeId: route.id,
          routeName: route.name,
          routeIndex: i + 1,
          requestedBlocks: aheadRsus.flatMap(rsu =>
            Array.from({ length: 100 }, (_, i) => (rsu.id - 1) * 100 + i + 1)
          ),
          routeRsuIds: aheadRsus.map(r => r.id),        // 将要途经的 RSU ID 列表（路径顺序）
        })

        this.vehiclePaths.push(path)
      }
    }

    const perRouteSummary = this.routeConfig.routes.map(r => `${r.name}:${counts[r.id] || 5}辆/${speeds[r.id] || 35}km/h`).join(', ')
    console.log(`[Simulation] 已初始化 ${vehicleId} 辆车，分配: ${perRouteSummary}`)
  }

  /**
   * 路线变更后重新初始化（不清除当前路线配置，仅重建车辆和RSU）
   * @param {Object} newRouteConfig - 新的路线配置
   */
  reinitialize(newRouteConfig) {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
    this.paused = false
    this.tickCount = 0
    this.routeConfig = newRouteConfig || this.routeConfig

    // 保留已有路线的车辆计数和速度，新路线用默认值
    const newCounts = {}
    const newSpeeds = {}
    for (const route of this.routeConfig.routes) {
      newCounts[route.id] = this.routeVehicleCounts[route.id] || this.routeConfig.defaultVehicleCount || 5
      newSpeeds[route.id] = this.routeSpeeds[route.id] ?? 35
    }
    this.routeVehicleCounts = newCounts
    this.routeSpeeds = newSpeeds

    this.initVehicles(this.routeVehicleCounts, this.routeSpeeds)
    console.log(`[Simulation] 已重新初始化，路线数: ${this.routeConfig.routes.length}`)
  }

  /**
   * 异步从高德 API 获取真实车辆路径，加载后替换插值路径
   * 仅在缓存不存在时发起网络请求，获取后自动保存缓存
   */
  async fetchAmapRoutesAsync() {
    const routes = this.routeConfig.routes
    // 检查是否已有足够的高德路径数据
    const existingCount = routes.filter(r => {
      const path = this.amapRoutePaths.get(r.id)
      return path && path.length >= 2
    }).length
    if (existingCount >= routes.length && routes.length > 0) {
      console.log('[Simulation] 高德路径数据已全部缓存，跳过在线获取')
      return
    }

    console.log('[Simulation] 开始在线获取高德路径规划数据...')
    try {
      const routePaths = await fetchAllAmapRoutes(routes)

      // 更新缓存文件
      saveRouteCache(ROUTE_CACHE_FILE, routes, routePaths)
      this.amapRoutePaths = routePaths

      // 更新已运行车辆的路径
      let updatedCount = 0
      for (let idx = 0; idx < this.vehicles.length; idx++) {
        const vehicle = this.vehicles[idx]
        const amapPath = routePaths.get(vehicle.routeId)
        if (amapPath && amapPath.length >= 2) {
          // 保持当前进度，在真实路径上重新计算位置
          this.vehiclePaths[idx] = amapPath
          const totalSegments = amapPath.length - 1
          const exactIdx = vehicle.pathProgress * totalSegments
          const segIdx = Math.min(Math.floor(exactIdx), totalSegments - 1)
          const segProgress = exactIdx - segIdx
          const p1 = amapPath[segIdx]
          const p2 = amapPath[Math.min(segIdx + 1, totalSegments)]
          vehicle.latitude = p1.latitude + (p2.latitude - p1.latitude) * segProgress
          vehicle.longitude = p1.longitude + (p2.longitude - p1.longitude) * segProgress
          vehicle.heading = this.calculateHeading(p1.latitude, p1.longitude, p2.latitude, p2.longitude)
          updatedCount++
        }
      }
      console.log(`[Simulation] 高德路径加载完成，已更新 ${updatedCount} 辆车的路径`)
    } catch (err) {
      console.error(`[Simulation] 高德路径获取失败: ${err.message}`)
    }
  }

  /**
   * 更新所有车辆位置
   */
  updateVehicles() {
    const REF_SPEED = 60  // 参考速度 km/h — 此速度下行为与旧版 avgSpeed=1.0 一致

    this.vehicles.forEach((vehicle, idx) => {
      const path = this.vehiclePaths[idx]
      if (!path || path.length < 2) return

      // 已完成的车辆停在终点不再移动
      if (vehicle.completed) return

      // 每条路线独立速度：归一化到参考速度计算步长
      const routeSpeed = vehicle.routeSpeedKmh ?? 35
      const speedFactor = routeSpeed / REF_SPEED
      const step = 0.01 * (this.speedLevel / 5) * speedFactor

      // 推进进度
      vehicle.pathProgress += step
      if (vehicle.pathProgress >= 1) {
        // 车辆到达终点 → 停止运行，后续从广播中移除
        vehicle.pathProgress = 1
        vehicle.completed = true
        const lastPt = path[path.length - 1]
        vehicle.latitude = lastPt.latitude
        vehicle.longitude = lastPt.longitude
        vehicle.speed = 0
        return
      }

      // 根据进度计算当前所在路段
      const totalSegments = path.length - 1
      const exactIdx = vehicle.pathProgress * totalSegments
      const segIdx = Math.min(Math.floor(exactIdx), totalSegments - 1)
      const segProgress = exactIdx - segIdx

      const p1 = path[segIdx]
      const p2 = path[Math.min(segIdx + 1, path.length - 1)]

      // 插值计算当前位置
      vehicle.latitude = p1.latitude + (p2.latitude - p1.latitude) * segProgress
      vehicle.longitude = p1.longitude + (p2.longitude - p1.longitude) * segProgress

      // 计算方向
      vehicle.heading = this.calculateHeading(p1.latitude, p1.longitude, p2.latitude, p2.longitude)

      // 模拟速度波动（以路线设定速度为中心 ±5 km/h 微调）
      const baseSpeed = vehicle.routeSpeedKmh ?? 35
      vehicle.speed = baseSpeed === 0 ? 0 : Math.max(5, baseSpeed + Math.sin(this.tickCount * 0.1 + idx) * 5)

      // 更新轨迹
      vehicle.trajectory.push({
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        speed: vehicle.speed,
        heading: vehicle.heading,
        timestamp: new Date().toISOString()
      })

      if (vehicle.trajectory.length > vehicle.maxTrajectory) {
        vehicle.trajectory = vehicle.trajectory.slice(-vehicle.maxTrajectory)
      }
    })

    this.tickCount++
  }

  /**
   * 广播车辆数据
   */
  broadcastData() {
    const payload = {
      vehicles: this.vehicles
        .filter(v => !v.completed)  // 已完成的车辆不广播，前端自动消失
        .map(v => ({
        id: v.id,
        name: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
        speed: v.speed,
        heading: v.heading,
        completed: v.completed,
        trajectory: v.trajectory,
        routeId: v.routeId,
        routeName: v.routeName,
        routeIndex: v.routeIndex,
        requestedBlocks: v.requestedBlocks,
        routeRsuIds: v.routeRsuIds || [],               // 完整路由 RSU 序列（长久保存）
        upcomingRsuIds: this.cachingService?.getUpcomingRsuIds(v.id) || [],  // 实时剩余 RSU（每 tick 更新）
      })),  // .filter() + .map() 闭合
      timestamp: new Date().toISOString(),
      tick: this.tickCount
    }

    this.io.emit('vehicle:update', payload)

    // 通知 CachingService 更新 RSU 数据和命中率（传递 tickCount 用于定时触发算法）
    if (this.cachingService) {
      this.cachingService.onVehicleTick(this.vehicles, this.tickCount)
    }
  }

  /**
   * 启动模拟
   */
  start(speedLevel, routeVehicleCounts, routeSpeeds) {
    this.speedLevel = speedLevel || 5
    // 动态初始化默认车辆计数和速度
    const defaultCounts = Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, this.routeConfig.defaultVehicleCount || 5])
    )
    const defaultSpeeds = Object.fromEntries(
      this.routeConfig.routes.map(r => [r.id, 35])
    )
    this.routeVehicleCounts = routeVehicleCounts || defaultCounts
    this.routeSpeeds = routeSpeeds || defaultSpeeds
    this.running = true
    this.paused = false

    // 用新参数重新初始化车辆
    this.initVehicles(this.routeVehicleCounts, this.routeSpeeds)

    if (this.timer) {
      clearInterval(this.timer)
    }

    const total = Object.values(this.routeVehicleCounts).reduce((a, b) => a + b, 0)
    const interval = Math.max(100, 1000 - (this.speedLevel - 1) * 100)
    const speedSummary = this.routeConfig.routes.map(r => `${r.name}:${this.routeSpeeds[r.id] || 35}km/h`).join(', ')
    console.log(`[Simulation] 启动模拟, 速度等级: ${this.speedLevel}, 车辆总数: ${total}, 路线速度: [${speedSummary}], 推送间隔: ${interval}ms`)

    // 先发送初始数据
    this.updateVehicles()
    this.broadcastData()

    this.timer = setInterval(() => {
      if (!this.paused) {
        this.updateVehicles()
        this.broadcastData()
      }
    }, interval)
  }

  /**
   * 暂停
   */
  pause() {
    this.paused = true
    console.log('[Simulation] 模拟已暂停')
  }

  /**
   * 恢复（支持运行时更新路线速度和车辆数）
   * @param {Object} [routeVehicleCounts] - 可选，更新后的路线车辆数
   * @param {Object} [routeSpeeds] - 可选，更新后的路线速度 km/h
   */
  resume(routeVehicleCounts, routeSpeeds) {
    const counts = routeVehicleCounts || this.routeVehicleCounts
    const speeds = routeSpeeds || this.routeSpeeds

    // 检查车辆数是否变化
    const countChanged = routeVehicleCounts && Object.keys(routeVehicleCounts).some(
      id => routeVehicleCounts[id] !== this.routeVehicleCounts[id]
    )

    if (countChanged) {
      // 车辆数变了 → 全部重新初始化
      this.routeVehicleCounts = counts
      this.routeSpeeds = speeds
      this.initVehicles(this.routeVehicleCounts, this.routeSpeeds)
      console.log('[Simulation] 车辆配置已更新，已重新初始化')
    } else if (routeSpeeds) {
      // 仅速度变化 → 原地更新每辆车的速度，保留当前位置
      this.routeSpeeds = speeds
      for (const vehicle of this.vehicles) {
        const newSpeed = speeds[vehicle.routeId]
        if (newSpeed !== undefined) {
          vehicle.routeSpeedKmh = newSpeed
          vehicle.speed = newSpeed
        }
      }
      const speedSummary = this.routeConfig.routes.map(r => `${r.name}:${speeds[r.id] || 35}km/h`).join(', ')
      console.log(`[Simulation] 路线速度已更新: [${speedSummary}]`)
    }

    this.paused = false
    console.log('[Simulation] 模拟已恢复')
  }

  /**
   * 重置
   */
  reset() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
    this.paused = false
    this.tickCount = 0
    this.initVehicles(this.routeVehicleCounts, this.routeSpeeds)
    console.log('[Simulation] 模拟已重置')
  }

  /**
   * 设置 CachingService 实例
   */
  setCachingService(cs) {
    this.cachingService = cs
  }

  /**
   * 获取当前速度等级
   */
  getSpeedLevel() {
    return this.speedLevel
  }
}
