<template>
  <div class="statistics-panel">
    <!-- 面板标题 -->
    <div class="panel-header">
      <span class="panel-title">统计分析</span>
      <el-tag size="small" type="info" effect="plain">
        tick #{{ tick }}
      </el-tag>
    </div>

    <div v-if="!hasData" class="no-data">
      <el-icon :size="32" color="#C0C4CC"><DataAnalysis /></el-icon>
      <p>等待仿真数据...</p>
    </div>

    <template v-else>
      <!-- 1. 最大净效用 -->
      <div class="chart-section">
        <div class="chart-title">
          最大净效用 (MaxNetUtility)
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(maxNetUtilChart, '最大净效用')" />
        </div>
        <div ref="maxNetUtilChart" class="chart-container" style="height:220px"></div>
      </div>

      <div class="divider"></div>

      <!-- 2. 缓存利用率 -->
      <div class="chart-section" style="margin-top:12px">
        <div class="chart-title">
          缓存利用率
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(cacheUtilChart, '缓存利用率')" />
        </div>
        <div ref="cacheUtilChart" class="chart-container" style="height:220px"></div>
      </div>

      <div class="divider"></div>

      <!-- 3. RSU 负载均衡度 -->
      <div class="chart-section">
        <div class="chart-title">
          RSU 负载均衡度
          <el-button size="small" text :icon="Download" title="下载仪表盘" @click="downloadChart(balanceGaugeChart, '负载均衡度仪表盘')" />
          <el-button size="small" text :icon="Download" title="下载负载分布" @click="downloadChart(rsuBalanceBarChart, 'RSU负载分布')" style="margin-left:2px" />
        </div>
        <div class="balance-score-row">
          <div class="balance-gauge" ref="balanceGaugeChart" style="width:120px;height:120px"></div>
          <div class="balance-info">
            <div class="balance-score" :style="{ color: balanceColor }">
              {{ (rsuLoadBalance * 100).toFixed(1) }}%
            </div>
            <div class="balance-label">均衡度得分</div>
            <div class="balance-desc">{{ balanceDescription }}</div>
          </div>
        </div>
        <div ref="rsuBalanceBarChart" class="chart-container" style="height:200px;margin-top:8px"></div>
      </div>

      <div class="divider"></div>

      <!-- 4. 累积命中率曲线 -->
      <div class="chart-section">
        <div class="chart-title">
          累积命中率曲线
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(cumulativeHitChart, '累积命中率曲线')" />
        </div>
        <div ref="cumulativeHitChart" class="chart-container" style="height:240px"></div>
      </div>

      <div class="divider"></div>

      <!-- 5. 长/短路线命中趋势 -->
      <div class="chart-section">
        <div class="chart-title">
          路线长度 vs 命中率趋势
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(routeLengthChart, '路线长度vs命中率')" />
        </div>
        <div ref="routeLengthChart" class="chart-container" style="height:220px"></div>
      </div>

      <div class="divider"></div>

      <!-- 6. 车辆密度 vs 命中率 -->
      <div class="chart-section">
        <div class="chart-title">
          车辆密度 vs 命中率
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(densityHitChart, '车辆密度vs命中率')" />
        </div>
        <div ref="densityHitChart" class="chart-container" style="height:220px"></div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { DataAnalysis, Download } from '@element-plus/icons-vue'
import { generateRouteColors } from '../utils/routeColors'

