import { Router } from 'express'
import { Road, Vehicle, Trajectory } from '../models/index.js'
import { getCachingService, getChatService } from '../services/serviceRegistry.js'

const router = Router()

// 获取所有道路
router.get('/roads', async (req, res) => {
  try {
    const roads = await Road.findAll()
    res.json({ success: true, data: roads })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 获取所有车辆信息
router.get('/vehicles', async (req, res) => {
  try {
    const vehicles = await Vehicle.findAll()
    res.json({ success: true, data: vehicles })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 获取指定车辆轨迹
router.get('/vehicles/:id/trajectory', async (req, res) => {
  try {
    const { id } = req.params
    const limit = parseInt(req.query.limit) || 100
    const trajectory = await Trajectory.findAll({
      where: { vehicleId: id },
      order: [['timestamp', 'DESC']],
      limit
    })
    res.json({ success: true, data: trajectory.reverse() })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 清除所有历史轨迹
router.delete('/trajectory', async (req, res) => {
  try {
    await Trajectory.destroy({ where: {} })
    res.json({ success: true, message: '轨迹已清除' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 获取系统状态
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      server: 'running',
      timestamp: new Date().toISOString()
    }
  })
})

// 获取 RSU 缓存命中率数据
router.get('/rsu', (req, res) => {
  try {
    const cs = getCachingService()
    if (!cs) {
      return res.json({ success: false, message: 'CachingService 未初始化' })
    }
    res.json({ success: true, data: cs.getCurrentData() })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 检查 AI 聊天 Agent 是否在线
router.get('/chat/status', async (req, res) => {
  try {
    const chatService = getChatService()
    const online = chatService ? await chatService.healthCheck() : false
    res.json({ success: true, data: { online } })
  } catch (err) {
    res.json({ success: true, data: { online: false } })
  }
})

export default router
