<template>
  <div ref="mapContainer" class="map-view"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import L from 'leaflet'
import { useVehicleStore } from '../stores/vehicleStore'

const props = defineProps({
  rsuData: {
    type: Object,
    default: null
  }
})

const vehicleStore = useVehicleStore()
const mapContainer = ref(null)

let map = null
let vehicleMarkers = {}
let trajectoryLines = {}
let rsuMarkers = {}
let rsuCoverageCircles = {}  // RSU覆盖半径圆圈（250m）

// 默认中心坐标（南京鼓楼区）
const defaultCenter = [32.059000, 118.769000]
const defaultZoom = 15

const RSU_COVERAGE_RADIUS_M = 250  // RSU 覆盖半径（米），与后端一致

// 路线名称映射（用于RSU标记）
const ROUTE_NAMES = {
  1: '古平岗→新庄',
  2: '草场门→九华山',
  3: '汉中门→西安门',
  4: '古平岗→汉中门',
  5: '新模范马路→新街口',
  6: '新庄→西安门',
}

// 高德地图切片图层（需要在实际使用时替换API密钥）
const amapTileLayer = L.tileLayer('https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
  attribution: '&copy; 高德地图',
  maxZoom: 18,
  minZoom: 3
})

// 6条路线的颜色（与 RSUHitRate.vue 的 routeColor 一致）
const ROUTE_COLORS = {
  1: { body: '#409EFF', stroke: '#2c6db5', window: '#8ac4ff' },
  2: { body: '#E6A23C', stroke: '#b8821f', window: '#f0c78a' },
  3: { body: '#67C23A', stroke: '#4a9e2a', window: '#95d475' },
  4: { body: '#F56C6C', stroke: '#c04040', window: '#f8a0a0' },
  5: { body: '#B37FEB', stroke: '#8a5ccf', window: '#d0b0f5' },
  6: { body: '#36CFC9', stroke: '#28a09a', window: '#80e0db' },
}

