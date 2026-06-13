<template>
  <div class="comparison-panel">
    <!-- 面板标题 -->
    <div class="panel-header">
      <span class="panel-title">对比分析</span>
      <el-tag v-if="comparisonData" size="small" type="success" effect="plain">
        {{ comparisonData.timestamp }}
      </el-tag>
    </div>

    <!-- 运行按钮 -->
    <div class="action-row">
      <el-button
        type="primary"
        :loading="loading"
        :icon="TrendCharts"
        @click="runComparison"
      >
        {{ loading ? '分析中...' : '运行对比' }}
      </el-button>
      <span v-if="error" class="error-text">{{ error }}</span>
    </div>

    <!-- 图表区域 -->
    <template v-if="comparisonData">
      <!-- 图1: 命中率对比 -->
      <div class="chart-section">
        <div class="chart-title">
          命中率对比
          <span class="chart-subtitle">（速度：{{ currentSpeed }} km/h）</span>
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(0, '命中率对比')" />
        </div>
        <div :ref="el => chartRefs[0] = el" class="chart-container"></div>
      </div>

      <!-- 图2: 计算耗时对比 -->
      <div class="chart-section">
        <div class="chart-title">
          计算耗时对比
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(1, '计算耗时对比')" />
        </div>
        <div :ref="el => chartRefs[1] = el" class="chart-container"></div>
      </div>

      <!-- 图3: 绝对命中/请求数对比 -->
      <div class="chart-section">
        <div class="chart-title">
          绝对命中 / 请求数对比
          <el-button size="small" text :icon="Download" title="下载图表" @click="downloadChart(2, '绝对命中请求数对比')" />
        </div>
        <div :ref="el => chartRefs[2] = el" class="chart-container"></div>
      </div>

      <!-- 数据表格 -->
      <div class="table-section">
        <div class="chart-title">详细数据</div>
        <el-table :data="tableData" size="small" stripe border>
          <el-table-column prop="routeName" label="路线" min-width="110" fixed />
          <el-table-column prop="E" label="RSU" width="55" align="center" />
          <el-table-column v-for="m in METHOD_NAMES" :key="m" :label="m" min-width="130" align="center">
            <template #default="{ row }">
              <div class="cell-method">
                <span class="method-val" :class="m.toLowerCase()">{{ (row[m]?.CHR_Total * 100).toFixed(1) }}%</span>
                <span class="cell-sub">{{ row[m]?.elapsed_ms?.toFixed(0) ?? '—' }}ms</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 图例说明 -->
      <div class="legend-section">
        <div class="chart-title">算法说明</div>
        <div class="legend-list">
          <div class="legend-item"><span class="dot mwc-bg"></span><strong>MWC</strong> 最大权重闭包</div>
          <div class="legend-item"><span class="dot mpc-bg"></span><strong>MPC</strong> 最流行缓存</div>
          <div class="legend-item"><span class="dot map-bg"></span><strong>MAP</strong> 移动感知概率缓存</div>
          <div class="legend-item"><span class="dot trwc-bg"></span><strong>TRWC</strong> 轨迹中继缓存</div>
          <div class="legend-item"><span class="dot mamab-bg"></span><strong>MAMAB</strong> 多臂老虎机在线学习</div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { TrendCharts, Download } from '@element-plus/icons-vue'
import socketService from '../services/socket'

const props = defineProps({
  rsuData: { type: Object, default: null },
  panelWidth: { type: Number, default: 320 },
})

const loading = ref(false)
const error = ref('')
const comparisonData = ref(null)
const chartRefs = ref([])
let chartInstances = []

const METHOD_NAMES = ['MWC', 'MPC', 'MAP', 'TRWC', 'MAMAB']

const METHOD_COLORS = {
  MWC: '#5470C6',
  MPC: '#91CC75',
  MAP: '#FAC858',
  TRWC: '#EE6666',
  MAMAB: '#73C0DE',
}

const currentSpeed = computed(() => {
  const routes = props.rsuData?.routes
  if (!routes || routes.length === 0) return 35
  return routes[0]?.speedKmh ?? 35
})

// Adapt to new format (method dict) or old format (flat number)
function getCHR(method) {
  return typeof method === 'object' ? method.CHR_Total : method
}

