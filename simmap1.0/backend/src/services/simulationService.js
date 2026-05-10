/**
 * 车辆行驶模拟服务
 *
 * 优先加载 data/roads.json 中的高德地图真实道路数据，
 * 文件不存在时回退到内置道路。
 *
 * Matlab/Python 集成说明：
 * - 设置环境变量 USE_EXTERNAL_ALGORITHM=true 启用外部算法
 * - Python脚本路径: ../algorithm/python/simulate.py
 * - Matlab文件路径: ../algorithm/matlab/simulate.m
 * - 通过 child_process 调用 Python，Python 再通过 matlabengine 调用 Matlab
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadRouteCache, fetchAllAmapRoutes, saveRouteCache } from '../utils/amapRoute.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_CACHE_FILE = path.resolve(__dirname, '../../data/route_paths.json')

// 6条固定地铁站间路线定义（高精度坐标）
const ROUTE_DEFS = [
  {
    id: 1, name: '古平岗→新庄', start: '古平岗站', end: '新庄站',
    waypoints: [
      [32.071239453028696, 118.75797707525267],  // 古平岗站
      [32.072000000000000, 118.76500000000000],  // 向东
      [32.073000000000000, 118.77500000000000],  // 向东
      [32.074000000000000, 118.78500000000000],  // 向东
      [32.075000000000000, 118.79500000000000],  // 向东
      [32.076777001742040, 118.81034025020665],  // 新庄站
    ],
  },
  {
    id: 2, name: '草场门→九华山', start: '草场门站', end: '九华山站',
    waypoints: [
      [32.060421913675000, 118.75586611575406],  // 草场门站
      [32.060000000000000, 118.76200000000000],  // 北京西路
      [32.060000000000000, 118.77000000000000],  // 北京西路
      [32.059000000000000, 118.77800000000000],  // 北京西路（云南路附近）
      [32.058000000000000, 118.78500000000000],  // 北京东路（鼓楼附近）
      [32.057500000000000, 118.79500000000000],  // 北京东路
      [32.057438546125040, 118.80587678028652],  // 九华山站
    ],
  },
  {
    id: 3, name: '汉中门→西安门', start: '汉中门站', end: '西安门站',
    waypoints: [
      [32.042863325579320, 118.76711201979688],  // 汉中门站
      [32.042500000000000, 118.77500000000000],  // 汉中路
      [32.041500000000000, 118.78300000000000],  // 汉中路
      [32.041000000000000, 118.79000000000000],  // 汉中路东段
      [32.040500000000000, 118.79800000000000],  // 汉中路东段
      [32.040492177973746, 118.80596505656148],  // 西安门站
    ],
  },
  {
    id: 4, name: '古平岗→汉中门', start: '古平岗站', end: '汉中门站',
    waypoints: [
      [32.071239453028696, 118.75797707525267],  // 古平岗站
      [32.066000000000000, 118.76000000000000],  // 虎踞路
      [32.060000000000000, 118.76200000000000],  // 虎踞路
      [32.055000000000000, 118.76400000000000],  // 虎踞路
      [32.050000000000000, 118.76500000000000],  // 虎踞路
      [32.042863325579320, 118.76711201979688],  // 汉中门站
    ],
  },
  {
    id: 5, name: '新模范马路→新街口', start: '新模范马路站', end: '新街口站',
    waypoints: [
      [32.079932709933416, 118.78411162470866],  // 新模范马路站
      [32.075000000000000, 118.78410000000000],  // 中央路
      [32.070000000000000, 118.78410000000000],  // 中央路
      [32.065000000000000, 118.78410000000000],  // 中央路
      [32.060000000000000, 118.78410000000000],  // 中央路
      [32.055000000000000, 118.78410000000000],  // 中央路
      [32.050000000000000, 118.78410000000000],  // 中央路
      [32.045000000000000, 118.78410000000000],  // 中央路
      [32.041611022106075, 118.78419797766223],  // 新街口站
    ],
  },
  {
    id: 6, name: '新庄→西安门', start: '新庄站', end: '西安门站',
    waypoints: [
      [32.076777001742040, 118.81034025020665],  // 新庄站
      [32.074000000000000, 118.80900000000000],  // 向西南
      [32.070000000000000, 118.80800000000000],  // 向南
      [32.065000000000000, 118.80700000000000],  // 向南
      [32.060000000000000, 118.80600000000000],  // 向南
      [32.055000000000000, 118.80600000000000],  // 向南
      [32.050000000000000, 118.80600000000000],  // 向南
      [32.040492177973746, 118.80596505656148],  // 西安门站
    ],
  },
]

export class SimulationService {
  constructor(io) {
    this.io = io
    this.timer = null
    this.running = false
    this.paused = false
    this.speedLevel = 5
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

    this.initVehicles()
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
   * 从路线航点生成平滑路径点
   */
  generateRoutePath(waypoints, pointsPerSegment = 5) {
    const points = []
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [lat1, lng1] = waypoints[i]
      const [lat2, lng2] = waypoints[i + 1]
      for (let j = 0; j < pointsPerSegment; j++) {
        const t = j / pointsPerSegment
        points.push({
          latitude: +(lat1 + (lat2 - lat1) * t).toFixed(6),
          longitude: +(lng1 + (lng2 - lng1) * t).toFixed(6),
        })
      }
    }
    const [lastLat, lastLng] = waypoints[waypoints.length - 1]
    points.push({ latitude: lastLat, longitude: lastLng })
    return points
  }

  /**
   * 初始化车辆（按6条固定路线分配，每路线5辆）
   */
  initVehicles() {
    this.vehicles = []
    this.vehiclePaths = []

    const VEHICLES_PER_ROUTE = 5
    let vehicleId = 0

    for (const route of ROUTE_DEFS) {
      // 优先使用高德真实路径，回退到线性插值
      const amapPath = this.amapRoutePaths.get(route.id)
      const path = (amapPath && amapPath.length >= 2)
        ? amapPath
        : this.generateRoutePath(route.waypoints)

      const sourceLabel = (amapPath && amapPath.length >= 2) ? '高德API' : '插值'
      console.log(`  [路线 ${route.id}] ${route.name}: ${path.length} 个路径点 (${sourceLabel})`)

      for (let i = 0; i < VEHICLES_PER_ROUTE; i++) {
        vehicleId++
        // 每路线5辆车均匀分布，确保地图上清晰可见5辆车在移动
        const startIdx = Math.floor((i / VEHICLES_PER_ROUTE) * Math.max(path.length - 1, 1))

        this.vehicles.push({
          id: vehicleId,
          name: `车辆 ${vehicleId} (${route.name})`,
          latitude: path[startIdx].latitude,
          longitude: path[startIdx].longitude,
          speed: 30 + Math.random() * 40,
          heading: 0,
          pathProgress: startIdx / (path.length - 1),
          completed: false,
          trajectory: [],
          maxTrajectory: 50,
          routeId: route.id,
          routeName: route.name,
        })

        this.vehiclePaths.push(path)
      }
    }

    console.log(`[Simulation] 已初始化 ${vehicleId} 辆车，分配至 ${ROUTE_DEFS.length} 条固定路线`)
  }

  /**
   * 异步从高德 API 获取真实车辆路径，加载后替换插值路径
   * 仅在缓存不存在时发起网络请求，获取后自动保存缓存
   */
  async fetchAmapRoutesAsync() {
    // 检查是否已有足够的高德路径数据
    const existingCount = ROUTE_DEFS.filter(r => {
      const path = this.amapRoutePaths.get(r.id)
      return path && path.length >= 2
    }).length
    if (existingCount >= ROUTE_DEFS.length) {
      console.log('[Simulation] 高德路径数据已全部缓存，跳过在线获取')
      return
    }

    console.log('[Simulation] 开始在线获取高德路径规划数据...')
    try {
      const routePaths = await fetchAllAmapRoutes(ROUTE_DEFS)

      // 更新缓存文件
      saveRouteCache(ROUTE_CACHE_FILE, ROUTE_DEFS, routePaths)
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
    const step = 0.01 * (this.speedLevel / 5)

    this.vehicles.forEach((vehicle, idx) => {
      const path = this.vehiclePaths[idx]
      if (!path || path.length < 2) return

      // 已完成的车辆停在终点不再移动
      if (vehicle.completed) return

      // 推进进度
      vehicle.pathProgress += step
      if (vehicle.pathProgress >= 1) {
        vehicle.pathProgress = 1
        vehicle.completed = true
        // 锁定在终点位置
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

      // 模拟速度波动
      vehicle.speed = Math.max(10, 30 + this.speedLevel * 8 + Math.sin(this.tickCount * 0.1 + idx) * 10)

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
      vehicles: this.vehicles.map(v => ({
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
      })),
      timestamp: new Date().toISOString(),
      tick: this.tickCount
    }

    this.io.emit('vehicle:update', payload)

    // 通知 CachingService 更新 RSU 数据和命中率
    if (this.cachingService) {
      this.cachingService.onVehicleTick(this.vehicles)
    }
  }

  /**
   * 启动模拟
   */
  start(speedLevel) {
    this.speedLevel = speedLevel || 5
    this.running = true
    this.paused = false

    if (this.timer) {
      clearInterval(this.timer)
    }

    const interval = Math.max(100, 1000 - (this.speedLevel - 1) * 100)
    console.log(`[Simulation] 启动模拟, 速度等级: ${this.speedLevel}, 推送间隔: ${interval}ms`)

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
   * 恢复
   */
  resume() {
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
    this.initVehicles()
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