// ========== 图表下载工具函数 ==========
function downloadChart(domRef, filename) {
  const dom = domRef.value || domRef
  if (!dom) return
  const instance = echarts.getInstanceByDom(dom)
  if (!instance) return
  const url = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' })
  const link = document.createElement('a')
  link.href = url
  link.download = filename + '.png'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const props = defineProps({
  data: {
    type: Object,
    default: null,
  },
  panelWidth: {
    type: Number,
    default: 320,
  },
})

// ========== 数据派生 ==========
const routes = computed(() => props.data?.routes || [])
const totalHitRate = computed(() => props.data?.totalHitRate || 0)
const rsuLoadBalance = computed(() => props.data?.rsuLoadBalance ?? 0)
const hitRateHistory = computed(() => props.data?.hitRateHistory || [])
const maxNetUtilityHistory = computed(() => props.data?.maxNetUtilityHistory || [])
const tick = computed(() => props.data?.tick ?? 0)
const hasData = computed(() => routes.value.length > 0)

// 持久化车辆密度数据（保留最后一次有效值，避免车辆消失后归零）
const persistedDensity = ref({})
watch(() => props.data?.routes, (newRoutes) => {
  if (!newRoutes) return
  for (const r of newRoutes) {
    const density = r.vehicleDensity || 0
    const hitRate = r.hitRate || 0
    const vc = r.vehicleCount || 0
    const prev = persistedDensity.value[r.id]

    if (density > 0 || vc > 0 || hitRate > 0) {
      // 有活数据：更新（密度用当前值或保底，命中率只升不降）
      persistedDensity.value[r.id] = {
        density: density > 0 ? density : (prev?.density || 0),
        hitRate: Math.max(hitRate, prev?.hitRate || 0),
        E: r.E,
        vehicleCount: vc || (prev?.vehicleCount || 0),
      }
    } else if (!prev) {
      // 首次初始化
      persistedDensity.value[r.id] = {
        density: density,
        hitRate: hitRate,
        E: r.E,
        vehicleCount: 0,
      }
    }
    // else: 车辆消失且已有历史数据 → 保留不变
  }
}, { deep: true, immediate: true })

// 路线颜色（从后端数据动态计算）
const routeColorMap = computed(() => {
  const ids = (props.data?.routes || []).map(r => r.id)
  return generateRouteColors(ids)
})

function routeColor(id) {
  return routeColorMap.value[id]?.body || '#909399'
}

// ========== 均衡度描述（颜色与仪表盘4段色域一致） ==========
// 仪表盘色域: [0, 0.3)红→[0.3, 0.6)橙→[0.6, 0.8)蓝→[0.8, 1]绿
const balanceColor = computed(() => {
  const v = rsuLoadBalance.value
  if (v >= 0.8) return '#67C23A'  // 绿色，对应仪表盘 [80%, 100%]
  if (v >= 0.6) return '#409EFF'  // 蓝色，对应仪表盘 [60%, 80%)
  if (v >= 0.3) return '#E6A23C'  // 橙色，对应仪表盘 [30%, 60%)
  return '#F56C6C'                // 红色，对应仪表盘 [0, 30%)
})

const balanceDescription = computed(() => {
  const v = rsuLoadBalance.value
  if (v >= 0.8) return '负载分布非常均衡'
  if (v >= 0.6) return '负载分布较为均衡'
  if (v >= 0.3) return '存在一定不均衡'
  return '负载分布差异较大'
})

// ========== Chart Refs ==========
const maxNetUtilChart = ref(null)
const cacheUtilChart = ref(null)
const balanceGaugeChart = ref(null)
const rsuBalanceBarChart = ref(null)
const cumulativeHitChart = ref(null)
const routeLengthChart = ref(null)
const densityHitChart = ref(null)

// ========== Chart 实例管理 ==========
const chartInstances = []

function registerChart(instance) {
  if (instance) chartInstances.push(instance)
}

function disposeAllCharts() {
  for (const c of chartInstances) {
    try { c.dispose() } catch (e) { /* ignore */ }
  }
  chartInstances.length = 0
}

function resizeAllCharts() {
  for (const c of chartInstances) {
    try { c.resize() } catch (e) { /* ignore */ }
  }
}

// ========== ECharts 通用主题 ==========
const baseGrid = { left: 8, right: 16, top: 8, bottom: 8, containLabel: true }
const baseTextStyle = { fontSize: 11, color: '#606266' }

function makeChart(domRef) {
  if (!domRef.value) return null
  const instance = echarts.init(domRef.value)
  registerChart(instance)
  return instance
}

// ========== 图表 1: 最大净效用 (快照) ==========
function renderMaxNetUtility() {
  const dom = maxNetUtilChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  const history = maxNetUtilityHistory.value
  if (history.length === 0) {
    chart.setOption({
      title: { text: '算法计算中…', left: 'center', top: 'center', textStyle: { fontSize: 12, color: '#C0C4CC' } },
    }, true)
    return
  }

  // 取最近一次算法运行的快照
  const latest = history[history.length - 1]
  const routeIds = Object.keys(latest.routes).map(Number)
  const names = routeIds.map(rid => {
    const rd = routes.value.find(r => r.id === rid)
    const raw = rd?.name || `路线${rid}`
    return raw.length > 6 ? raw.slice(0, 6) + '…' : raw
  })
  const values = routeIds.map(rid => latest.routes[rid] ?? 0)
  const colors = routeIds.map(rid => routeColor(rid))

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        const i = params[0]?.dataIndex
        const rid = routeIds[i]
        const rd = routes.value.find(r => r.id === rid)
        return `<b>路线 ${rid}: ${rd?.name || ''}</b><br/>
          ${params[0]?.marker} MaxNetUtility(Final): ${params[0]?.value.toFixed(2)}<br/>
          计算于 tick #${latest.tick}`
      },
    },
    grid: { ...baseGrid, top: 4, bottom: 4 },
    xAxis: {
      type: 'value',
      name: '净效用',
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9 },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { fontSize: 10 },
      axisTick: { show: false },
    },
    series: [
      {
        name: 'MaxNetUtility(Final)',
        type: 'bar',
        data: values.map((v, i) => ({
          value: v,
          itemStyle: { color: colors[i], borderRadius: [0, 4, 4, 0] },
        })),
        barMaxWidth: 14,
        label: {
          show: true,
          position: 'right',
          fontSize: 9,
          color: '#606266',
          formatter: p => p.value.toFixed(0),
        },
      },
    ],
  }, true)
}

