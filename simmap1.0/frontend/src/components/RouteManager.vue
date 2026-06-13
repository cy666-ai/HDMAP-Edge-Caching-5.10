<template>
  <div class="route-manager">
    <div class="panel-header" style="cursor:pointer" @click="showPanel = !showPanel">
      <span class="panel-title">路线管理</span>
      <span class="panel-badge">{{ routes.length }} 条 <span style="font-size:11px;color:#909399">{{ showPanel ? '收起' : '展开' }}</span></span>
    </div>

    <template v-if="showPanel">
      <!-- 路线列表 -->
      <div class="route-list">
        <div v-for="route in routes" :key="route.id" class="route-card">
          <div class="route-info">
            <span class="route-dot" :style="{ background: routeColor(route.id) }"></span>
            <div class="route-detail">
              <span class="route-label">{{ route.name }}</span>
              <span class="route-stations">{{ route.start || '?' }} → {{ route.end || '?' }}</span>
            </div>
          </div>
          <el-button
            type="danger"
            size="small"
            :icon="Delete"
            circle
            :disabled="drivingStatus === 'running' || routes.length <= 1"
            @click="confirmDelete(route)"
          />
        </div>
      </div>

      <div class="divider"></div>

      <!-- 添加路线表单 -->
      <div class="section-title" style="cursor:pointer" @click="showAddForm = !showAddForm">
        添加新路线 <span style="font-size:11px;color:#909399">{{ showAddForm ? '收起' : '展开' }}</span>
      </div>

      <template v-if="showAddForm">
        <div class="add-form">
          <el-input v-model="form.name" placeholder="路线名称（如：鼓楼→新街口）" size="small" class="form-input" />
          <el-input v-model="form.start" placeholder="起点站名" size="small" class="form-input" />
          <el-input v-model="form.end" placeholder="终点站名" size="small" class="form-input" />

          <div class="coord-row">
            <div class="coord-group">
              <label>起点坐标</label>
              <div class="coord-pick-row">
                <el-button size="small" :icon="MapLocation" @click="startMapPick('start')" :type="vehicleStore.mapPickMode === 'start' ? 'warning' : ''">
                  {{ vehicleStore.mapPickMode === 'start' ? '地图取点中...' : '地图取点' }}
                </el-button>
              </div>
              <div v-if="form.startLat" class="coord-value">
                {{ form.startLat }}, {{ form.startLng }}
              </div>
            </div>
            <div class="coord-group">
              <label>终点坐标</label>
              <div class="coord-pick-row">
                <el-button size="small" :icon="MapLocation" @click="startMapPick('end')" :type="vehicleStore.mapPickMode === 'end' ? 'warning' : ''">
                  {{ vehicleStore.mapPickMode === 'end' ? '地图取点中...' : '地图取点' }}
                </el-button>
              </div>
              <div v-if="form.endLat" class="coord-value">
                {{ form.endLat }}, {{ form.endLng }}
              </div>
            </div>
          </div>

          <div class="form-actions">
            <el-button
              size="small"
              :loading="fetchingAmap"
              :disabled="!canFetchAmap"
              @click="fetchAmapPath"
            >
              {{ fetchingAmap ? '获取中...' : '获取高德路径' }}
            </el-button>
            <el-button
              type="primary"
              size="small"
              :disabled="!canAdd || addingRoute"
              :loading="addingRoute"
              @click="addRoute"
            >
              {{ addingRoute ? '添加中...' : '添加路线' }}
            </el-button>
          </div>

          <div v-if="amapResult" class="amap-result" :class="{ success: amapResult.success, error: !amapResult.success }">
            {{ amapResult.success ? `已获取 ${amapResult.pointCount} 个路径点` : `获取失败: ${amapResult.error}` }}
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { Delete, MapLocation } from '@element-plus/icons-vue'
import { useVehicleStore } from '../stores/vehicleStore'
import socketService from '../services/socket'
import { generateRouteColors } from '../utils/routeColors'

const vehicleStore = useVehicleStore()

const showPanel = ref(false)
const showAddForm = ref(false)
const fetchingAmap = ref(false)
const addingRoute = ref(false)
const amapResult = ref(null)
const amapPoints = ref(null)

const drivingStatus = computed(() => vehicleStore.drivingStatus)

const routes = computed(() => vehicleStore.routeConfig)

const routeColors = computed(() => {
  const ids = routes.value.map(r => r.id)
  return generateRouteColors(ids)
})

function routeColor(id) {
  return routeColors.value[id]?.body || '#909399'
}

// 表单数据
const form = ref({
  name: '',
  start: '',
  end: '',
  startLat: '',
  startLng: '',
  endLat: '',
  endLng: '',
})

// 监听地图选点结果
watch(() => vehicleStore.mapPickedCoord, (coord) => {
  if (!coord) return
  if (coord.target === 'start') {
    form.value.startLat = coord.lat.toFixed(6)
    form.value.startLng = coord.lng.toFixed(6)
  } else if (coord.target === 'end') {
    form.value.endLat = coord.lat.toFixed(6)
    form.value.endLng = coord.lng.toFixed(6)
  }
})