const tableData = computed(() => {
  if (!comparisonData.value?.routes) return []
  return comparisonData.value.routes.map(r => ({
    routeName: r.routeName,
    E: r.E,
    MWC: r.methods.MWC,
    MPC: r.methods.MPC,
    MAP: r.methods.MAP,
    TRWC: r.methods.TRWC,
    MAMAB: r.methods.MAMAB,
  }))
})

function runComparison() {
  loading.value = true
  error.value = ''
  comparisonData.value = null
  socketService.emit('comparison:run')
}

function onComparisonResult(result) {
  loading.value = false
  if (result.success) {
    comparisonData.value = result.data
    error.value = ''
    nextTick(() => renderAllCharts())
  } else {
    error.value = result.error || '对比分析失败'
  }
}

function getRoutesData() {
  return comparisonData.value?.routes || []
}

function makeSeries(dataKey, labelFormatter, valueKey) {
  return METHOD_NAMES.map(method => ({
    name: method,
    type: 'bar',
    data: getRoutesData().map(r => {
      const m = r.methods[method]
      if (!m) return 0
      return +(valueKey ? m[valueKey] : (typeof m === 'object' ? m[dataKey] : m))
    }),
    itemStyle: {
      color: METHOD_COLORS[method],
      borderRadius: [3, 3, 0, 0],
    },
    barGap: '10%',
    label: {
      show: true,
      position: 'top',
      fontSize: 9,
      formatter: p => labelFormatter ? labelFormatter(p.value) : p.value.toFixed(1),
    },
    emphasis: {
      itemStyle: {
        color: METHOD_COLORS[method],
        shadowBlur: 8,
        shadowOffsetX: 0,
        shadowColor: 'rgba(0,0,0,0.3)',
      },
    },
  }))
}

function commonTooltipFormatter(params) {
  let html = `<strong>${params[0].axisValue}</strong><br/>`
  params.forEach(p => {
    html += `${p.marker} ${p.seriesName}: <strong>${p.value}</strong><br/>`
  })
  return html
}

function makeOption(title, series, yAxisName, yFormatter) {
  const routeNames = getRoutesData().map(r => r.routeName)
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      appendToBody: true,
      zIndex: 9999,
      formatter: commonTooltipFormatter,
    },
    legend: {
      data: METHOD_NAMES,
      bottom: 0,
      textStyle: { fontSize: 10 },
    },
    grid: {
      left: '10%',
      right: '4%',
      top: '12%',
      bottom: '18%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: routeNames,
      axisLabel: {
        rotate: 25,
        fontSize: 9,
        interval: 0,
        formatter: (v) => v.length > 6 ? v.slice(0, 6) + '...' : v,
      },
    },
    yAxis: {
      type: 'value',
      name: yAxisName,
      nameGap: 8,
      axisLabel: yFormatter ? { formatter: yFormatter } : undefined,
    },
    series,
  }
}

