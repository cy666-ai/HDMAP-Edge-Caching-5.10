<template>
  <div class="rsu-hitrate">
    <div class="panel-header">
      <span class="panel-title">RSU 缓存命中率</span>
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

    <!-- 各区域命中率 -->
    <div class="section-title">各区域详情</div>
    <div
      v-for="region in regions"
      :key="region.id"
      class="region-item"
    >
      <div class="region-header">
        <span class="region-name">
          <span class="region-dot" :style="{ background: regionColor(region.id) }"></span>
          {{ region.name }}
        </span>
        <span class="region-vehicles">{{ region.vehicleCount }} 辆车</span>
      </div>
      <div class="region-stats">
        <div class="stat-row">
          <span class="stat-label">命中率</span>
          <span class="stat-value">{{ (region.hitRate * 100).toFixed(1) }}%</span>
        </div>
        <el-progress
          :percentage="Math.round(region.hitRate * 100)"
          :color="hitRateColor(region.hitRate)"
          :stroke-width="12"
          :show-text="false"
        />
        <div class="stat-row">
          <span class="stat-label">路线概率</span>
          <span class="stat-value">{{ region.probRoute.toFixed(4) }}</span>
        </div>
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

const regions = computed(() => props.data?.regions || [])

const algorithmResults = computed(() => props.data?.algorithmResults || null)

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

function regionColor(id) {
  const colors = { 1: '#F56C6C', 2: '#E6A23C', 3: '#67C23A' }
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

.region-item {
  margin-bottom: 14px;
  padding: 10px;
  background: #f5f7fa;
  border-radius: 6px;
}

.region-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.region-name {
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.region-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.region-vehicles {
  font-size: 11px;
  color: #909399;
}

.region-stats {
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
</style>
