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

      <!-- 瓦片收集进度 -->
      <div v-if="vehicleTileInfo" class="tile-progress">
        <div class="tile-progress-header">
          <span class="tile-progress-label">瓦片收集进度</span>
          <span class="tile-progress-value">{{ vehicleTileInfo.collectedCount }} / {{ selectedVehicle.requestedBlocks?.length || 0 }}</span>
        </div>
        <el-progress
          :percentage="tileProgressPercent"
          :color="tileProgressColor"
          :stroke-width="14"
        />
        <div v-if="showTileIds && vehicleTileInfo.tileIds.length > 0" class="tile-id-list">
          <div class="tile-ids-label">已收集瓦片 ID：</div>
          <div class="tile-ids">
            <span v-for="id in vehicleTileInfo.tileIds" :key="id" class="tile-id-badge">
              {{ id }}
            </span>
          </div>
        </div>
        <el-button
          v-if="vehicleTileInfo.tileIds.length > 0"
          text
          size="small"
          type="primary"
          @click="showTileIds = !showTileIds"
        >
          {{ showTileIds ? '收起瓦片列表' : '查看瓦片列表' }}
        </el-button>
      </div>

      <!-- 沿途 RSU 信息 -->
      <div class="divider"></div>
      <div class="section-title">沿途 RSU（实时）</div>
      <div class="rsu-route-list">
        <div class="rsu-route-count">共 {{ selectedVehicle?.upcomingRsuIds?.length || 0 }} 个 RSU</div>
        <div class="rsu-tags">
          <span
            v-for="rsuId in selectedVehicle?.upcomingRsuIds"
            :key="rsuId"
            class="rsu-tag"
            :style="{
              background: (rsuRouteMap.get(rsuId) ? ROUTE_COLORS[rsuRouteMap.get(rsuId)] : '#409EFF') + '22',
              color: rsuRouteMap.get(rsuId) ? ROUTE_COLORS[rsuRouteMap.get(rsuId)] : '#409EFF',
              borderColor: rsuRouteMap.get(rsuId) ? ROUTE_COLORS[rsuRouteMap.get(rsuId)] : '#d9ecff',
            }"
          >RSU #{{ rsuId }}</span>
          <div v-if="!selectedVehicle?.upcomingRsuIds?.length" class="rsu-empty-text">暂无数据</div>
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
const showTileIds = ref(false)

// RSU ID → routeId 查找表（从 rsuData 构建）
const rsuRouteMap = computed(() => {
  const map = new Map()
  const rsus = props.rsuData?.rsus
  if (rsus) {
    for (const rsu of rsus) {
      map.set(rsu.id, rsu.routeId)
    }
  }
  return map
})

// 路线颜色（与 MapView 保持一致）
const ROUTE_COLORS = {
  1: '#409EFF', 2: '#E6A23C', 3: '#67C23A',
  4: '#F56C6C', 5: '#B37FEB', 6: '#36CFC9',
}

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

const vehicleTileInfo = computed(() => {
  const veh = selectedVehicle.value
  const tiles = props.rsuData?.vehicleTiles
  if (!veh || !tiles) return null
  return tiles[veh.id] || null
})

const tileProgressPercent = computed(() => {
  const total = selectedVehicle.value?.requestedBlocks?.length || 0
  if (total === 0) return 0
  return Math.min(100, Math.round((vehicleTileInfo.value?.collectedCount || 0) / total * 100))
})

const tileProgressColor = computed(() => {
  const pct = tileProgressPercent.value
  if (pct >= 100) return '#67C23A'
  if (pct > 50) return '#409EFF'
  if (pct > 20) return '#E6A23C'
  return '#F56C6C'
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

.tile-progress {
  margin-top: 12px;
  padding: 10px;
  background: #f5f7fa;
  border-radius: 6px;
}

.tile-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.tile-progress-label {
  font-size: 12px;
  color: #606266;
  font-weight: 500;
}

.tile-progress-value {
  font-size: 13px;
  font-weight: 700;
  color: #409EFF;
  font-family: 'Courier New', monospace;
}

.tile-id-list {
  margin-top: 8px;
}

.tile-ids-label {
  font-size: 11px;
  color: #909399;
  margin-bottom: 4px;
}

.tile-ids {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
}

.tile-id-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: #ecf5ff;
  color: #409EFF;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  border: 1px solid #d9ecff;
}

/* 沿途 RSU */
.rsu-route-list {
  background: #f5f7fa;
  border-radius: 6px;
  padding: 10px;
}
.rsu-route-count {
  font-size: 12px;
  color: #606266;
  margin-bottom: 6px;
  font-weight: 500;
}
.rsu-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 100px;
  overflow-y: auto;
}
.rsu-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid;
  font-family: 'Courier New', monospace;
}
.rsu-empty-text {
  color: #c0c4cc;
  font-size: 12px;
}
</style>