// ========== 图表 2: 缓存利用率（竖向柱状图） ==========
function renderCacheUtilization() {
  const dom = cacheUtilChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  const names = routes.value.map(r => r.name.length > 6 ? r.name.slice(0, 6) + '…' : r.name)
  const utilRates = routes.value.map(r => (r.cacheUtilization || 0) * 100)
  const cachedCounts = routes.value.map(r => r.cachedCount || 0)
  const maxTiles = routes.value.map(r => r.maxTiles || 0)

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        const i = params[0]?.dataIndex
        return `<b>路线 ${routes.value[i]?.id}: ${routes.value[i]?.name}</b><br/>
          ${params[0]?.marker} 利用率: ${utilRates[i].toFixed(2)}%<br/>
          缓存块: ${cachedCounts[i]} / ${maxTiles[i]}`
      },
    },
    grid: { ...baseGrid, top: 16, bottom: 24, right: 8 },
    xAxis: {
      type: 'category',
      data: names,
      axisLabel: { fontSize: 9, rotate: 25 },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: '利用率 (%)',
      max: 100,
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9, formatter: '{value}%' },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    series: [
      {
        name: '缓存利用率',
        type: 'bar',
        data: utilRates.map((v, i) => ({
          value: v,
          itemStyle: {
            color: v >= 80 ? '#67C23A' : v >= 60 ? '#E6A23C' : '#F56C6C',
            borderRadius: [4, 4, 0, 0],
          },
        })),
        barMaxWidth: 24,
        label: {
          show: true,
          position: 'top',
          fontSize: 10,
          color: '#606266',
          formatter: (p) => p.value.toFixed(2) + '%',
        },
      },
    ],
  }, true)
}

// ========== 图表 3a: 负载均衡度仪表盘 ==========
function renderBalanceGauge() {
  const dom = balanceGaugeChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  const score = (rsuLoadBalance.value * 100).toFixed(1)

  chart.setOption({
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        center: ['50%', '55%'],
        radius: '85%',
        min: 0,
        max: 100,
        splitNumber: 5,
        axisLine: {
          show: true,
          lineStyle: {
            width: 12,
            color: [
              [0.3, '#F56C6C'],
              [0.6, '#E6A23C'],
              [0.8, '#409EFF'],
              [1, '#67C23A'],
            ],
          },
        },
        pointer: {
          length: '60%',
          width: 6,
          itemStyle: { color: 'auto' },
        },
        axisTick: { distance: -12, length: 6, lineStyle: { width: 1, color: '#999' } },
        splitLine: { distance: -16, length: 14, lineStyle: { width: 2, color: '#999' } },
        axisLabel: { distance: 18, fontSize: 8, color: '#999' },
        detail: {
          valueAnimation: true,
          formatter: '{value}%',
          fontSize: 16,
          fontWeight: 'bold',
          offsetCenter: [0, '70%'],
          color: '#303133',
        },
        data: [{ value: score, name: '均衡度' }],
      },
    ],
  }, true)
}

