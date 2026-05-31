/**
 * RSU 部署方案 — 南京鼓楼区（仅沿车辆行驶路径部署）
 *
 * 部署策略:
 *   1. 沿6条高德地图车辆行驶路径每隔~500m部署RSU（基于高德API真实路径几何）
 *   2. RSU覆盖半径250m，同路线相邻RSU相切相连（间距=500m=2×半径）
 *   3. 跨路线去重阈值250m（=覆盖半径），仅消除真正重合的RSU，不同路线各保留独立RSU链
 *
 * 路径数据来源:
 *   data/route_paths.json — 由 fetchVehicleRoutes.mjs 从高德V5驾车路径规划API获取的真实路径shape坐标
 *   文件不存在时使用内置路线航点定义作为回退
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RSU_RADIUS_M = 250      // RSU 覆盖半径（米）
const RSU_SPACING_M = 500     // 沿路径部署间距（米），固定500m，同路线相邻RSU相切相连
const MIN_DIST_M = 250        // 跨路线去重阈值（米）=覆盖半径，仅消除真正重合的RSU

const REGION_THRESHOLDS = [32.065000, 32.050000] // 北区>=32.065, 中区>32.050, 南区<=32.050
const REGION_LATS = [32.072000, 32.058000, 32.046000]
const REGION_NAMES = ['北区-新模范马路走廊', '中区-北京西路走廊（核心区）', '南区-汉中路走廊']

// ========== 内置回退路线定义（route_paths.json 不可用时使用） ==========
const FALLBACK_ROUTES = [
  {
    id: 1, name: '古平岗→新庄',
    points: [
      [32.071239, 118.757977], [32.071279, 118.757972], [32.071500, 118.760000],
      [32.071800, 118.762000], [32.072000, 118.765000], [32.072500, 118.770000],
      [32.073000, 118.775000], [32.073500, 118.780000], [32.074000, 118.785000],
      [32.074500, 118.790000], [32.075000, 118.795000], [32.075500, 118.800000],
      [32.076000, 118.805000], [32.076777, 118.810340],
    ],
  },
  {
    id: 2, name: '草场门→九华山',
    points: [
      [32.060422, 118.755866], [32.060400, 118.756000], [32.060200, 118.758000],
      [32.060000, 118.762000], [32.060000, 118.766000], [32.060000, 118.770000],
      [32.059500, 118.774000], [32.059000, 118.778000], [32.058500, 118.782000],
      [32.058000, 118.785000], [32.057800, 118.790000], [32.057500, 118.795000],
      [32.057438, 118.805877],
    ],
  },
  {
    id: 3, name: '汉中门→西安门',
    points: [
      [32.042793354220926, 118.76708202719072], [32.042800, 118.768000], [32.042500, 118.775000],
      [32.042000, 118.779000], [32.041500, 118.783000], [32.041000, 118.790000],
      [32.040500, 118.798000], [32.040434898604204, 118.80425811526537],
    ],
  },
  {
    id: 4, name: '古平岗→汉中门',
    points: [
      [32.071239, 118.757977], [32.070000, 118.758000], [32.068000, 118.759000],
      [32.066000, 118.760000], [32.063000, 118.761000], [32.060000, 118.762000],
      [32.057000, 118.763000], [32.055000, 118.764000], [32.052000, 118.765000],
      [32.050000, 118.765000], [32.047000, 118.766000], [32.042793354220926, 118.76708202719072],
    ],
  },
  {
    id: 5, name: '新模范马路→新街口',
    points: [
      [32.079933, 118.784112], [32.078000, 118.784100], [32.075000, 118.784100],
      [32.072000, 118.784100], [32.070000, 118.784100], [32.067000, 118.784100],
      [32.065000, 118.784100], [32.062000, 118.784100], [32.060000, 118.784100],
      [32.057000, 118.784100], [32.055000, 118.784100], [32.052000, 118.784100],
      [32.050000, 118.784100], [32.047000, 118.784100], [32.045000, 118.784100],
      [32.041611, 118.784198],
    ],
  },
  {
    id: 6, name: '新庄→西安门',
    points: [
      [32.076777, 118.810340], [32.075000, 118.809500], [32.074000, 118.809000],
      [32.072000, 118.808500], [32.070000, 118.808000], [32.067000, 118.807500],
      [32.065000, 118.807000], [32.062000, 118.806500], [32.060000, 118.806000],
      [32.057000, 118.806000], [32.055000, 118.806000], [32.052000, 118.806000],
      [32.050000, 118.806000], [32.047000, 118.806000], [32.045000, 118.806000],
      [32.040434898604204, 118.80425811526537],
    ],
  },
]

// ========== 工具函数 ==========

function haversineDist(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function isFarEnough(lat, lng, points, minDist) {
  return points.every(p => haversineDist(lat, lng, p.lat, p.lng) >= minDist)
}

/**
 * 加载车辆行驶路径数据
 * 优先从 route_paths.json（高德API真实路径），回退到内置路线航点
 */
