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
            <span class="speed-value">{{ routeVehicleCounts[route.id] }} 辆 · {{ routeSpeeds[route.id] || 35 }} km/h</span>
          </div>
          <div class="route-sliders">
            <el-slider
              :model-value="routeVehicleCounts[route.id]"
              :min="1"
              :max="10"
              :step="1"
              size="small"
              @update:model-value="(val) => setRouteVehicleCount(route.id, val)"
            />
            <el-slider
              class="speed-slider"
              :model-value="routeSpeeds[route.id] ?? 35"
              :min="0"
              :max="90"
              :step="5"
              size="small"
              @update:model-value="(val) => setRouteSpeed(route.id, val)"
            />
          </div>
        </div>
      </template>
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

// 动态路线定义（从 store 获取，后端同步）
const routeDefs = computed(() => vehicleStore.routeConfig)

const drivingStatus = computed(() => vehicleStore.drivingStatus)

const speedLevel = computed({
  get: () => vehicleStore.speedLevel,
  set: (val) => vehicleStore.setSpeedLevel(val)
})

const targetVehicleCount = computed(() => vehicleStore.targetVehicleCount)

const routeVehicleCounts = computed(() => vehicleStore.routeVehicleCounts)

const routeSpeeds = computed(() => vehicleStore.routeSpeeds)

const setRouteVehicleCount = (routeId, count) => vehicleStore.setRouteVehicleCount(routeId, count)

const setRouteSpeed = (routeId, speedKmh) => vehicleStore.setRouteSpeed(routeId, speedKmh)

const speedMarks = {
  1: '1',
  5: '5',
  10: '10'
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
      routeSpeeds: routeSpeeds.value
    })
  } else if (drivingStatus.value === 'paused') {
    socketService.emit('simulation:resume', {
      routeVehicleCounts: routeVehicleCounts.value,
      routeSpeeds: routeSpeeds.value
    })
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

.route-sliders {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.route-name {
  font-size: 12px;
  color: #606266;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

/* 绿色速度滑动条 */
.speed-slider {
  --el-slider-main-bg-color: #67C23A;
  --el-slider-runway-bg-color: #e1f3d8;
  --el-slider-stop-bg-color: #b3e19d;
  --el-slider-button-wrapper-bg-color: #fff;
  --el-slider-main-bg-color-hover: #85CE61;
}
</style>
