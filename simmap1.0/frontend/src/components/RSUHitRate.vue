<template>
  <div class="rsu-hitrate">
    <div class="panel-header">
      <span class="panel-title">缓存命中完成率</span>
      <el-tag size="small" :type="matlabStatusType" effect="plain">
        {{ matlabStatusText }}
      </el-tag>
    </div>

    <!-- 总命中率 -->
    <div class="total-hitrate">
      <div class="total-label">总命中率</div>
      <div class="total-value" :class="{ 'is-zero': totalHitRate === 0 }">
        {{ (totalHitRate * 100).toFixed(2) }}%
      </div>
      <el-progress
        :percentage="Math.round(totalHitRate * 100)"
        :color="hitRateColor(totalHitRate)"
        :stroke-width="16"
        :show-text="false"
      />
    </div>

    <div class="divider"></div>

    <!-- 各路线命中率 -->
    <div class="section-title">各路线详情</div>
    <div
      v-for="route in routes"
      :key="route.id"
      class="route-item"
    >
      <div class="route-header">
        <span class="route-name">
          <span class="route-dot" :style="{ background: routeColor(route.id) }"></span>
          {{ route.name }}
        </span>
        <span class="route-vehicles">{{ route.vehicleCount }} 辆车</span>
      </div>
      <div class="route-stats">
        <div class="stat-row">
          <span class="stat-label">完成率</span>
          <span class="stat-value">{{ (route.hitRate * 100).toFixed(1) }}%</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">命中块数</span>
          <span class="stat-value">{{ route.totalChunks }} 块</span>
        </div>
        <el-progress
          :percentage="Math.round(route.hitRate * 100)"
          :color="hitRateColor(route.hitRate)"
          :stroke-width="12"
          :show-text="false"
        />
      </div>
    </div>

    <!-- 算法对比 -->
    <template v-if="algorithmResults">
      <div class="divider"></div>
      <div class="section-title">算法对比</div>
      <div class="algo-list">
        <div
          v-for="algo in algorithmList"
          :key="algo.name"
          class="algo-item"
          :class="{ 'is-best': algo.isBest }"
        >
          <div class="algo-header">
            <span class="algo-name">{{ algo.name }}</span>
            <span v-if="algo.isBest" class="algo-badge">最优</span>
          </div>
          <div class="algo-bar-wrapper">
            <div
              class="algo-bar"
              :style="{ width: (algo.value * 100) + '%', background: algo.color }"
            ></div>
          </div>
          <span class="algo-value">{{ (algo.value * 100).toFixed(2) }}%</span>
        </div>
      </div>
    </template>

    <!-- 瓦片分布统计 -->
    <template v-if="tileStats && tileStats.totalTiles > 0">
      <div class="divider"></div>
      <div class="section-title">瓦片分布</div>
      <div class="tile-summary">
        <div class="tile-stat-item">
          <div class="tile-stat-label">系统瓦片数</div>
          <div class="tile-stat-value">{{ tileStats.totalTiles }}</div>
        </div>
        <div class="tile-stat-item">
          <div class="tile-stat-label">副本总数</div>
          <div class="tile-stat-value">{{ tileStats.totalCopies }}</div>
        </div>
        <div class="tile-stat-item">
          <div class="tile-stat-label">活跃 RSU</div>
          <div class="tile-stat-value">{{ tileStats.activeRSUs }}</div>
        </div>
      </div>
      <!-- 热门瓦片 Top 8 -->
      <div v-if="topTiles.length > 0" class="top-tiles">
        <div class="tile-subtitle">热门瓦片 (Top 8)</div>
        <div class="tile-bar-list">
          <div v-for="(item, idx) in topTiles" :key="item.id" class="tile-bar-row">
            <span class="tile-rank">{{ idx + 1 }}</span>
            <span class="tile-bar-label">#{{ item.id }}</span>
            <div class="tile-bar-track">
              <div
                class="tile-bar-fill"
                :style="{ width: (item.pct * 100).toFixed(1) + '%', background: tileBarColor(item.pct) }"
              ></div>
            </div>
            <span class="tile-bar-count">{{ item.count }}x</span>
          </div>
        </div>
      </div>
    </template>

    <!-- 底部操作 -->
    <div class="divider"></div>
    <div class="action-row">
      <el-button
        type="primary"
        size="small"
        :loading="matlabRunning"
        :disabled="matlabRunning"
        @click="recalc"
        round
      >
        {{ matlabRunning ? '计算中...' : '重新计算' }}
      </el-button>
      <span class="last-run" v-if="lastMatlabRun">
        上次: {{ formatTime(lastMatlabRun) }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import socketService from '../services/socket'

const props = defineProps({
  data: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['recalc'])

const totalHitRate = computed(() => props.data?.totalHitRate || 0)

const routes = computed(() => props.data?.routes || [])

const algorithmResults = computed(() => props.data?.algorithmResults || null)

const tileStats = computed(() => props.data?.tileStats || null)

const rsuChunks = computed(() => props.data?.rsuChunks || [])

const topTiles = computed(() => {
  const chunks = rsuChunks.value
  if (!chunks || chunks.length === 0) return []

  // 统计每个瓦片被多少个 RSU 存储
  const freq = {}
  for (const tiles of chunks) {
    for (const tileId of tiles) {
      freq[tileId] = (freq[tileId] || 0) + 1
    }
  }

  // 按频次降序排列取前 8
  const sorted = Object.entries(freq)
    .map(([id, count]) => ({ id: Number(id), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const maxCount = sorted.length > 0 ? sorted[0].count : 1
  return sorted.map(item => ({ ...item, pct: item.count / maxCount }))
})

const matlabRunning = computed(() => props.data?.matlabRunning || false)

const lastMatlabRun = computed(() => props.data?.lastMatlabRun || null)

const matlabStatusType = computed(() => {
  if (props.data?.matlabError) return 'danger'
  if (matlabRunning.value) return 'warning'
  return props.data?.lastMatlabRun ? 'success' : 'info'
})

const matlabStatusText = computed(() => {
  if (props.data?.matlabError) return '算法错误'
  if (matlabRunning.value) return '计算中'
  return props.data?.lastMatlabRun ? '已就绪' : '未计算'
})

const algorithmList = computed(() => {
  const results = algorithmResults.value
  if (!results) return []

  const algos = [
    { name: 'MWC',  key: 'MWC',  color: '#409EFF', value: results.MWC || 0 },
    { name: 'MPC',  key: 'MPC',  color: '#909399', value: results.MPC || 0 },
    { name: 'MAP',  key: 'MAP',  color: '#E6A23C', value: results.MAP || 0 },
    { name: 'TRWC', key: 'TRWC', color: '#67C23A', value: results.TRWC || 0 },
  ]

  const best = Math.max(...algos.map(a => a.value))
  return algos.map(a => ({ ...a, isBest: a.value === best }))
})

function hitRateColor(rate) {
  if (rate > 0.7) return '#67C23A'
  if (rate > 0.4) return '#E6A23C'
  return '#F56C6C'
}

function tileBarColor(pct) {
  if (pct > 0.7) return '#67C23A'
  if (pct > 0.4) return '#409EFF'
  return '#C0C4CC'
}

function routeColor(id) {
  const colors = { 1: '#409EFF', 2: '#E6A23C', 3: '#67C23A', 4: '#F56C6C', 5: '#B37FEB', 6: '#36CFC9' }
  return colors[id] || '#909399'
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function recalc() {
  socketService.emit('rsu:recalc')
  emit('recalc')
}
</script>

<style scoped>
.rsu-hitrate {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-title {
  font-weight: 600;
  font-size: 15px;
  color: #303133;
}

.total-hitrate {
  text-align: center;
  padding: 8px 0 12px;
}

.total-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 4px;
}

.total-value {
  font-size: 32px;
  font-weight: 700;
  color: #67C23A;
  font-family: 'Courier New', monospace;
  margin-bottom: 8px;
}

.total-value.is-zero {
  color: #C0C4CC;
}

.divider {
  height: 1px;
  background: #ebeef5;
  margin: 14px 0;
}

.section-title {
  font-size: 13px;
  color: #606266;
  margin-bottom: 10px;
  font-weight: 500;
}

.route-item {
  margin-bottom: 14px;
  padding: 10px;
  background: #f5f7fa;
  border-radius: 6px;
}

.route-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.route-name {
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.route-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.route-vehicles {
  font-size: 11px;
  color: #909399;
}

.route-stats {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.stat-label {
  color: #909399;
}

.stat-value {
  font-weight: 600;
  color: #303133;
  font-family: 'Courier New', monospace;
}

.algo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.algo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #f5f7fa;
}

.algo-item.is-best {
  background: #ecf5ff;
  border: 1px solid #d9ecff;
}

.algo-header {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 48px;
}

.algo-name {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.algo-badge {
  font-size: 10px;
  background: #409EFF;
  color: #fff;
  padding: 1px 4px;
  border-radius: 3px;
}

.algo-bar-wrapper {
  flex: 1;
  height: 10px;
  background: #e4e7ed;
  border-radius: 5px;
  overflow: hidden;
}

.algo-bar {
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s ease;
}

.algo-value {
  font-size: 12px;
  font-weight: 600;
  color: #303133;
  font-family: 'Courier New', monospace;
  min-width: 52px;
  text-align: right;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.last-run {
  font-size: 11px;
  color: #909399;
}

/* 瓦片分布样式 */
.tile-summary {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
}

.tile-stat-item {
  background: #f5f7fa;
  border-radius: 6px;
  padding: 8px;
  text-align: center;
}

.tile-stat-label {
  font-size: 11px;
  color: #909399;
  margin-bottom: 2px;
}

.tile-stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #409EFF;
  font-family: 'Courier New', monospace;
}

.tile-subtitle {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}

.tile-bar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tile-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tile-rank {
  font-size: 10px;
  color: #909399;
  min-width: 14px;
  text-align: right;
}

.tile-bar-label {
  font-size: 11px;
  color: #606266;
  min-width: 32px;
  font-family: 'Courier New', monospace;
}

.tile-bar-track {
  flex: 1;
  height: 8px;
  background: #e4e7ed;
  border-radius: 4px;
  overflow: hidden;
}

.tile-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.5s ease;
}

.tile-bar-count {
  font-size: 11px;
  color: #909399;
  min-width: 24px;
  text-align: right;
  font-family: 'Courier New', monospace;
}
</style>
