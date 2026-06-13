/**
 * 路线配置持久化模块
 *
 * 将路线定义集中管理于 data/route_config.json，作为系统唯一数据源。
 * 首次启动时自动从内置默认路线生成配置文件。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const CONFIG_FILE = path.join(DATA_DIR, 'route_config.json')

/** 内置默认 6 条路线（仅用于首次初始化） */
export function getDefaultRoutes() {
  return [
    {
      id: 1, name: '古平岗→新庄', start: '古平岗站', end: '新庄站',
      waypoints: [
        [32.07102955609951, 118.7571970943238],
        [32.072000000000000, 118.76500000000000],
        [32.073000000000000, 118.77500000000000],
        [32.074000000000000, 118.78500000000000],
        [32.075000000000000, 118.79500000000000],
        [32.076387129198740, 118.80417158810707],
      ],
    },
    {
      id: 2, name: '草场门→九华山', start: '草场门站', end: '九华山站',
      waypoints: [
        [32.060421913675000, 118.75586611575406],
        [32.060000000000000, 118.76200000000000],
        [32.060000000000000, 118.77000000000000],
        [32.059000000000000, 118.77800000000000],
        [32.058000000000000, 118.78500000000000],
        [32.057500000000000, 118.79500000000000],
        [32.057438546125040, 118.80587678028652],
      ],
    },
    {
      id: 3, name: '汉中门→西安门', start: '汉中门站', end: '西安门站',
      waypoints: [
        [32.042793354220926, 118.76708202719072],
        [32.042500000000000, 118.77500000000000],
        [32.041500000000000, 118.78300000000000],
        [32.041000000000000, 118.79000000000000],
        [32.040500000000000, 118.79800000000000],
        [32.040434898604204, 118.80425811526537],
      ],
    },
    {
      id: 4, name: '古平岗→汉中门', start: '古平岗站', end: '汉中门站',
      waypoints: [
        [32.07102955609951, 118.7571970943238],
        [32.066000000000000, 118.76000000000000],
        [32.060000000000000, 118.76200000000000],
        [32.055000000000000, 118.76400000000000],
        [32.050000000000000, 118.76500000000000],
        [32.042793354220926, 118.76708202719072],
      ],
    },
    {
      id: 5, name: '新模范马路→新街口', start: '新模范马路站', end: '新街口站',
      waypoints: [
        [32.079932709933416, 118.78411162470866],
        [32.075000000000000, 118.78410000000000],
        [32.070000000000000, 118.78410000000000],
        [32.065000000000000, 118.78410000000000],
        [32.060000000000000, 118.78410000000000],
        [32.055000000000000, 118.78410000000000],
        [32.050000000000000, 118.78410000000000],
        [32.045000000000000, 118.78410000000000],
        [32.041611022106075, 118.78419797766223],
      ],
    },
    {
      id: 6, name: '新庄→西安门', start: '新庄站', end: '西安门站',
      waypoints: [
        [32.076387129198740, 118.80417158810707],
        [32.074000000000000, 118.80900000000000],
        [32.070000000000000, 118.80800000000000],
        [32.065000000000000, 118.80700000000000],
        [32.060000000000000, 118.80600000000000],
        [32.055000000000000, 118.80600000000000],
        [32.050000000000000, 118.80600000000000],
        [32.040434898604204, 118.80425811526537],
      ],
    },
  ]
}

/**
 * 确保数据目录存在
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

/**
 * 加载路线配置 — 每次服务器启动时始终从 6 条内置默认路线重新生成，
 * 确保路线定义和航点永不漂移。
 * @returns {{ nextId: number, defaultVehicleCount: number, routes: Array }}
 */
export function loadRouteConfig() {
  ensureDataDir()

  // 始终使用内置默认路线重新生成配置，保证每次初始化都是这 6 条路线
  const defaults = getDefaultRoutes()
  const maxId = defaults.reduce((m, r) => Math.max(m, r.id), 0)
  const config = {
    nextId: maxId + 1,
    defaultVehicleCount: 5,
    updatedAt: new Date().toISOString(),
    routes: defaults.map(r => ({ ...r })),  // shallow clone
  }

  // 若已有配置文件，保留 nextId 使其不低于默认值（避免已删除 ID 被重用）
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
      if (existing.nextId && existing.nextId > config.nextId) {
        config.nextId = existing.nextId
      }
    }
  } catch (_) { /* 忽略读取错误 */ }

  saveRouteConfig(config)
  console.log(`[routeConfig] 已加载 ${config.routes.length} 条默认路线, nextId=${config.nextId}`)
  return config
}

/**
 * 保存路线配置到磁盘（原子写入）
 * @param {{ nextId, defaultVehicleCount, routes }} config
 */
export function saveRouteConfig(config) {
  ensureDataDir()
  config.updatedAt = new Date().toISOString()
  const tmp = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmp, CONFIG_FILE)
}