// ========== 图表 3b: 各路线 RSU 实时负载分布 ==========
function renderRsuBalanceBars() {
  const dom = rsuBalanceBarChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  // 为每条路线构建 per-RSU 实时车辆访问计数数据
  const routeNames = []
  const avgLoads = []
  const barColors = []
  const scatterData = []
  const errorData = []
  const legendNames = []

  for (const r of routes.value) {
    const rsus = (props.data?.rsus || []).filter(rsu => rsu.routeId === r.id)
    if (rsus.length === 0) continue

    const counts = rsus.map(rsu => rsu.realTimeVehicleCount ?? 0)
    if (counts.length === 0) continue

    const avg = counts.reduce((a, b) => a + b, 0) / counts.length
    const label = r.name.length > 6 ? r.name.slice(0, 6) + '…' : r.name

    routeNames.push(label)
    avgLoads.push(avg)
    barColors.push(routeColor(r.id))
    legendNames.push(r.name)

    for (const count of counts) {
      scatterData.push({
        value: [label, count],
        itemStyle: { color: routeColor(r.id), opacity: 0.5 },
        symbolSize: 5,
      })
    }

    errorData.push({
      value: [label, Math.min(...counts), Math.max(...counts)],
      itemStyle: { color: routeColor(r.id), opacity: 0.4 },
    })
  }

  chart.setOption({
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        if (params.seriesType === 'bar') {
          const idx = params.dataIndex
          const name = routes.value[idx]?.name || ''
          const avg = avgLoads[idx]
          return `<b>${name}</b><br/>平均访问车辆数: ${avg.toFixed(1)}`
        }
        if (params.seriesType === 'scatter') {
          return `<b>${params.value[0]}</b><br/>单个RSU访问车辆数: ${params.value[1]}`
        }
        return ''
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      textStyle: { fontSize: 9 },
      itemWidth: 14,
      itemHeight: 8,
      data: legendNames,
    },
    grid: { left: 20, right: 24, top: 36, bottom: 36, containLabel: true },
    xAxis: {
      type: 'category',
      data: routeNames,
      axisLabel: { fontSize: 9, rotate: 30, interval: 0 },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: '访问车辆数',
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 10, margin: 10 },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
      nameLocation: 'center',
      nameGap: 36,
    },
    series: [
      {
        name: '平均负载',
        type: 'bar',
        data: avgLoads.map((v, i) => ({
          value: v,
          itemStyle: { color: barColors[i], borderRadius: [4, 4, 0, 0] },
        })),
        barMaxWidth: 22,
        label: {
          show: true,
          position: 'top',
          fontSize: 9,
          color: '#606266',
          formatter: (p) => p.value.toFixed(1),
        },
      },
      {
        name: '各RSU负载',
        type: 'scatter',
        data: scatterData,
        symbolSize: 6,
        z: 2,
      },
      {
        name: '误差范围',
        type: 'custom',
        data: errorData,
        renderItem: function (params, api) {
          const categoryIndex = api.value(0)
          const low = api.value(1)
          const high = api.value(2)
          const x = api.coord([categoryIndex, low])[0]
          const yLow = api.coord([categoryIndex, low])[1]
          const yHigh = api.coord([categoryIndex, high])[1]
          return {
            type: 'group',
            children: [
              { type: 'line', shape: { x1: x, y1: yLow, x2: x, y2: yHigh },
                style: { stroke: api.visual('color'), lineWidth: 1.5 } },
              { type: 'line', shape: { x1: x - 6, y1: yHigh, x2: x + 6, y2: yHigh },
                style: { stroke: api.visual('color'), lineWidth: 1.5 } },
              { type: 'line', shape: { x1: x - 6, y1: yLow, x2: x + 6, y2: yLow },
                style: { stroke: api.visual('color'), lineWidth: 1.5 } },
            ],
          }
        },
        z: 1,
      },
    ],
  }, true)
}