function startMapPick(target) {
  vehicleStore.activateMapPick(target)
}

const canFetchAmap = computed(() => {
  return form.value.startLat && form.value.startLng && form.value.endLat && form.value.endLng
})

const canAdd = computed(() => {
  return form.value.name && form.value.start && form.value.end
    && form.value.startLat && form.value.startLng
    && form.value.endLat && form.value.endLng
})

// 监听 socket 事件
function setupListeners() {
  socketService.on('route:fetchAmapResult', (data) => {
    fetchingAmap.value = false
    amapResult.value = data
    if (data.success && data.points) {
      amapPoints.value = data.points
    }
  })

  socketService.on('route:addResult', (data) => {
    addingRoute.value = false
    if (data.success) {
      resetForm()
      amapResult.value = null
      amapPoints.value = null
      showAddForm.value = false
    } else {
      alert('添加路线失败: ' + (data.error || '未知错误'))
    }
  })

  socketService.on('route:deleteResult', (data) => {
    if (!data.success) {
      alert('删除路线失败: ' + (data.error || '未知错误'))
    }
  })

  // 当路线配置变更时更新 store
  socketService.on('route:config', (data) => {
    if (data?.routes) {
      vehicleStore.setRouteConfig(data.routes)
      vehicleStore.initRouteVehicleCounts(
        data.routes.map(r => r.id),
        data.defaultVehicleCount || 5
      )
      vehicleStore.initRouteSpeeds(
        data.routes.map(r => r.id),
        35
      )
    }
  })
}

// 组件挂载时注册监听器并请求当前配置
import { onMounted, onBeforeUnmount } from 'vue'

onMounted(() => {
  setupListeners()
  // 请求当前路线配置
  if (socketService.socket?.connected) {
    socketService.emit('route:getConfig')
  } else {
    // socket 未连接时等待
    const checkSocket = setInterval(() => {
      if (socketService.socket?.connected) {
        socketService.emit('route:getConfig')
        clearInterval(checkSocket)
      }
    }, 500)
  }
})

onBeforeUnmount(() => {
  socketService.off('route:fetchAmapResult')
  socketService.off('route:addResult')
  socketService.off('route:deleteResult')
  socketService.off('route:config')
})

function fetchAmapPath() {
  fetchingAmap.value = true
  amapResult.value = null
  amapPoints.value = null
  socketService.emit('route:fetchAmap', {
    startLat: parseFloat(form.value.startLat),
    startLng: parseFloat(form.value.startLng),
    endLat: parseFloat(form.value.endLat),
    endLng: parseFloat(form.value.endLng),
  })
}

function addRoute() {
  if (!canAdd.value) return
  addingRoute.value = true

  const waypoints = [
    [parseFloat(form.value.startLat), parseFloat(form.value.startLng)],
    [parseFloat(form.value.endLat), parseFloat(form.value.endLng)],
  ]

  socketService.emit('route:add', {
    name: form.value.name,
    start: form.value.start,
    end: form.value.end,
    waypoints,
    amapPoints: amapPoints.value,
  })
}

function confirmDelete(route) {
  if (confirm(`确定要删除路线「${route.name}」吗？\n相关的 RSU、车辆和缓存决策将被移除。`)) {
    socketService.emit('route:delete', { routeId: route.id })
  }
}

function resetForm() {
  form.value = {
    name: '',
    start: '',
    end: '',
    startLat: '',
    startLng: '',
    endLat: '',
    endLng: '',
  }
}
</script>

<style scoped>
.route-manager {
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

.panel-badge {
  font-weight: 600;
  color: #409EFF;
  font-size: 13px;
}

.route-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.route-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: #f5f7fa;
  border-radius: 6px;
}

.route-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.route-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.route-detail {
  display: flex;
  flex-direction: column;
}

.route-label {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.route-stations {
  font-size: 11px;
  color: #909399;
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

.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-input {
  width: 100%;
}

.coord-row {
  display: flex;
  gap: 8px;
}

.coord-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.coord-group label {
  font-size: 11px;
  color: #909399;
  margin-bottom: 2px;
}

.coord-pick-row {
  display: flex;
  gap: 4px;
}

.coord-pick-row .el-button {
  width: 100%;
}

.coord-value {
  font-size: 11px;
  color: #409EFF;
  font-weight: 500;
  margin-top: 4px;
  background: #ecf5ff;
  padding: 3px 6px;
  border-radius: 4px;
  word-break: break-all;
}

.form-actions {
  display: flex;
  gap: 8px;
}

.amap-result {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 4px;
}

.amap-result.success {
  background: #f0f9eb;
  color: #67C23A;
}

.amap-result.error {
  background: #fef0f0;
  color: #F56C6C;
}
</style>
