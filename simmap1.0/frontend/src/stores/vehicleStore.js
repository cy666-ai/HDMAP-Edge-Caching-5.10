import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useVehicleStore = defineStore('vehicle', () => {
  // 所有车辆数据
  const vehicles = ref([])
  // 选中的车辆ID
  const selectedVehicleId = ref(null)
  // 行驶状态: idle / running / paused
  const drivingStatus = ref('idle')
  // 速度等级 1-10
  const speedLevel = ref(5)
  // 每条路线的目标车辆数，下一次启动时生效
  // key: routeId (1-6), value: 车辆数 (1-10)
  const routeVehicleCounts = ref({
    1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5
  })
  // 车辆平均速度倍率 (0.5x - 3.0x)
  const avgSpeed = ref(1.0)
  // 已行驶时间（秒）
  const elapsedTime = ref(0)
  // 模拟时间间隔定时器
  let timer = null

  const selectedVehicle = computed(() =>
    vehicles.value.find(v => v.id === selectedVehicleId.value) || null
  )

  const vehicleCount = computed(() => vehicles.value.length)

  // 目标总车辆数（各路线之和）
  const targetVehicleCount = computed(() =>
    Object.values(routeVehicleCounts.value).reduce((a, b) => a + b, 0)
  )

  function updateVehicles(data) {
    vehicles.value = data.map(v => ({
      ...v,
      heading: v.heading || 0,
      speed: v.speed || 0,
      routeIndex: v.routeIndex || 0,
      requestedBlocks: v.requestedBlocks || [],
      routeRsuIds: v.routeRsuIds || [],                     // 完整路由 RSU 序列（长久保存）
      upcomingRsuIds: v.upcomingRsuIds || [],               // 从 vehicle:update 实时更新（每 tick）
    }))
  }

  function updateVehiclePosition(vehicleData) {
    const idx = vehicles.value.findIndex(v => v.id === vehicleData.id)
    if (idx !== -1) {
      const existing = vehicles.value[idx]
      vehicles.value[idx] = {
        ...existing,
        ...vehicleData,
        upcomingRsuIds: existing.upcomingRsuIds || vehicleData.upcomingRsuIds || [],
      }
    } else {
      vehicles.value.push({
        ...vehicleData,
        heading: vehicleData.heading || 0,
        routeIndex: vehicleData.routeIndex || 0,
        requestedBlocks: vehicleData.requestedBlocks || [],
        routeRsuIds: vehicleData.routeRsuIds || [],
        upcomingRsuIds: vehicleData.upcomingRsuIds || [],
      })
    }
  }

  /**
   * 从 rsu:update 的 vehicleTiles 中合并实时 upcomingRsuIds 到每辆车
   */
  function updateVehicleUpcomingRsuIds(vehicleTiles) {
    if (!vehicleTiles) return
    for (const vehicleIdStr in vehicleTiles) {
      const vehicleId = Number(vehicleIdStr)
      const tileInfo = vehicleTiles[vehicleIdStr]
      if (tileInfo && tileInfo.upcomingRsuIds) {
        const v = vehicles.value.find(v => v.id === vehicleId)
        if (v) {
          v.upcomingRsuIds = tileInfo.upcomingRsuIds
        }
      }
    }
  }

  function setSelectedVehicle(id) {
    selectedVehicleId.value = id
  }

  function setDrivingStatus(status) {
    drivingStatus.value = status
  }

  function setSpeedLevel(level) {
    speedLevel.value = Math.max(1, Math.min(10, level))
  }

  function setRouteVehicleCount(routeId, count) {
    routeVehicleCounts.value = {
      ...routeVehicleCounts.value,
      [routeId]: Math.max(1, Math.min(10, count))
    }
  }

  function setAvgSpeed(speed) {
    avgSpeed.value = Math.max(0.5, Math.min(3.0, +speed.toFixed(1)))
  }

  function startTimer() {
    stopTimer()
    drivingStatus.value = 'running'
    const interval = Math.max(100, 1100 - speedLevel.value * 100)
    timer = setInterval(() => {
      elapsedTime.value += 0.1
    }, interval)
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function reset() {
    stopTimer()
    drivingStatus.value = 'idle'
    elapsedTime.value = 0
    vehicles.value = []
    selectedVehicleId.value = null
  }

  function pause() {
    stopTimer()
    drivingStatus.value = 'paused'
  }

  function resume() {
    startTimer()
  }

  return {
    vehicles,
    selectedVehicleId,
    drivingStatus,
    speedLevel,
    routeVehicleCounts,
    targetVehicleCount,
    avgSpeed,
    elapsedTime,
    selectedVehicle,
    vehicleCount,
    updateVehicles,
    updateVehiclePosition,
    updateVehicleUpcomingRsuIds,
    setSelectedVehicle,
    setDrivingStatus,
    setSpeedLevel,
    setRouteVehicleCount,
    setAvgSpeed,
    startTimer,
    stopTimer,
    reset,
    pause,
    resume
  }
})