// ========== 图表 4: 累积命中率曲线 ==========
function renderCumulativeHitRate() {
  const dom = cumulativeHitChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  const history = hitRateHistory.value
  if (history.length === 0) {
    chart.setOption({
      title: { text: '暂无历史数据', left: 'center', top: 'center', textStyle: { fontSize: 12, color: '#C0C4CC' } },
    }, true)
    return
  }

  const ticks = history.map(h => h.tick)
  const totalSeries = {
    name: '系统平均',
    type: 'line',
    data: history.map(h => (h.totalHitRate * 100).toFixed(2)),
    smooth: true,
    lineStyle: { width: 3, color: '#303133' },
    itemStyle: { color: '#303133' },
    symbol: 'none',
  }

  // 每条路线一条线
  const routeIds = [...new Set(history.flatMap(h => Object.keys(h.routes || {}).map(Number)))]
  const routeSeries = routeIds.map(rid => {
    const rd = routes.value.find(r => r.id === rid)
    return {
      name: rd?.name || `路线${rid}`,
      type: 'line',
      data: history.map(h => ((h.routes?.[rid] ?? 0) * 100).toFixed(2)),
      smooth: true,
      lineStyle: { width: 1.5, color: routeColor(rid), opacity: 0.7 },
      itemStyle: { color: routeColor(rid) },
      symbol: 'none',
    }
  })

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        let html = `<b>tick #${ticks[params[0]?.dataIndex]}</b><br/>`
        for (const p of params) {
          html += `${p.marker} ${p.seriesName}: ${p.value}%<br/>`
        }
        return html
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      textStyle: { fontSize: 9 },
      itemWidth: 14,
      itemHeight: 8,
      data: [totalSeries.name, ...routeSeries.map(s => s.name)],
    },
    grid: { ...baseGrid, top: 32, bottom: 4 },
    xAxis: {
      type: 'category',
      data: ticks,
      name: '时间片',
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9, interval: Math.max(1, Math.floor(ticks.length / 6)) },
    },
    yAxis: {
      type: 'value',
      name: '%',
      min: 0,
      max: 100,
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9, formatter: '{value}%' },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    series: [totalSeries, ...routeSeries],
  }, true)
}

// ========== 图表 5: 各路线随 RSU 数量增加的命中率趋势 ==========
function renderRouteLengthComparison() {
  const dom = routeLengthChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  // 优先使用实时逐RSU命中率（基于车辆采集），回退到算法模型 CHR_RSU
  const series = []
  const allRsuIndices = []

  for (const r of routes.value) {
    const rtRates = r.realTimeRsuHitRates || []
    const algoRates = r.chrRsu || []
    const useRates = rtRates.length > 0 ? rtRates : algoRates
    if (useRates.length === 0) continue

    // x 轴：RSU序号 (1, 2, 3, ...)
    const xData = useRates.map((_, i) => i + 1)
    for (const idx of xData) {
      if (!allRsuIndices.includes(idx)) allRsuIndices.push(idx)
    }

    series.push({
      name: r.name,
      type: 'line',
      data: useRates.map((v, i) => [i + 1, (v * 100).toFixed(1)]),
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      lineStyle: { width: 2, color: routeColor(r.id) },
      itemStyle: { color: routeColor(r.id) },
      emphasis: { focus: 'series' },
    })
  }

  // 按序号排序
  allRsuIndices.sort((a, b) => a - b)

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        let html = `<b>RSU #${params[0]?.axisValue}</b><br/>`
        for (const p of params) {
          html += `${p.marker} ${p.seriesName}: ${p.value[1]}%<br/>`
        }
        return html
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      textStyle: { fontSize: 9 },
      itemWidth: 14,
      itemHeight: 8,
      data: series.map(s => s.name),
    },
    grid: { ...baseGrid, top: 32, bottom: 4 },
    xAxis: {
      type: 'value',
      name: 'RSU序号',
      min: 1,
      max: Math.max(...allRsuIndices, 1),
      interval: 1,
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9 },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      nameTextStyle: { fontSize: 10, color: '#909399' },
      axisLabel: { fontSize: 9, formatter: '{value}%' },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    series: series,
  }, true)
}

