<template>
  <div class="dashboard">
    <!-- 顶部标题栏 -->
    <header class="app-header">
      <div class="header-left">
        <el-icon :size="24" color="#409EFF"><Monitor /></el-icon>
        <h1 class="app-title">面向自动驾驶的分层高精地图边缘缓存系统</h1>
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

      <!-- 拖拽分隔条 -->
      <div class="resize-handle" @mousedown="startResize"></div>

      <!-- 右侧面板区域 -->
      <div class="side-panel" :style="{ width: panelWidth + 'px' }">
        <ControlPanel />
        <RouteManager />

        <!-- 面板切换 Tab -->
        <div class="panel-tabs">
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'monitor' }"
            @click="activeTab = 'monitor'"
          >
            <el-icon :size="14"><Monitor /></el-icon>
            <span>实时监控</span>
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'statistics' }"
            @click="activeTab = 'statistics'"
          >
            <el-icon :size="14"><DataAnalysis /></el-icon>
            <span>统计分析</span>
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'comparison' }"
            @click="activeTab = 'comparison'"
          >
            <el-icon :size="14"><TrendCharts /></el-icon>
            <span>对比分析</span>
          </button>
        </div>

        <!-- 面板内容区 -->
        <DataDisplay v-if="activeTab === 'monitor'" :rsuData="rsuData" />
        <StatisticsPanel v-if="activeTab === 'statistics'" :data="rsuData" :panelWidth="panelWidth" />
        <ComparisonPanel v-if="activeTab === 'comparison'" :rsuData="rsuData" :panelWidth="panelWidth" />
      </div>
    </div>

    <!-- 聊天机器人 FAB + Drawer -->
    <ChatWidget />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Monitor, Aim, DataAnalysis, TrendCharts } from '@element-plus/icons-vue'
import MapView from '../components/MapView.vue'
import ControlPanel from '../components/ControlPanel.vue'
import RouteManager from '../components/RouteManager.vue'
import DataDisplay from '../components/DataDisplay.vue'
import StatisticsPanel from '../components/StatisticsPanel.vue'
import ComparisonPanel from '../components/ComparisonPanel.vue'
import ChatWidget from '../components/ChatWidget.vue'
import { useVehicleStore } from '../stores/vehicleStore'
import socketService from '../services/socket'

const vehicleStore = useVehicleStore()
const mapViewRef = ref(null)
const rsuData = ref(null)
const activeTab = ref('monitor')

// 右侧面板拖拽调整宽度
const panelWidth = ref(320)
const isResizing = ref(false)
const resizeStartX = ref(0)
const resizeStartWidth = ref(0)

function startResize(e) {
  isResizing.value = true
  resizeStartX.value = e.clientX
  resizeStartWidth.value = panelWidth.value
  document.addEventListener('mousemove', onResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResize(e) {
  if (!isResizing.value) return
  const dx = resizeStartX.value - e.clientX
  const newWidth = resizeStartWidth.value + dx
  panelWidth.value = Math.max(260, Math.min(600, newWidth))
}

function stopResize() {
  isResizing.value = false
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

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
    // 同步后端确认的路线配置（车辆计数和速度）
    if (data.routeVehicleCounts) {
      vehicleStore.routeVehicleCounts = data.routeVehicleCounts
    }
    if (data.routeSpeeds) {
      vehicleStore.routeSpeeds = data.routeSpeeds
    }
  } else if (data?.status === 'paused') {
    vehicleStore.setDrivingStatus('paused')
  } else if (data?.status === 'reset') {
    vehicleStore.reset()
    // 清空地图上的旧 RSU 和车辆数据，等待后端推送新的 rsu:update
    rsuData.value = null
  }
}

function onRsuUpdate(data) {
  rsuData.value = data
  // 从 rsu:update 的 vehicleTiles 中合并实时 upcomingRsuIds 到车辆数据
  vehicleStore.updateVehicleUpcomingRsuIds(data?.vehicleTiles)
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

.resize-handle {
  width: 6px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.2s;
  position: relative;
}

.resize-handle:hover,
.resize-handle:active {
  background: #409EFF44;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 40px;
  border-radius: 1px;
  background: #dcdfe6;
  transition: background 0.2s;
}

.resize-handle:hover::after {
  background: #409EFF;
}

.panel-tabs {
  display: flex;
  gap: 6px;
  background: #fff;
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #909399;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
}

.tab-btn:hover {
  color: #409EFF;
  background: #ecf5ff;
}

.tab-btn.active {
  color: #fff;
  background: #409EFF;
  box-shadow: 0 1px 4px rgba(64, 158, 255, 0.4);
}

.tab-btn.active .el-icon {
  color: #fff;
}

@media (max-width: 900px) {
  .app-body {
    flex-direction: column;
  }
  .side-panel {
    width: 100% !important;
    flex-direction: row;
    overflow-x: auto;
  }
  .side-panel > * {
    min-width: 280px;
  }
  .resize-handle {
    display: none;
  }
}
</style>
