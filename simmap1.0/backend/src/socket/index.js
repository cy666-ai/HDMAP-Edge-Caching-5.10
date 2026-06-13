import { SimulationService } from '../services/simulationService.js'
import { CachingService } from '../services/cachingService.js'
import { setCachingService } from '../services/serviceRegistry.js'
import { loadRouteConfig, saveRouteConfig } from '../utils/routeConfig.js'
import { fetchAmapRoute, saveRouteCache } from '../utils/amapRoute.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_CACHE_FILE = path.resolve(__dirname, '../../data/route_paths.json')
const AMAP_CACHE_FILE = path.resolve(__dirname, '../../data/route_paths.json')

let simulationService = null
let cachingService = null
let routeConfig = null

export async function setupSocketHandlers(io) {
  // 加载路线配置（每次启动从 6 条默认路线重新生成）
  routeConfig = loadRouteConfig()

  simulationService = new SimulationService(io, routeConfig)

  // 先加载高德API真实路径，再初始化车辆 — 禁止插值回退
  await simulationService.initialize()

  // 初始化 RSU 缓存命中率服务，注入到 SimulationService
  cachingService = new CachingService(io, routeConfig)
  setCachingService(cachingService)
  simulationService.setCachingService(cachingService)

  io.on('connection', (socket) => {
    console.log(`[Socket] 客户端已连接: ${socket.id}`)

    // ==================== 模拟控制 ====================

    // 开始模拟
    socket.on('simulation:start', (data) => {
      console.log(`[Simulation] 收到开始指令 from ${socket.id}`)
      const speedLevel = data?.speedLevel || 5
      const defaultCounts = Object.fromEntries(
        routeConfig.routes.map(r => [r.id, routeConfig.defaultVehicleCount || 5])
      )
      const defaultSpeeds = Object.fromEntries(
        routeConfig.routes.map(r => [r.id, 35])
      )
      const routeVehicleCounts = data?.routeVehicleCounts || defaultCounts
      const routeSpeeds = data?.routeSpeeds || defaultSpeeds
      simulationService.start(speedLevel, routeVehicleCounts, routeSpeeds)
      const totalVehicles = Object.values(routeVehicleCounts).reduce((a, b) => a + b, 0)
      io.emit('simulation:status', { status: 'started', speedLevel, vehicleCount: totalVehicles, routeVehicleCounts, routeSpeeds })

      // 启动 RSU 数据广播和算法周期重算（先同步速度信息）
      cachingService.setRouteSpeeds(routeSpeeds)
      cachingService.startBroadcast()
      cachingService.startAlgorithmLoop()
    })

    // 暂停模拟
    socket.on('simulation:pause', () => {
      console.log(`[Simulation] 收到暂停指令 from ${socket.id}`)
      simulationService.pause()
      io.emit('simulation:status', { status: 'paused' })
    })

    // 恢复模拟
    socket.on('simulation:resume', (data) => {
      console.log(`[Simulation] 收到恢复指令 from ${socket.id}`)
      const speedLevel = simulationService.getSpeedLevel()
      const routeVehicleCounts = data?.routeVehicleCounts
      const routeSpeeds = data?.routeSpeeds
      simulationService.resume(routeVehicleCounts, routeSpeeds)
      if (routeSpeeds) {
        cachingService.setRouteSpeeds(routeSpeeds)
      }
      const totalVehicles = Object.values(simulationService.routeVehicleCounts).reduce((a, b) => a + b, 0)
      io.emit('simulation:status', {
        status: 'started',
        speedLevel,
        vehicleCount: totalVehicles,
        routeVehicleCounts: simulationService.routeVehicleCounts,
        routeSpeeds: simulationService.routeSpeeds
      })
    })

    // 重置模拟
    socket.on('simulation:reset', () => {
      console.log(`[Simulation] 收到重置指令 from ${socket.id}`)
      simulationService.reset()
      cachingService.stop()
      cachingService.reset()
      io.emit('simulation:status', { status: 'reset' })
      // 重置后同步当前路线配置和RSU数据，确保前端与后端一致
      io.emit('route:config', {
        routes: routeConfig.routes.map(r => ({
          id: r.id, name: r.name, start: r.start, end: r.end,
        })),
        defaultVehicleCount: routeConfig.defaultVehicleCount,
      })
      io.emit('rsu:update', cachingService.getCurrentData())
    })

    // ==================== RSU 数据 ====================

    // 获取当前 RSU 数据
    socket.on('rsu:getData', () => {
      socket.emit('rsu:update', cachingService.getCurrentData())
    })

    // 手动触发算法重算
    socket.on('rsu:recalc', async () => {
      console.log(`[Socket] 收到算法重算指令 from ${socket.id}`)
      await cachingService.triggerAlgorithm()
      socket.emit('rsu:update', cachingService.getCurrentData())
    })

    // 触发 5-算法对比分析
    socket.on('comparison:run', async () => {
      console.log(`[Socket] 收到对比分析指令 from ${socket.id}`)
      const result = await cachingService.runComparison()
      socket.emit('comparison:result', result)
    })

    // ==================== 路线管理 ====================

    // 获取当前路线配置
    socket.on('route:getConfig', () => {
      socket.emit('route:config', {
        routes: routeConfig.routes.map(r => ({
          id: r.id, name: r.name, start: r.start, end: r.end,
        })),
        defaultVehicleCount: routeConfig.defaultVehicleCount,
      })
    })

    // 获取高德路径
    socket.on('route:fetchAmap', async (data) => {
      const { startLat, startLng, endLat, endLng } = data || {}
      if (!startLat || !startLng || !endLat || !endLng) {
        socket.emit('route:fetchAmapResult', { success: false, error: '缺少起终点坐标' })
        return
      }
      try {
        const points = await fetchAmapRoute(startLat, startLng, endLat, endLng)
        if (points && points.length >= 2) {
          socket.emit('route:fetchAmapResult', { success: true, points, pointCount: points.length })
        } else {
          socket.emit('route:fetchAmapResult', { success: false, error: '高德API返回路径数据不足' })
        }
      } catch (err) {
        socket.emit('route:fetchAmapResult', { success: false, error: err.message })
      }
    })

    // 添加路线（始终通过高德API获取真实路径）
    socket.on('route:add', async (data) => {
      const { name, start, end, waypoints, amapPoints } = data || {}
      if (!name || !start || !end || !waypoints || waypoints.length < 2) {
        socket.emit('route:addResult', { success: false, error: '路线信息不完整' })
        return
      }

      // 停止当前模拟
      if (simulationService.running) {
        simulationService.reset()
        cachingService.stop()
        cachingService.reset()
      }

      // 分配新 ID
      const newId = routeConfig.nextId++
      const newRoute = { id: newId, name, start, end, waypoints }
      routeConfig.routes.push(newRoute)

      // 始终通过高德 API 获取真实路径，禁止插值回退
      let resolvedAmapPoints = (amapPoints && amapPoints.length >= 2) ? amapPoints : null
      if (!resolvedAmapPoints) {
        try {
          const [startLat, startLng] = waypoints[0]
          const [endLat, endLng] = waypoints[waypoints.length - 1]
          resolvedAmapPoints = await fetchAmapRoute(startLat, startLng, endLat, endLng)
          console.log(`[Socket] 高德API路径获取成功: ${resolvedAmapPoints.length} 个坐标点`)
        } catch (err) {
          // 高德API失败时回滚路线，不允许创建无真实路径的路线
          routeConfig.routes.pop()
          routeConfig.nextId--  // 回滚ID
          console.error(`[Socket] 高德API路径获取失败，路线创建已取消: ${err.message}`)
          socket.emit('route:addResult', { success: false, error: `高德API路径获取失败: ${err.message}` })
          return
        }
      }

      // 将高德路径追加到缓存
      try {
        const routePaths = simulationService.amapRoutePaths || new Map()
        routePaths.set(newId, resolvedAmapPoints)
        const routeDefs = routeConfig.routes.map(r => ({
          id: r.id, name: r.name, start: r.start, end: r.end, waypoints: r.waypoints,
        }))
        saveRouteCache(AMAP_CACHE_FILE, routeDefs, routePaths)
        simulationService.amapRoutePaths = routePaths
      } catch (err) {
        console.warn(`[Socket] 保存高德路径缓存失败: ${err.message}`)
      }

      // 持久化路线配置
      saveRouteConfig(routeConfig)

      // 重新初始化两个服务（此时 amapRoutePaths 已包含新路线的真实路径）
      simulationService.reinitialize(routeConfig)
      cachingService.reinitialize(routeConfig)

      // 广播更新（先发 reset 清空前端旧数据，再发新数据填充）
      io.emit('simulation:status', { status: 'reset' })
      io.emit('route:config', {
        routes: routeConfig.routes.map(r => ({
          id: r.id, name: r.name, start: r.start, end: r.end,
        })),
        defaultVehicleCount: routeConfig.defaultVehicleCount,
      })
      io.emit('rsu:update', cachingService.getCurrentData())

      console.log(`[Socket] 路线已添加: id=${newId}, name=${name} (高德API路径, ${resolvedAmapPoints.length} 点)`)
      socket.emit('route:addResult', { success: true, route: newRoute, pointCount: resolvedAmapPoints.length })
    })

    // 删除路线
    socket.on('route:delete', (data) => {
      const { routeId } = data || {}
      if (!routeId) {
        socket.emit('route:deleteResult', { success: false, error: '缺少路线ID' })
        return
      }

      const idx = routeConfig.routes.findIndex(r => r.id === routeId)
      if (idx === -1) {
        socket.emit('route:deleteResult', { success: false, error: '路线不存在' })
        return
      }

      if (routeConfig.routes.length <= 1) {
        socket.emit('route:deleteResult', { success: false, error: '至少保留一条路线' })
        return
      }

      // 停止当前模拟
      if (simulationService.running) {
        simulationService.reset()
        cachingService.stop()
        cachingService.reset()
      }

      const deletedRoute = routeConfig.routes.splice(idx, 1)[0]
      saveRouteConfig(routeConfig)

      // 重新初始化两个服务
      simulationService.reinitialize(routeConfig)
      cachingService.reinitialize(routeConfig)

      // 广播更新（先发 reset 清空前端旧数据，再发新数据填充）
      io.emit('simulation:status', { status: 'reset' })
      io.emit('route:config', {
        routes: routeConfig.routes.map(r => ({
          id: r.id, name: r.name, start: r.start, end: r.end,
        })),
        defaultVehicleCount: routeConfig.defaultVehicleCount,
      })
      io.emit('rsu:update', cachingService.getCurrentData())

      console.log(`[Socket] 路线已删除: id=${routeId}, name=${deletedRoute.name}`)
      socket.emit('route:deleteResult', { success: true, deletedId: routeId })
    })

    // 断开连接
    socket.on('disconnect', () => {
      console.log(`[Socket] 客户端已断开: ${socket.id}`)
    })
  })
}
