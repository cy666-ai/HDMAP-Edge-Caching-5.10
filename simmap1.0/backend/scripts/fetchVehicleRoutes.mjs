/**
 * fetchVehicleRoutes.mjs
 *
 * 从高德 V5 驾车路径规划 API 获取 6 条车辆行驶路线的真实道路坐标，
 * 保存到 data/route_paths.json 供 SimulationService 和 exportVehicleData 加载。
 *
 * 使用方式:
 *   AMAP_KEY=your_key node scripts/fetchVehicleRoutes.mjs
 *
 * 环境变量:
 *   AMAP_KEY          高德 Web 服务 API Key（必填）
 *   AMAP_STRATEGY     路径规划策略，默认 0（速度优先）
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { fetchAllAmapRoutes, saveRouteCache } from '../src/utils/amapRoute.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 6 条车辆路线的起终点（与 simulationService.js ROUTE_DEFS 一致）
const ROUTE_DEFS = [
  { id: 1, name: '古平岗→新庄',   start: '古平岗站', end: '新庄站',
    waypoints: [[32.071239453028696, 118.75797707525267], [32.076777001742040, 118.81034025020665]] },
  { id: 2, name: '草场门→九华山', start: '草场门站', end: '九华山站',
    waypoints: [[32.060421913675000, 118.75586611575406], [32.057438546125040, 118.80587678028652]] },
  { id: 3, name: '汉中门→西安门', start: '汉中门站', end: '西安门站',
    waypoints: [[32.042863325579320, 118.76711201979688], [32.040492177973746, 118.80596505656148]] },
  { id: 4, name: '古平岗→汉中门', start: '古平岗站', end: '汉中门站',
    waypoints: [[32.071239453028696, 118.75797707525267], [32.042863325579320, 118.76711201979688]] },
  { id: 5, name: '新模范马路→新街口', start: '新模范马路站', end: '新街口站',
    waypoints: [[32.079932709933416, 118.78411162470866], [32.041611022106075, 118.78419797766223]] },
  { id: 6, name: '新庄→西安门',   start: '新庄站', end: '西安门站',
    waypoints: [[32.076777001742040, 118.81034025020665], [32.040492177973746, 118.80596505656148]] },
]

async function main() {
  const outputDir = path.resolve(__dirname, '..', 'data')
  const outputPath = path.join(outputDir, 'route_paths.json')

  console.log('========================================')
  console.log('  高德 API 车辆路径规划数据获取')
  console.log('========================================\n')

  const routePaths = await fetchAllAmapRoutes(ROUTE_DEFS)
  saveRouteCache(outputPath, ROUTE_DEFS, routePaths)

  // 统计
  let totalPoints = 0
  let successCount = 0
  for (const [id, points] of routePaths) {
    if (points) {
      totalPoints += points.length
      successCount++
    }
  }
  console.log(`\n总计: ${successCount} 条路线成功, ${totalPoints} 个路径坐标点`)
  console.log(`输出: ${outputPath}`)
}

main().catch(err => {
  console.error(`\n脚本异常: ${err.message}`)
  process.exit(1)
})
