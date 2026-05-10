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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
    this.centerLat = 32.059
    this.centerLng = 118.769

    // 内置车辆配置
    this.vehicles = []
    this.vehiclePaths = []

    // 加载道路数据（优先从高德 API 缓存加载）
    this.roadNetwork = this._loadRoadData()

    if (this.roadNetwork.length === 0) {
      console.log('[Simulation] 使用内置道路数据（南京鼓楼区）')
      this.roadNetwork = [
        { id: 1, name: '中山北路',   start: [32.083, 118.771], end: [32.038, 118.767], points: this.generateRoadPoints(32.083, 118.771, 32.038, 118.767, 10) },
        { id: 2, name: '中央路',     start: [32.078, 118.782], end: [32.042, 118.781], points: this.generateRoadPoints(32.078, 118.782, 32.042, 118.781, 10) },
        { id: 3, name: '北京西路',   start: [32.058, 118.750], end: [32.058, 118.792], points: this.generateRoadPoints(32.058, 118.750, 32.058, 118.792, 10) },
        { id: 4, name: '汉中路',     start: [32.046, 118.758], end: [32.046, 118.792], points: this.generateRoadPoints(32.046, 118.758, 32.046, 118.792, 10) },
        { id: 5, name: '新模范马路', start: [32.072, 118.758], end: [32.072, 118.792], points: this.generateRoadPoints(32.072, 118.758, 32.072, 118.792, 10) },
        { id: 6, name: '虎踞路',     start: [32.076, 118.752], end: [32.038, 118.752], points: this.generateRoadPoints(32.076, 118.752, 32.038, 118.752, 10) },
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
      const jitter = 0.0002 * Math.sin(i * 1.5) // 轻微弯曲模拟真实道路
      points.push({
        latitude: lat + jitter,
        longitude: lng + jitter * 0.5
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
   * 初始化车辆
   */
  initVehicles() {
    this.vehicles = []
    this.vehiclePaths = []

    const vehicleCount = 5

    for (let i = 0; i < vehicleCount; i++) {
      const road = this.roadNetwork[i % this.roadNetwork.length]
      const path = road.points
      const startIdx = Math.floor(Math.random() * Math.max(1, path.length - 5))

      this.vehicles.push({
        id: i + 1,
        name: `车辆 ${i + 1}`,
        latitude: path[startIdx].latitude,
        longitude: path[startIdx].longitude,
        speed: 30 + Math.random() * 40,
        heading: 0,
        pathProgress: startIdx / (path.length - 1),
        completed: false,
        trajectory: [],
        maxTrajectory: 50
      })

      this.vehiclePaths.push(path)
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
        trajectory: v.trajectory
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
