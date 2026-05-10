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

const REGION_COLORS = {
  1: '#F56C6C', // 红 - 北侧走廊
  2: '#E6A23C', // 橙 - 中间走廊
  3: '#67C23A', // 绿 - 南侧走廊
}

const RSU_COVERAGE_RADIUS_M = 250  // RSU 覆盖半径（米），与后端一致

// 高德地图切片图层（需要在实际使用时替换API密钥）
const amapTileLayer = L.tileLayer('https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
  attribution: '&copy; 高德地图',
  maxZoom: 18,
  minZoom: 3
})

// 创建车辆图标
function createCarIcon(heading = 0) {
  const size = 32
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
      <g transform="rotate(${heading}, 16, 16)">
        <rect x="8" y="12" width="16" height="10" rx="3" fill="#409EFF" stroke="#2c6db5" stroke-width="1"/>
        <rect x="10" y="8" width="12" height="5" rx="2" fill="#66b1ff" stroke="#2c6db5" stroke-width="0.5"/>
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

// 创建轨迹线样式
function getTrajectoryStyle(vehicleId) {
  const colors = ['#409EFF', '#E6A23C', '#67C23A', '#F56C6C', '#909399', '#B37FEB']
  const color = colors[vehicleId % colors.length]
  return { color, weight: 3, opacity: 0.7 }
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

  rsuList.forEach(rsu => {
    const color = REGION_COLORS[rsu.region] || '#909399'
    const latlng = [rsu.latitude, rsu.longitude]

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
        区域: ${rsu.region}<br/>
        覆盖半径: ${RSU_COVERAGE_RADIUS_M}m<br/>
        <span id="rsu-hitrate-${rsu.id}" style="color:#409EFF;font-weight:bold;">命中率: 计算中...</span>
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
  for (const rsu of rsuData.rsus) {
    const marker = rsuMarkers[rsu.id]
    if (!marker) continue
    const hitRate = (rsu.hitRate * 100).toFixed(1)
    // 根据命中率调整透明度
    marker.setStyle({ fillOpacity: 0.3 + hitRate / 100 * 0.7 })
    // 更新 popup 内容
    marker.setPopupContent(`
      <div style="font-size:13px;">
        <b>RSU #${rsu.id}</b><br/>
        位置: ${rsu.name}<br/>
        区域: ${rsu.region}<br/>
        覆盖半径: ${RSU_COVERAGE_RADIUS_M}m<br/>
        <span style="color:#409EFF;font-weight:bold;">命中率: ${hitRate}%</span>
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
    const latlng = [v.latitude, v.longitude]

    if (vehicleMarkers[id]) {
      // 更新位置和方向
      vehicleMarkers[id].setLatLng(latlng)
      const newIcon = createCarIcon(v.heading || 0)
      vehicleMarkers[id].setIcon(newIcon)
    } else {
      // 创建新标记
      const marker = L.marker(latlng, {
        icon: createCarIcon(v.heading || 0)
      })
        .addTo(map)
        .bindPopup(`
          <div style="font-size:13px;">
            <b>车辆 #${id}</b><br/>
            速度: ${(v.speed || 0).toFixed(1)} km/h<br/>
            位置: ${v.latitude.toFixed(6)}, ${v.longitude.toFixed(6)}
          </div>
        `)

      marker.on('click', () => {
        vehicleStore.setSelectedVehicle(id)
      })

      vehicleMarkers[id] = marker

      // 初始化轨迹线
      trajectoryLines[id] = L.polyline([], getTrajectoryStyle(id)).addTo(map)
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