// ========== 图表 6: 车辆密度 vs 命中率（使用持久化数据） ==========
function renderDensityVsHitRate() {
  const dom = densityHitChart.value
  if (!dom) return
  let chart = echarts.getInstanceByDom(dom)
  if (!chart) {
    chart = echarts.init(dom)
    registerChart(chart)
  }

  // 使用持久化数据，而非实时 routes（避免车辆消失后归零）
  const scatterData = routes.value.map(r => {
    const p = persistedDensity.value[r.id]
    const density = p?.density ?? r.vehicleDensity ?? 0
    const hitRate = p?.hitRate ?? r.hitRate
    const vCount = p?.vehicleCount ?? r.vehicleCount ?? 0
    return {
      value: [Number(density).toFixed(3), ((hitRate || 0) * 100).toFixed(1), r.name, r.E, vCount],
      name: r.name,
      itemStyle: {
        color: routeColor(r.id),
        shadowBlur: 8,
        shadowColor: routeColor(r.id) + '44',
      },
    }
  })

  chart.setOption({
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      extraCssText: 'z-index: 9999 !important;',
      formatter: (params) => {
        const [density, hitRate, name, E, vCount] = params.value
        return `<b>${name}</b><br/>
          车辆密度: ${density} 辆/RSU<br/>
          命中率: ${hitRate}%<br/>
          RSU数: ${E}<br/>
          车辆数: ${vCount}`
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      textStyle: { fontSize: 9 },
      itemWidth: 14,
      itemHeight: 8,
      data: scatterData.map(s => s.name),
    },
    grid: { left: 12, right: 20, top: 32, bottom: 16, containLabel: true },
    xAxis: {
      type: 'value',
      name: '车辆密度 (辆/RSU)',
      nameTextStyle: { fontSize: 10, color: '#909399' },
      nameLocation: 'center',
      nameGap: 24,
      axisLabel: { fontSize: 9 },
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
      min: (val) => Math.max(0, val.min - 0.5),
    },
    yAxis: {
      type: 'value',
      name: '(%)',
      nameTextStyle: { fontSize: 10, color: '#909399' },
      nameLocation: 'center',
      nameGap: 26,
      axisLabel: { fontSize: 9, formatter: '{value}%' },
      min: 0,
      max: 100,
      splitLine: { lineStyle: { type: 'dashed', color: '#eee' } },
    },
    series: [
      {
        type: 'scatter',
        data: scatterData,
        symbolSize: (val) => Math.max(18, Math.min(36, (val[4] || 5) * 5)),
        emphasis: {
          scale: 1.5,
          label: { show: true, formatter: '{b}', fontSize: 11, fontWeight: 'bold' },
        },
      },
    ],
  }, true)
}

// ========== 渲染所有图表 ==========
function renderAllCharts() {
  if (!hasData.value) return
  nextTick(() => {
    renderMaxNetUtility()
    renderCacheUtilization()
    renderBalanceGauge()
    renderRsuBalanceBars()
    renderCumulativeHitRate()
    renderRouteLengthComparison()
    renderDensityVsHitRate()
  })
}

// ========== 监听数据变化 ==========
watch(() => props.data, (newData) => {
  if (newData) renderAllCharts()
}, { deep: true })

// 侧边栏宽度变化时，延迟重绘所有图表以自适应
watch(() => props.panelWidth, () => {
  nextTick(() => {
    setTimeout(() => resizeAllCharts(), 50)
  })
})

// ========== 生命周期 ==========
let resizeTimer = null
onMounted(() => {
  renderAllCharts()
  resizeTimer = window.addEventListener('resize', () => {
    resizeAllCharts()
  })
})

onBeforeUnmount(() => {
  if (resizeTimer) window.removeEventListener('resize', resizeTimer)
  disposeAllCharts()
})
</script>

<style scoped>
.statistics-panel {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  font-weight: 600;
  font-size: 15px;
  color: #303133;
}

.no-data {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  color: #C0C4CC;
  gap: 12px;
}

.no-data p {
  margin: 0;
  font-size: 13px;
}

.chart-section {
  margin-bottom: 2px;
}

.chart-title {
  font-size: 12px;
  font-weight: 500;
  color: #606266;
  margin-bottom: 6px;
  padding-left: 4px;
  border-left: 3px solid #409EFF;
  display: flex;
  align-items: center;
  gap: 4px;
}

.chart-title .el-button {
  font-size: 13px;
  color: #909399;
}

.chart-title .el-button:hover {
  color: #409EFF;
}

.chart-container {
  width: 100%;
  min-height: 160px;
}

.divider {
  height: 1px;
  background: #ebeef5;
  margin: 12px 0;
}

/* 负载均衡度仪表盘 + 信息行 */
.balance-score-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.balance-info {
  flex: 1;
  text-align: center;
}

.balance-score {
  font-size: 28px;
  font-weight: 700;
  font-family: 'Courier New', monospace;
}

.balance-label {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
}

.balance-desc {
  font-size: 10px;
  color: #909399;
  margin-top: 4px;
}
</style>
