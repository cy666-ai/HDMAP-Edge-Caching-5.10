<template>
  <div class="dashboard">
    <!-- 顶部标题栏 -->
    <header class="app-header">
      <div class="header-left">
        <el-icon :size="24" color="#409EFF"><Monitor /></el-icon>
        <h1 class="app-title">面向自动驾驶的分层高精地图边缘缓存可视化系统</h1>
      </div>
      <div class="header-right">
        <el-button text @click="fitMapView">
          <el-icon><Aim /></el-icon>
          适配视图
        </el-button>
      </div>
    </header>

    <!-- 主体布局 -->
    <div class="app-body">
      <!-- 左侧地图区域 -->
      <div class="map-area">
        <MapView ref="mapViewRef" :rsuData="rsuData" />
      </div>

      <!-- 右侧面板区域 -->
      <div class="side-panel">
        <ControlPanel />
        <DataDisplay :rsuData="rsuData" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Monitor, Aim } from '@element-plus/icons-vue'
import MapView from '../components/MapView.vue'
import ControlPanel from '../components/ControlPanel.vue'
import DataDisplay from '../components/DataDisplay.vue'
import { useVehicleStore } from '../stores/vehicleStore'
import socketService from '../services/socket'

const vehicleStore = useVehicleStore()
const mapViewRef = ref(null)
const rsuData = ref(null)

function fitMapView() {
  mapViewRef.value?.fitBounds()
}

function onVehicleUpdate(data) {
  // data 格式: { vehicles: [...] }
  if (data && data.vehicles) {
    vehicleStore.updateVehicles(data.vehicles)
  }
}

function onVehiclePosition(data) {
  if (data) {
    vehicleStore.updateVehiclePosition(data)
  }
}

function onSimulationStatus(data) {
  if (data?.status === 'started') {
    vehicleStore.setDrivingStatus('running')
  } else if (data?.status === 'paused') {
    vehicleStore.setDrivingStatus('paused')
  } else if (data?.status === 'reset') {
    vehicleStore.reset()
  }
}

function onRsuUpdate(data) {
  rsuData.value = data
}

onMounted(() => {
  socketService.connect()
  socketService.on('vehicle:update', onVehicleUpdate)
  socketService.on('vehicle:position', onVehiclePosition)
  socketService.on('simulation:status', onSimulationStatus)
  socketService.on('rsu:update', onRsuUpdate)
})

onBeforeUnmount(() => {
  socketService.off('vehicle:update')
  socketService.off('vehicle:position')
  socketService.off('simulation:status')
  socketService.off('rsu:update')
  // Don't disconnect here; other views may need it
})
</script>

<style scoped>
.dashboard {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
}

.app-header {
  height: 56px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.app-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.app-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
}

.map-area {
  flex: 1;
  min-width: 0;
}

.side-panel {
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  flex-shrink: 0;
}

@media (max-width: 900px) {
  .app-body {
    flex-direction: column;
  }
  .side-panel {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
  }
  .side-panel > * {
    min-width: 280px;
  }
}
</style>