function renderAllCharts() {
  // Dispose old instances
  chartInstances.forEach(c => c?.dispose())
  chartInstances = []

  const routes = getRoutesData()
  if (!routes.length) return

  const containers = chartRefs.value
  if (!containers || containers.length < 3) return

  // ---- Chart 1: CHR_Total (convert 0-1 to 0-100%) ----
  const chrSeries = makeSeries('CHR_Total', v => v.toFixed(1) + '%')
  // Override data to multiply by 100 for percent scale
  chrSeries.forEach(s => {
    s.data = s.data.map(v => +(v * 100).toFixed(1))
    s.label.formatter = p => p.value.toFixed(1) + '%'
  })
  const chrOption = makeOption('命中率对比', chrSeries, '命中率 (%)', '{value}%')
  chrOption.yAxis.min = 0
  chrOption.yAxis.max = 100
  initChart(0, containers[0], chrOption)

  // ---- Chart 2: Elapsed Time ----
  const timeSeries = makeSeries('elapsed_ms', v => v.toFixed(0) + 'ms', 'elapsed_ms')
  const timeOption = makeOption('计算耗时对比', timeSeries, '耗时 (ms)')
  initChart(1, containers[1], timeOption)

  // ---- Chart 3: Absolute Hits & Requests (twin bars) ----
  const hitSeries = METHOD_NAMES.map(method => ({
    name: method + ' 命中',
    type: 'bar',
    data: getRoutesData().map(r => {
      const m = r.methods[method]
      return m ? +(m.Total_Hit || 0).toFixed(1) : 0
    }),
    itemStyle: { color: METHOD_COLORS[method], borderRadius: [3, 3, 0, 0] },
    barGap: '10%',
    label: { show: true, position: 'top', fontSize: 8 },
    emphasis: {
      itemStyle: {
        color: METHOD_COLORS[method],
        shadowBlur: 8,
        shadowOffsetX: 0,
        shadowColor: 'rgba(0,0,0,0.3)',
      },
    },
  }))
  const reqSeries = METHOD_NAMES.map(method => ({
    name: method + ' 请求',
    type: 'bar',
    data: getRoutesData().map(r => {
      const m = r.methods[method]
      return m ? +(m.Total_Req || 0).toFixed(1) : 0
    }),
    itemStyle: {
      color: METHOD_COLORS[method],
      opacity: 0.35,
      borderRadius: [3, 3, 0, 0],
    },
    barGap: '10%',
    label: { show: false },
  }))

  const absOption = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      appendToBody: true,
      zIndex: 9999,
      formatter: (params) => {
        let html = `<strong>${params[0].axisValue}</strong><br/>`
        params.forEach(p => {
          html += `${p.marker} ${p.seriesName}: <strong>${p.value.toFixed(1)}</strong><br/>`
        })
        return html
      },
    },
    legend: {
      data: [...hitSeries.map(s => s.name), ...reqSeries.map(s => s.name)],
      bottom: 0,
      textStyle: { fontSize: 9 },
      type: 'scroll',
    },
    grid: {
      left: '10%',
      right: '4%',
      top: '12%',
      bottom: '20%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: getRoutesData().map(r => r.routeName),
      axisLabel: {
        rotate: 25,
        fontSize: 9,
        interval: 0,
        formatter: (v) => v.length > 6 ? v.slice(0, 6) + '...' : v,
      },
    },
    yAxis: {
      type: 'value',
      name: '数量',
    },
    series: [...hitSeries, ...reqSeries],
  }

  initChart(2, containers[2], absOption)
}

function initChart(index, dom, option) {
  const instance = echarts.init(dom)
  instance.setOption(option)
  chartInstances[index] = instance
}

function downloadChart(index, filename) {
  const instance = chartInstances[index]
  if (!instance) return
  const url = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' })
  const link = document.createElement('a')
  link.href = url
  link.download = filename + '.png'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// Resize all charts when panel width changes
watch(() => props.panelWidth, () => {
  nextTick(() => {
    setTimeout(() => {
      chartInstances.forEach(c => c?.resize())
    }, 50)
  })
})

onMounted(() => {
  socketService.on('comparison:result', onComparisonResult)
})

onBeforeUnmount(() => {
  socketService.off('comparison:result')
  chartInstances.forEach(c => c?.dispose())
  chartInstances = []
})
</script>

<style scoped>
.comparison-panel {
  padding: 8px 4px 16px 4px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.error-text {
  color: #F56C6C;
  font-size: 12px;
}

.chart-section {
  margin-top: 12px;
}

.chart-title {
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 4px;
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

.chart-subtitle {
  font-weight: 400;
  font-size: 11px;
  color: #909399;
}

.chart-container {
  width: 100%;
  height: 260px;
}

.table-section {
  margin-top: 16px;
}

.table-section .chart-title {
  margin-bottom: 8px;
}

.cell-method {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.method-val {
  font-weight: 600;
  font-size: 12px;
}

.method-val.mwc { color: #5470C6; }
.method-val.mpc { color: #91CC75; }
.method-val.map { color: #FAC858; }
.method-val.trwc { color: #EE6666; }
.method-val.mamab { color: #73C0DE; }

.cell-sub {
  font-size: 10px;
  color: #909399;
}

.legend-section {
  margin-top: 16px;
}

.legend-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
}

.legend-item {
  font-size: 11px;
  color: #606266;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-top: 0;
  flex-shrink: 0;
}

.mwc-bg   { background: #5470C6; }
.mpc-bg   { background: #91CC75; }
.map-bg   { background: #FAC858; }
.trwc-bg  { background: #EE6666; }
.mamab-bg { background: #73C0DE; }
</style>