function loadRoutePaths() {
  const routesPath = path.resolve(__dirname, '../../data/route_paths.json')
  try {
    if (!fs.existsSync(routesPath)) {
      console.log('[rsuDeployment] route_paths.json 不存在，使用内置路线定义')
      return FALLBACK_ROUTES
    }
    const raw = fs.readFileSync(routesPath, 'utf-8')
    const data = JSON.parse(raw)
    if (!data.routes || data.routes.length === 0) {
      return FALLBACK_ROUTES
    }
    const routes = data.routes
      .filter(r => r.points && r.points.length >= 2)
      .map(r => ({
        id: r.id,
        name: r.name,
        points: r.points.map(p => [p.latitude, p.longitude]),
      }))
    if (routes.length > 0) {
      console.log(`[rsuDeployment] 已加载 ${routes.length} 条高德API车辆行驶路径数据`)
      return routes
    }
    return FALLBACK_ROUTES
  } catch (err) {
    console.warn(`[rsuDeployment] 路径加载失败，使用内置路线: ${err.message}`)
    return FALLBACK_ROUTES
  }
}

/**
 * 沿高德路径规划的道路经纬度，每隔500m生成RSU候选点
 * 使用累积 Haversine 距离在 polyline 上等距部署
 */
function generateRouteRSUPoints(routes) {
  const points = []

  for (const route of routes) {
    const pts = route.points
    const routeId = route.id
    if (pts.length < 2) continue

    // 计算累积距离（经纬度转米）
    const cumDist = [0]
    for (let i = 1; i < pts.length; i++) {
      cumDist.push(cumDist[i - 1] + haversineDist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
    }
    const totalLength = cumDist[pts.length - 1]
    const numSegments = Math.max(1, Math.round(totalLength / RSU_SPACING_M))

    for (let s = 0; s <= numSegments; s++) {
      if (numSegments === 0) break
      const targetDist = (s / numSegments) * totalLength

      // 查找目标距离所在的线段
      let segIdx = pts.length - 2
      for (let i = 1; i < pts.length; i++) {
        if (cumDist[i] >= targetDist) {
          segIdx = i - 1
          break
        }
      }

      const segLen = cumDist[segIdx + 1] - cumDist[segIdx]
      const t = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0
      const lat = pts[segIdx][0] + (pts[segIdx + 1][0] - pts[segIdx][0]) * t
      const lng = pts[segIdx][1] + (pts[segIdx + 1][1] - pts[segIdx][1]) * t

      const distFromStart = Math.round(targetDist)
      let ptName
      if (s === 0) ptName = `${route.name} 起点`
      else if (s >= numSegments) ptName = `${route.name} 终点`
      else ptName = `${route.name} (${distFromStart}m)`

      if (isFarEnough(lat, lng, points, MIN_DIST_M)) {
        points.push({ lat, lng, name: ptName, routeId })
      }
    }
  }

  return points
}

/**
 * 计算 RSU 部署方案（仅沿高德路径规划的道路经纬度部署）
 * @returns {{ intersections: Array, regionCounts: number[], regionNames: string[], regionLats: number[], totalRSU: number }}
 */
export function computeRSUDeployment() {
  const routes = loadRoutePaths()

  // 沿车辆行驶路径生成 RSU 点（每隔500m一个，覆盖半径250m，不重叠）
  const allPoints = generateRouteRSUPoints(routes)

  console.log(`[rsuDeployment] 沿路径生成RSU候选点: ${allPoints.length}`)

  // 按纬度分配到 3 个走廊区域
  const regions = [[], [], []]
  for (const pt of allPoints) {
    if (pt.lat >= REGION_THRESHOLDS[0]) regions[0].push(pt)
    else if (pt.lat > REGION_THRESHOLDS[1]) regions[1].push(pt)
    else regions[2].push(pt)
  }

  // 构建 intersections 格式
  let rsuId = 0
  const intersections = []

  for (let r = 0; r < 3; r++) {
    for (const pt of regions[r]) {
      rsuId++
      intersections.push({
        id: rsuId,
        latitude: pt.lat,
        longitude: pt.lng,
        name: pt.name,
        region: r + 1,
        routeId: pt.routeId || 1,
      })
    }
  }

  // 统计每条路线的RSU数量（通过RSU名称前缀匹配）
  const routeRsuCounts = {}
  for (const route of routes) {
    routeRsuCounts[route.name] = intersections.filter(r => r.name.startsWith(route.name)).length
  }

  const result = {
    intersections,
    regionCounts: regions.map(r => r.length),
    regionNames: REGION_NAMES,
    regionLats: REGION_LATS,
    totalRSU: intersections.length,
    routeRsuCounts,
  }

  console.log(`[rsuDeployment] 部署完成: ${result.totalRSU}个RSU, 区域分布: [${result.regionCounts.join(', ')}], 路线RSU数:`, routeRsuCounts)
  return result
}
