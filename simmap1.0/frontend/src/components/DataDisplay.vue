<template>
  <div class="data-display">
    <div class="panel-header">
      <span class="panel-title">实时数据</span>
      <el-tag size="small" type="success" effect="plain" v-if="connected">
        已连接
      </el-tag>
      <el-tag size="small" type="danger" effect="plain" v-else>
        未连接
      </el-tag>
    </div>

    <div class="data-grid">
      <div class="data-item">
        <div class="data-label">行驶时间</div>
        <div class="data-value">{{ formattedTime }}</div>
      </div>
      <div class="data-item">
        <div class="data-label">车辆数量</div>
        <div class="data-value">{{ vehicleCount }}</div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="section-title">选中车辆</div>

    <template v-if="selectedVehicle">
      <div class="data-grid">
        <div class="data-item">
          <div class="data-label">车辆ID</div>
          <div class="data-value">#{{ selectedVehicle.id }}</div>
        </div>
        <div class="data-item">
          <div class="data-label">行驶速度</div>
          <div class="data-value highlight">{{ (selectedVehicle.speed || 0).toFixed(2) }} km/h</div>
        </div>
        <div class="data-item">
          <div class="data-label">纬度</div>
          <div class="data-value">{{ selectedVehicle.latitude?.toFixed(6) }}</div>
        </div>
        <div class="data-item">
          <div class="data-label">经度</div>
          <div class="data-value">{{ selectedVehicle.longitude?.toFixed(6) }}</div>
        </div>
        <div class="data-item">
          <div class="data-label">行驶方向</div>
          <div class="data-value">{{ selectedVehicle.heading?.toFixed(1) }}°</div>
        </div>
        <div class="data-item">
          <div class="data-label">轨迹点数</div>
          <div class="data-value">{{ selectedVehicle.trajectory?.length || 0 }}</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="no-selection">点击地图上的车辆查看详情</div>
    </template>

    <!-- RSU 缓存命中率 -->
    <div class="divider"></div>
    <RSUHitRate :data="rsuData" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useVehicleStore } from '../stores/vehicleStore'
import socketService from '../services/socket'
import RSUHitRate from './RSUHitRate.vue'

const props = defineProps({
  rsuData: {
    type: Object,
    default: null,
  },
})

const vehicleStore = useVehicleStore()
const connected = ref(false)

const selectedVehicle = computed(() => vehicleStore.selectedVehicle)
const vehicleCount = computed(() => vehicleStore.vehicleCount)
const elapsedTime = computed(() => vehicleStore.elapsedTime)

const formattedTime = computed(() => {
  const t = elapsedTime.value
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

function onConnect() {
  connected.value = true
}

function onDisconnect() {
  connected.value = false
}

onMounted(() => {
  socketService.on('connect', onConnect)
  socketService.on('disconnect', onDisconnect)
  // Check if already connected
  connected.value = true
})

onBeforeUnmount(() => {
  socketService.off('connect')
  socketService.off('disconnect')
})
</script>

<style scoped>
.data-display {
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

.data-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.data-item {
  background: #f5f7fa;
  border-radius: 6px;
  padding: 10px 12px;
}

.data-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 4px;
}

.data-value {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  font-family: 'Courier New', monospace;
}

.data-value.highlight {
  color: #67C23A;
  font-size: 18px;
}

.divider {
  height: 1px;
  background: #ebeef5;
  margin: 16px 0;
}

.section-title {
  font-size: 13px;
  color: #606266;
  margin-bottom: 12px;
  font-weight: 500;
}

.no-selection {
  color: #909399;
  font-size: 13px;
  text-align: center;
  padding: 20px 0;
}
</style>