// 创建车辆图标（按路线着色，每条路线5辆车同色便于识别）
function createCarIcon(heading = 0, routeId = 1) {
  const size = 32
  const c = ROUTE_COLORS[routeId] || ROUTE_COLORS[1]
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
      <g transform="rotate(${heading}, 16, 16)">
        <rect x="8" y="12" width="16" height="10" rx="3" fill="${c.body}" stroke="${c.stroke}" stroke-width="1"/>
        <rect x="10" y="8" width="12" height="5" rx="2" fill="${c.window}" stroke="${c.stroke}" stroke-width="0.5"/>
        <circle cx="11" cy="23" r="2.5" fill="#333"/>
        <circle cx="21" cy="23" r="2.5" fill="#333"/>
        <rect x="14" y="16" width="4" height="3" rx="0.5" fill="#fff" opacity="0.8"/>
      </g>
    </svg>
  `
  return L.divIcon({
    html: svg,
    className: 'vehicle-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

// 创建轨迹线样式（按路线着色，与车辆图标颜色一致）
function getTrajectoryStyle(routeId) {
  const c = ROUTE_COLORS[routeId]
  return { color: c ? c.body : '#909399', weight: 3, opacity: 0.7 }
}

/**
 * 初始化 RSU 标记（从后端动态数据创建）
 */
function initRsuMarkers() {
  if (!map) return

  // 清除旧标记和覆盖圆
  Object.values(rsuMarkers).forEach(m => map.removeLayer(m))
  Object.values(rsuCoverageCircles).forEach(c => map.removeLayer(c))
  rsuMarkers = {}
  rsuCoverageCircles = {}

  const rsuList = props.rsuData?.rsus || []
  if (rsuList.length === 0) return

  rsuList.forEach((rsu, idx) => {
    const routeColor = ROUTE_COLORS[rsu.routeId]
    const color = routeColor ? routeColor.body : '#909399'
    const routeName = ROUTE_NAMES[rsu.routeId] || `路线 ${rsu.routeId || '?'}`
    const latlng = [rsu.latitude, rsu.longitude]
    const tileCount = props.rsuData?.rsuChunks?.[idx]?.length || 0

    // RSU 位置标记
    const marker = L.circleMarker(latlng, {
      radius: 8,
      fillColor: color,
      color: '#fff',
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.7,
    }).addTo(map)

    // RSU 覆盖半径圆圈（250m，半透明显示覆盖范围）
    const coverageCircle = L.circle(latlng, {
      radius: RSU_COVERAGE_RADIUS_M,
      color: color,
      fillColor: color,
      fillOpacity: 0.08,
      weight: 1,
      opacity: 0.3,
      className: 'rsu-coverage-circle',
    }).addTo(map)

    marker.bindPopup(`
      <div style="font-size:13px;">
        <b>RSU #${rsu.id}</b><br/>
        位置: ${rsu.name}<br/>
        所属路线: <span style="color:${color};font-weight:bold;">${routeName}</span><br/>
        区域: ${rsu.region}<br/>
        覆盖半径: ${RSU_COVERAGE_RADIUS_M}m<br/>
        <span id="rsu-hitrate-${rsu.id}" style="color:#409EFF;font-weight:bold;">命中率: 计算中...</span><br/>
        缓存瓦片: ${tileCount} 个
      </div>
    `)

    rsuMarkers[rsu.id] = marker
    rsuCoverageCircles[rsu.id] = coverageCircle
  })
}

/**
 * 更新 RSU 标记的命中率显示
 */
function updateRsuMarkers(rsuData) {
  if (!rsuData || !rsuData.rsus) return
  for (let idx = 0; idx < rsuData.rsus.length; idx++) {
    const rsu = rsuData.rsus[idx]
    const marker = rsuMarkers[rsu.id]
    if (!marker) continue
    const hitRate = (rsu.hitRate * 100).toFixed(1)
    const tileCount = rsuData.rsuChunks?.[idx]?.length || 0
    const routeColor = ROUTE_COLORS[rsu.routeId]
    const color = routeColor ? routeColor.body : '#909399'
    const routeName = ROUTE_NAMES[rsu.routeId] || `路线 ${rsu.routeId || '?'}`
    // 根据命中率调整透明度
    marker.setStyle({ fillOpacity: 0.3 + hitRate / 100 * 0.7 })
    // 更新 popup 内容
    marker.setPopupContent(`
      <div style="font-size:13px;">
        <b>RSU #${rsu.id}</b><br/>
        位置: ${rsu.name}<br/>
        所属路线: <span style="color:${color};font-weight:bold;">${routeName}</span><br/>
        区域: ${rsu.region}<br/>
        覆盖半径: ${RSU_COVERAGE_RADIUS_M}m<br/>
        <span style="color:#409EFF;font-weight:bold;">命中率: ${hitRate}%</span><br/>
        缓存瓦片: ${tileCount} 个
      </div>
    `)
  }
}

function initMap() {
  if (!mapContainer.value) return

  map = L.map(mapContainer.value, {
    center: defaultCenter,
    zoom: defaultZoom,
    zoomControl: true
  })

  amapTileLayer.addTo(map)
}

function updateVehicleMarkers(vehicles) {
  if (!map) return

  const currentIds = new Set(vehicles.map(v => v.id))

  // 移除不存在的车辆标记
  Object.keys(vehicleMarkers).forEach(id => {
    if (!currentIds.has(Number(id))) {
      map.removeLayer(vehicleMarkers[id])
      delete vehicleMarkers[id]
    }
  })

  // Objects.keys for trajectoryLines cleanup
  Object.keys(trajectoryLines).forEach(id => {
    if (!currentIds.has(Number(id))) {
      map.removeLayer(trajectoryLines[id])
      delete trajectoryLines[id]
    }
  })

  // 更新/添加车辆标记
  vehicles.forEach(v => {
    const id = v.id
    const routeId = v.routeId || 1
    const routeName = v.routeName || ''
    const latlng = [v.latitude, v.longitude]

    if (vehicleMarkers[id]) {
      // 更新位置和方向
      vehicleMarkers[id].setLatLng(latlng)
      const newIcon = createCarIcon(v.heading || 0, routeId)
      vehicleMarkers[id].setIcon(newIcon)
    } else {
      // 创建新标记（按路线着色）
      const marker = L.marker(latlng, {
        icon: createCarIcon(v.heading || 0, routeId)
      })
        .addTo(map)
        .bindPopup(`
          <div style="font-size:13px;">
            <b>车辆 #${id}</b><br/>
            路线: ${routeName}<br/>
            速度: ${(v.speed || 0).toFixed(1)} km/h<br/>
            位置: ${v.latitude.toFixed(6)}, ${v.longitude.toFixed(6)}
          </div>
        `)

      marker.on('click', () => {
        vehicleStore.setSelectedVehicle(id)
      })

      vehicleMarkers[id] = marker

      // 初始化轨迹线
      trajectoryLines[id] = L.polyline([], getTrajectoryStyle(routeId)).addTo(map)
    }

    // 更新轨迹
    if (trajectoryLines[id] && v.trajectory && v.trajectory.length > 1) {
      const latlngs = v.trajectory.map(t => [t.latitude, t.longitude])
      trajectoryLines[id].setLatLngs(latlngs)
    }
  })
}

// 自动视野适配
function fitBounds() {
  if (!map || vehicleStore.vehicles.length === 0) return
  const points = vehicleStore.vehicles.map(v =>
    L.latLng(v.latitude, v.longitude)
  )
  if (points.length > 0) {
    const bounds = L.latLngBounds(points)
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 })
  }
}

// 监听车辆数据变化
watch(() => vehicleStore.vehicles, (newVehicles) => {
  updateVehicleMarkers(newVehicles)
}, { deep: true })

// 选中车辆时飞行
watch(() => vehicleStore.selectedVehicleId, (newId) => {
  if (newId && vehicleMarkers[newId] && map) {
    const pos = vehicleMarkers[newId].getLatLng()
    map.setView(pos, map.getZoom(), { animate: true })
    vehicleMarkers[newId].openPopup()
  }
})

// 监听 RSU 数据更新（首次到达时创建标记，后续更新命中率）
watch(() => props.rsuData, (data) => {
  if (!data || !data.rsus) return
  if (Object.keys(rsuMarkers).length === 0) {
    initRsuMarkers()
  } else {
    updateRsuMarkers(data)
  }
}, { deep: true, immediate: false })

onMounted(() => {
  initMap()
})

onBeforeUnmount(() => {
  if (map) {
    map.remove()
    map = null
  }
  vehicleMarkers = {}
  trajectoryLines = {}
  rsuMarkers = {}
  rsuCoverageCircles = {}
})

defineExpose({ fitBounds })
</script>

<style scoped>
.map-view {
  width: 100%;
  height: 100%;
  border-radius: 8px;
  overflow: hidden;
}

:deep(.vehicle-marker) {
  background: none !important;
  border: none !important;
}

:deep(.leaflet-popup-content) {
  margin: 8px 12px;
}

:deep(.leaflet-control-zoom) {
  border: none !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15) !important;
}

:deep(.leaflet-control-zoom a) {
  background: #fff !important;
  color: #409EFF !important;
  width: 36px !important;
  height: 36px !important;
  line-height: 36px !important;
  font-size: 18px !important;
}
</style>
