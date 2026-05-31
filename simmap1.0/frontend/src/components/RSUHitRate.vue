<template>
  <div class="rsu-hitrate">
    <div class="panel-header">
      <span class="panel-title">缓存命中率（MWC）</span>
      <el-tag size="small" :type="matlabStatusType" effect="plain">
        {{ matlabStatusText }}
      </el-tag>
    </div>

    <!-- 总命中率 -->
    <div class="total-hitrate">
      <div class="total-label">系统总命中率</div>
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

    <!-- 各路线详情 -->
    <div class="section-title">各路线 RSU 缓存命中率</div>
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
        <span class="route-vehicles">{{ route.vehicleCount }} 辆车 · {{ route.E }} 个RSU</span>
      </div>
      <div class="route-stats">
        <div class="stat-row">
          <span class="stat-label">命中率</span>
          <span class="stat-value" :style="{ color: hitRateColor(route.hitRate) }">
            {{ (route.hitRate * 100).toFixed(1) }}%
          </span>
        </div>
        <div class="stat-row">
          <span class="stat-label">命中块数</span>
          <span class="stat-value">{{ route.collectedTiles || 0 }} 块</span>
        </div>
        <el-progress
          :percentage="Math.round(route.hitRate * 100)"
          :color="hitRateColor(route.hitRate)"
          :stroke-width="12"
          :show-text="false"
        />
      </div>
    </div>

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
        {{ matlabRunning ? 'MWC计算中...' : '重新计算' }}
      </el-button>
      <span class="last-run" v-if="lastMatlabRun">
        上次: {{ formatTime(lastMatlabRun) }}
      </span>
    </div>
    <div class="tick-info" v-if="tick !== undefined">
      时间片 #{{ tick }}
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

const matlabRunning = computed(() => props.data?.matlabRunning || false)

const lastMatlabRun = computed(() => props.data?.lastMatlabRun || null)

const tick = computed(() => props.data?.tick ?? undefined)

const matlabStatusType = computed(() => {
  if (props.data?.matlabError) return 'danger'
  if (matlabRunning.value) return 'warning'
  return props.data?.lastMatlabRun ? 'success' : 'info'
})

const matlabStatusText = computed(() => {
  if (props.data?.matlabError) return '算法错误'
  if (matlabRunning.value) return 'MWC计算中'
  return props.data?.lastMatlabRun ? '已就绪' : '未计算'
})

function hitRateColor(rate) {
  if (rate > 0.7) return '#67C23A'
  if (rate > 0.4) return '#E6A23C'
  return '#F56C6C'
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

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.last-run {
  font-size: 11px;
  color: #909399;
}

.tick-info {
  font-size: 11px;
  color: #C0C4CC;
  text-align: right;
  margin-top: 6px;
}
</style>
