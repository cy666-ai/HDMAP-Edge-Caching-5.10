import express from 'express'
import cors from 'cors'
import apiRouter from './routes/api.js'

const app = express()

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173']
}))
app.use(express.json())

// API 路由
app.use('/api', apiRouter)

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

export default app
