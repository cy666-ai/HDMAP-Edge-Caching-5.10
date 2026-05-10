import { SimulationService } from '../services/simulationService.js'
import { CachingService } from '../services/cachingService.js'
import { setCachingService } from '../services/serviceRegistry.js'

let simulationService = null
let cachingService = null

export function setupSocketHandlers(io) {
  simulationService = new SimulationService(io)

  // 异步获取高德真实车辆路径（有缓存时不发请求）
  simulationService.fetchAmapRoutesAsync()

  // 初始化 RSU 缓存命中率服务，注入到 SimulationService
  cachingService = new CachingService(io)
  setCachingService(cachingService)
  simulationService.setCachingService(cachingService)

  io.on('connection', (socket) => {
    console.log(`[Socket] 客户端已连接: ${socket.id}`)

    // 开始模拟
    socket.on('simulation:start', (data) => {
      console.log(`[Simulation] 收到开始指令 from ${socket.id}`)
      const speedLevel = data?.speedLevel || 5
      simulationService.start(speedLevel)
      io.emit('simulation:status', { status: 'started', speedLevel })

      // 启动 RSU 数据广播和 MATLAB 周期重算
      cachingService.startBroadcast()
      cachingService.startMatlabLoop()
    })

    // 暂停模拟
    socket.on('simulation:pause', () => {
      console.log(`[Simulation] 收到暂停指令 from ${socket.id}`)
      simulationService.pause()
      io.emit('simulation:status', { status: 'paused' })
    })

    // 恢复模拟
    socket.on('simulation:resume', () => {
      console.log(`[Simulation] 收到恢复指令 from ${socket.id}`)
      const speedLevel = simulationService.getSpeedLevel()
      simulationService.resume()
      io.emit('simulation:status', { status: 'started', speedLevel })
    })

    // 重置模拟
    socket.on('simulation:reset', () => {
      console.log(`[Simulation] 收到重置指令 from ${socket.id}`)
      simulationService.reset()
      cachingService.stop()
      io.emit('simulation:status', { status: 'reset' })
    })

    // 获取当前 RSU 数据
    socket.on('rsu:getData', () => {
      socket.emit('rsu:update', cachingService.getCurrentData())
    })

    // 手动触发 MATLAB 重算
    socket.on('rsu:recalc', async () => {
      console.log(`[Socket] 收到 MATLAB 重算指令 from ${socket.id}`)
      await cachingService.triggerMatlab()
      socket.emit('rsu:update', cachingService.getCurrentData())
    })

    // 断开连接
    socket.on('disconnect', () => {
      console.log(`[Socket] 客户端已断开: ${socket.id}`)
    })
  })
}
