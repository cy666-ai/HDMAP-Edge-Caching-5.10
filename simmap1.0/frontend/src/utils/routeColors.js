/**
 * 路线动态颜色生成器
 *
 * 12色调色板，按路线 ID 排序索引分配颜色。
 * 颜色 1-6 与旧版硬编码值完全一致，保证向后兼容。
 * 未知 ID 返回灰色 (#909399)。
 */

const PALETTE = [
  { body: '#409EFF', stroke: '#2c6db5', window: '#8ac4ff' },  // 蓝
  { body: '#E6A23C', stroke: '#b8821f', window: '#f0c78a' },  // 橙
  { body: '#67C23A', stroke: '#4a9e2a', window: '#95d475' },  // 绿
  { body: '#F56C6C', stroke: '#c04040', window: '#f8a0a0' },  // 红
  { body: '#9B59B6', stroke: '#7d3c98', window: '#c39bd3' },  // 紫
  { body: '#1ABC9C', stroke: '#148f77', window: '#76d7c4' },  // 青绿
  // 扩展调色板（路线 7+，每条与前面色系明显区分）
  { body: '#E74C3C', stroke: '#b03a2e', window: '#f1948a' },  // 朱红
  { body: '#2ECC71', stroke: '#27ae60', window: '#82e0aa' },  // 翠绿
  { body: '#F39C12', stroke: '#c27a0e', window: '#f7c46c' },  // 金橙
  { body: '#8E44AD', stroke: '#6c3483', window: '#bb8fce' },  // 深紫
  { body: '#16A085', stroke: '#0e7c65', window: '#72d2bd' },  // 墨绿
  { body: '#D35400', stroke: '#a04000', window: '#edbb99' },  // 深橙
]

/**
 * 根据路线 ID 列表生成颜色映射
 *
 * 使用 ID 直接映射到调色板索引，而非排序后按位置分配。
 * 这样每条路线的颜色由其 ID 唯一决定，删除/添加其他路线不会
 * 导致已有路线的颜色变化。ID 单调递增且永不重用。
 *
 * @param {number[]} routeIds - 路线 ID 数组
 * @returns {{ [id: number]: { body: string, stroke: string, window: string } }}
 */
export function generateRouteColors(routeIds) {
  const colors = {}
  const uniqueIds = [...new Set(routeIds)]
  uniqueIds.forEach((id) => {
    // ID 从 1 开始，直接映射到调色板 (id-1) 确保 Route 1→颜色0, Route 2→颜色1, ...
    colors[id] = PALETTE[(id - 1) % PALETTE.length]
  })
  return colors
}

/**
 * 根据颜色映射获取路线的 body 色值
 * @param {{ [id: number]: { body: string } }} colors
 * @param {number} routeId
 * @returns {string}
 */
export function getRouteHexColor(colors, routeId) {
  return colors[routeId]?.body || '#909399'
}
