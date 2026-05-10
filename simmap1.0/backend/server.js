import app from './src/app.js'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { setupSocketHandlers } from './src/socket/index.js'
import { initDatabase } from './src/models/index.js'

const PORT = process.env.PORT || 3000

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST']
  }
})

// 初始化数据库
await initDatabase()

// 配置WebSocket
setupSocketHandlers(io)

httpServer.listen(PORT, () => {
  console.log(`[Server] 后端服务已启动: http://localhost:${PORT}`)
  console.log(`[Server] WebSocket 服务已就绪`)
})
