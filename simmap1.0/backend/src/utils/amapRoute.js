/**
 * 高德 Web API 路径规划工具
 *
 * 调用高德 V5 驾车路径规划 API 获取真实道路路径坐标，
 * 替代线性插值生成车辆行驶路径。
 *
 * 环境变量:
 *   AMAP_KEY          高德 Web 服务 API Key（必填）
 *   AMAP_STRATEGY     路径规划策略，默认 0（速度优先）
 */

import fs from 'fs'
import path from 'path'

const AMAP_KEY = process.env.AMAP_KEY || '4bf282e07d4faf6337a82a21d755c796'
const API_URL = 'https://restapi.amap.com/v5/direction/driving'
const STRATEGY = process.env.AMAP_STRATEGY || '0'
const RATE_LIMIT_MS = 300

// 内存缓存，避免重复请求同一路线
const routeCache = new Map()

/**
 * 调用高德 V5 驾车路径规划，获取起点到终点的真实道路坐标
 * @param {number} originLat 起点纬度
 * @param {number} originLng 起点经度
 * @param {number} destLat   终点纬度
 * @param {number} destLng   终点经度
 * @returns {Promise<Array<{latitude: number, longitude: number}>>}
 */
export async function fetchAmapRoute(originLat, originLng, destLat, destLng) {
  const cacheKey = `${originLat.toFixed(6)},${originLng.toFixed(6)}-${destLat.toFixed(6)},${destLng.toFixed(6)}`

  if (routeCache.has(cacheKey)) {
    return routeCache.get(cacheKey)
  }

  const params = new URLSearchParams({
    key: AMAP_KEY,
    origin: `${originLng},${originLat}`,
    destination: `${destLng},${destLat}`,
    strategy: STRATEGY,
    show_fields: 'polyline',
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

  routeCache.set(cacheKey, points)
  return points
}

/**
 * 为所有路线定义批量获取高德真实路径
 * @param {Array} routeDefs 路线定义数组，每项含 id、name、waypoints（首尾为起终点坐标）
 * @returns {Promise<Map<number, Array>>} routeId -> path points 的映射，失败项为 null
 */
export async function fetchAllAmapRoutes(routeDefs) {
  const routePaths = new Map()
  let success = 0
  let fail = 0

  console.log('[AMap] 开始批量获取车辆路径规划数据...\n')

  for (const route of routeDefs) {
    const [startLat, startLng] = route.waypoints[0]
    const [endLat, endLng] = route.waypoints[route.waypoints.length - 1]

    process.stdout.write(`[${route.id}/${routeDefs.length}] ${route.name} ... `)

    try {
      const points = await fetchAmapRoute(startLat, startLng, endLat, endLng)
      routePaths.set(route.id, points)
      console.log(`✓ ${points.length} 个坐标点`)
      success++
    } catch (err) {
      console.log(`✗ ${err.message}`)
      routePaths.set(route.id, null) // 标记失败
      fail++
    }

    // API QPS 限流
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
  }

  console.log(`\n[AMap] 完成: ${success} 条成功, ${fail} 条失败`)
  return routePaths
}

/**
 * 将 AMap 路径点保存到 JSON 缓存文件
 * @param {string}            filePath    缓存文件路径
 * @param {Array}             routeDefs   路线定义
 * @param {Map<number, Array>} routePaths routeId -> points 的映射
 */
export function saveRouteCache(filePath, routeDefs, routePaths) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const data = {
    updatedAt: new Date().toISOString(),
    routes: routeDefs.map(r => ({
      id: r.id,
      name: r.name,
      start: r.start,
      end: r.end,
      points: routePaths.get(r.id) || [],
    })),
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  const count = data.routes.filter(r => r.points.length >= 2).length
  console.log(`[AMap] 路径缓存已保存: ${filePath} (${count}/${routeDefs.length} 条路线)`)
}

/**
 * 从 JSON 缓存文件加载 AMap 路径数据
 * @param {string} filePath 缓存文件路径
 * @returns {Map<number, Array>} routeId -> path points 的映射
 */
export function loadRouteCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Map()

    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)

    if (!data.routes || data.routes.length === 0) return new Map()

    const routePaths = new Map()
    for (const r of data.routes) {
      if (r.points && r.points.length >= 2) {
        routePaths.set(r.id, r.points)
      }
    }
    return routePaths
  } catch (err) {
    console.warn(`[AMap] 路径缓存加载失败: ${err.message}`)
    return new Map()
  }
}
