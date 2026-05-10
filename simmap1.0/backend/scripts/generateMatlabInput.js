/**
 * generateMatlabInput.js
 *
 * 生成 _vehicle_input.json 供 MATLAB HM_Export_CacheDecision.m 使用。
 * 在没有启动后端的情况下，可以独立运行此脚本生成默认输入数据。
 *
 * 用法:
 *   node scripts/generateMatlabInput.js
 *   matlab -batch "HM_Export_CacheDecision"
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')

// 默认算法参数（与 5.10/HM_Sim_Main_Nanjing.m 一致）
const DEFAULT_INPUT = {
  Prob_Route: [0.95, 0.725, 0.5],
  algorithmParams: {
    E: 3,
    X: 150,
    alpha: 0.8,
    Capacity_Scale: 1.2,
    allowed_layers_per_block: [3, 4, 4],
    layer_profit_ranges: {
      Raw: [25, 35],
      Geo: [15, 25],
      Sem: [8, 15],
      Dyn: [-5, 5],
    },
  },
  regionCounts: [2, 2, 1],
  vehicleCount: 5,
  timestamp: new Date().toISOString(),
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  const outputPath = path.join(DATA_DIR, '_vehicle_input.json')
  fs.writeFileSync(outputPath, JSON.stringify(DEFAULT_INPUT, null, 2), 'utf-8')
  console.log(`[generate] 已写入: ${outputPath}`)
  console.log(`[generate] Prob_Route: [${DEFAULT_INPUT.Prob_Route.join(', ')}]`)
  console.log(`[generate] 算法参数: E=${DEFAULT_INPUT.algorithmParams.E}, X=${DEFAULT_INPUT.algorithmParams.X}`)
  console.log('')
  console.log('现在可以运行 MATLAB:')
  console.log('  cd 5.10/')
  console.log('  matlab -batch "HM_Export_CacheDecision"')
}

main()
