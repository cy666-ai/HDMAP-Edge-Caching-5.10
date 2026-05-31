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
  // 已行驶时间（秒）
  const elapsedTime = ref(0)
  // 模拟时间间隔定时器
  let timer = null

  const selectedVehicle = computed(() =>
    vehicles.value.find(v => v.id === selectedVehicleId.value) || null
  )

  const vehicleCount = computed(() => vehicles.value.length)

  function updateVehicles(data) {
    vehicles.value = data.map(v => ({
      ...v,
      heading: v.heading || 0,
      speed: v.speed || 0,
      routeIndex: v.routeIndex || 0,
      requestedBlocks: v.requestedBlocks || [],
    }))
  }

  function updateVehiclePosition(vehicleData) {
    const idx = vehicles.value.findIndex(v => v.id === vehicleData.id)
    if (idx !== -1) {
      vehicles.value[idx] = {
        ...vehicles.value[idx],
        ...vehicleData
      }
    } else {
      vehicles.value.push({
        ...vehicleData,
        heading: vehicleData.heading || 0,
        routeIndex: vehicleData.routeIndex || 0,
        requestedBlocks: vehicleData.requestedBlocks || [],
      })
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
    elapsedTime,
    selectedVehicle,
    vehicleCount,
    updateVehicles,
    updateVehiclePosition,
    setSelectedVehicle,
    setDrivingStatus,
    setSpeedLevel,
    startTimer,
    stopTimer,
    reset,
    pause,
    resume
  }
})
