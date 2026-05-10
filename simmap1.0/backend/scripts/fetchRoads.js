/**
 * 高德地图路径规划 API 获取道路真实坐标
 *
 * 从高德 V5 驾车路径规划 API 获取南京鼓楼区主要道路的真实 shape 坐标，
 * 保存到 data/roads.json 供模拟引擎加载。
 *
 * 使用方式:
 *   AMAP_KEY=your_key node scripts/fetchRoads.js
 *
 * 环境变量:
 *   AMAP_KEY          高德 Web 服务 API Key（必填）
 *   AMAP_STRATEGY     路径规划策略，默认 0（速度优先）
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const AMAP_KEY = process.env.AMAP_KEY || '4bf282e07d4faf6337a82a21d755c796'

// 南京鼓楼区主要道路起止点（GCJ-02 坐标系）
// origin/destination 格式: "经度,纬度"（高德 API 要求）
const ROADS = [
  // 南北向
  { id: 1, name: '中山北路',   origin: '118.771000,32.083000', destination: '118.767000,32.038000' },
  { id: 2, name: '中央路',     origin: '118.782000,32.078000', destination: '118.781000,32.042000' },
  { id: 3, name: '北京西路',   origin: '118.750000,32.058000', destination: '118.792000,32.058000' },
  // 东西向
  { id: 4, name: '汉中路',     origin: '118.758000,32.046000', destination: '118.792000,32.046000' },
  { id: 5, name: '新模范马路', origin: '118.758000,32.072000', destination: '118.792000,32.072000' },
  { id: 6, name: '虎踞路',     origin: '118.752000,32.076000', destination: '118.752000,32.038000' },
  // 扩展覆盖道路
  { id: 7, name: '北京东路',   origin: '118.783000,32.059000', destination: '118.801000,32.059000' },
  { id: 8, name: '中山南路',   origin: '118.783000,32.046000', destination: '118.783000,32.038000' },
  { id: 9, name: '模范西路',   origin: '118.752000,32.076000', destination: '118.758000,32.076000' },
]

const API_URL = 'https://restapi.amap.com/v5/direction/driving'
const STRATEGY = process.env.AMAP_STRATEGY || '0'

/**
 * 调用高德 V5 驾车路径规划，提取道路 polyline 坐标
 */
async function fetchRoadPolyline(road) {
  const params = new URLSearchParams({
    key: AMAP_KEY,
    origin: road.origin,
    destination: road.destination,
    strategy: STRATEGY,
    show_fields: 'polyline'
  })

  const res = await fetch(`${API_URL}?${params}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const body = await res.json()
  if (body.status !== '1') throw new Error(`API 错误: ${body.info} (infocode: ${body.infocode})`)
  if (!body.route?.paths?.[0]?.steps?.length) throw new Error('返回数据中无路径信息')

  // 提取并去重连续重复坐标
  const points = []
  let lastKey = ''
  for (const step of body.route.paths[0].steps) {
    const coords = step.polyline.split(';')
    for (const coord of coords) {
      if (coord === lastKey) continue
      lastKey = coord
      const [lng, lat] = coord.split(',').map(Number)
      if (!isNaN(lat) && !isNaN(lng)) {
        points.push({ latitude: lat, longitude: lng })
      }
    }
  }

  if (points.length < 2) throw new Error('提取的坐标点不足 2 个')

  return points
}

async function main() {
  const outputDir = path.resolve(__dirname, '..', 'data')
  const outputPath = path.join(outputDir, 'roads.json')

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const roadNetwork = []
  let success = 0
  let fail = 0

  console.log(`策略: STRATEGY=${STRATEGY}\n`)

  for (const road of ROADS) {
    process.stdout.write(`[${road.id}/${ROADS.length}] ${road.name} ... `)
    try {
      const points = await fetchRoadPolyline(road)
      roadNetwork.push({ id: road.id, name: road.name, points })
      console.log(`✓ ${points.length} 个坐标点`)
      success++
    } catch (err) {
      console.log(`✗ ${err.message}`)
      fail++
    }

    // API QPS 限流，间隔 300ms
    await new Promise(r => setTimeout(r, 300))
  }

  const result = {
    center: { latitude: 32.059000, longitude: 118.769000 },
    roads: roadNetwork,
    updatedAt: new Date().toISOString()
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8')

  console.log(`\n完成: ${success} 条成功, ${fail} 条失败`)
  console.log(`输出: ${outputPath}`)

  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error(`\n脚本异常: ${err.message}`)
  process.exit(1)
})
