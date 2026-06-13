<template>
  <div class="control-panel">
    <div class="panel-header">
      <span class="panel-title">模拟控制</span>
      <el-tag :type="statusTagType" size="small" effect="dark">
        {{ statusText }}
      </el-tag>
    </div>

    <div class="control-buttons">
      <el-button
        type="primary"
        :icon="VideoPlay"
        :disabled="drivingStatus === 'running'"
        @click="startDriving"
        round
      >
        开始模拟
      </el-button>

      <el-button
        type="warning"
        :icon="VideoPause"
        :disabled="drivingStatus !== 'running'"
        @click="pauseDriving"
        round
      >
        暂停
      </el-button>

      <el-button
        type="danger"
        :icon="Refresh"
        :disabled="drivingStatus === 'idle'"
        @click="resetDriving"
        round
      >
        重置
      </el-button>
    </div>

    <div class="speed-control">
      <div class="control-label">
        <span>时间速率</span>
        <span class="speed-value">{{ speedLevel }}x</span>
      </div>
      <el-slider
        v-model="speedLevel"
        :min="1"
        :max="10"
        :step="1"
        :show-stops="true"
        :marks="speedMarks"
        size="small"
      />
    </div>

    <div class="route-config">
      <div class="control-label" style="cursor:pointer" @click="showRouteConfig = !showRouteConfig">
        <span>路线车辆配置</span>
        <span class="speed-value">{{ targetVehicleCount }} 辆 <span style="font-size:11px;color:#909399">{{ showRouteConfig ? '收起' : '展开' }}</span></span>
      </div>
      <template v-if="showRouteConfig">
        <div v-for="route in routeDefs" :key="route.id" class="route-row">
          <div class="control-label">
            <span class="route-name">{{ route.name }}</span>
            <span class="speed-value">{{ routeVehicleCounts[route.id] }} 辆</span>
          </div>
          <el-slider
            :model-value="routeVehicleCounts[route.id]"
            :min="1"
            :max="10"
            :step="1"
            size="small"
            @update:model-value="(val) => setRouteVehicleCount(route.id, val)"
          />
        </div>
      </template>
    </div>

    <div class="speed-control">
      <div class="control-label">
        <span>平均速度</span>
        <span class="speed-value">{{ avgSpeed }}x</span>
      </div>
      <el-slider
        v-model="avgSpeed"
        :min="0.5"
        :max="3.0"
        :step="0.1"
        :show-stops="true"
        :marks="avgSpeedMarks"
        size="small"
      />
    </div>

  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { VideoPlay, VideoPause, Refresh } from '@element-plus/icons-vue'
import { useVehicleStore } from '../stores/vehicleStore'
import socketService from '../services/socket'

const vehicleStore = useVehicleStore()

const showRouteConfig = ref(false)

// 6条固定路线定义
const routeDefs = [
  { id: 1, name: '古平岗→新庄' },
  { id: 2, name: '草场门→九华山' },
  { id: 3, name: '汉中门→西安门' },
  { id: 4, name: '古平岗→汉中门' },
  { id: 5, name: '新模范马路→新街口' },
  { id: 6, name: '新庄→西安门' },
]

const drivingStatus = computed(() => vehicleStore.drivingStatus)

const speedLevel = computed({
  get: () => vehicleStore.speedLevel,
  set: (val) => vehicleStore.setSpeedLevel(val)
})

const targetVehicleCount = computed(() => vehicleStore.targetVehicleCount)

const routeVehicleCounts = computed(() => vehicleStore.routeVehicleCounts)

const setRouteVehicleCount = (routeId, count) => vehicleStore.setRouteVehicleCount(routeId, count)

const avgSpeed = computed({
  get: () => vehicleStore.avgSpeed,
  set: (val) => vehicleStore.setAvgSpeed(val)
})

const speedMarks = {
  1: '1',
  5: '5',
  10: '10'
}

const avgSpeedMarks = {
  0.5: '0.5x',
  1.0: '1x',
  3.0: '3x'
}

const statusTagType = computed(() => {
  const map = { idle: 'info', running: 'success', paused: 'warning' }
  return map[drivingStatus.value] || 'info'
})

const statusText = computed(() => {
  const map = { idle: '已就绪', running: '行驶中', paused: '已暂停' }
  return map[drivingStatus.value] || '未知'
})

function startDriving() {
  if (drivingStatus.value === 'idle') {
    socketService.emit('simulation:start', {
      speedLevel: speedLevel.value,
      routeVehicleCounts: routeVehicleCounts.value,
      avgSpeed: avgSpeed.value
    })
  } else if (drivingStatus.value === 'paused') {
    socketService.emit('simulation:resume')
    vehicleStore.resume()
  }
}

function pauseDriving() {
  socketService.emit('simulation:pause')
  vehicleStore.pause()
}

function resetDriving() {
  socketService.emit('simulation:reset')
  vehicleStore.reset()
}
</script>

<style scoped>
.control-panel {
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

.control-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.control-buttons .el-button {
  flex: 1;
  min-width: 80px;
}

.speed-control {
  margin-bottom: 16px;
}

.control-label {
  font-size: 13px;
  color: #606266;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.speed-value {
  font-weight: 600;
  color: #409EFF;
}

.route-config {
  margin-bottom: 16px;
}

.route-row {
  margin-bottom: 12px;
  padding-left: 4px;
}

.route-name {
  font-size: 12px;
  color: #606266;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}
</style>
