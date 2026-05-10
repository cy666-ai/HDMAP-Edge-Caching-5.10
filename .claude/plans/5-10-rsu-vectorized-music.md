# Plan: Real-time RSU Content Hit Rate Display

## Context

车辆数据在 Node.js 后端实时模拟并推送到前端展示，而 5.10 目录下的 MATLAB RSU 边缘缓存算法目前只能离线运行（通过 exportVehicleData.mjs 导出 → MATLAB 读取 → 计算命中率 → 写入 TXT）。前端完全没有 RSU 和命中率相关信息。

目标：打通实时数据流，让车辆在行驶过程中，后端周期性调用 MATLAB 算法，在前端展示 RSU 命中率。

**关键约束：**
- MATLAB 已安装，但启动需要 10~20 秒，不能每次计算都启动
- 命中率周期性更新（用户选择每 5 秒左右）
- 保持现有代码不变，增量添加新功能

---

## Architecture

```
SimulationService (每 tick)
  → updateVehicles()
  → CachingService.onVehicleTick(vehicles)
    → 更新各 RSU 走廊车辆计数 → 计算实时 Prob_Route
    → 用 MATLAB 输出的 CacheDecision + psi 计算命中率

CachingService (每 5 秒)
  → broadcast 'rsu:update' via WebSocket
  → 前端接收并更新显示

MATLAB (每 60 秒，或手动触发)
  → HM_Export_CacheDecision.m 读取 _vehicle_input.json
  → 完整算法管线（概率分布→MWC→容量精化→命中率）
  → 输出 cache_decision.json（含 CacheDecision, psi, CHR 等）
  → CachingService 重新加载结果
```

**核心思路：** MATLAB 只需输出 CacheDecision（450 维布尔向量）和 psi（概率分布），Node.js 在两次 MATLAB 运行之间用实时变化的 Prob_Route 自行计算命中率。这样命中率每 5 秒更新一次，而 MATLAB 只需每 60 秒启动一次。

---

## Step-by-Step Implementation

### Step 1: Create MATLAB Export Script

**新文件:** `5.10/HM_Export_CacheDecision.m`

从 `HM_Sim_Main_Nanjing.m` 提取完整算法管线，但将输出改为 JSON 文件而非控制台：

```
输入:  _vehicle_input.json（车辆数据 + Prob_Route + 算法参数）
输出:  cache_decision.json
  - CacheDecision (450×1 布尔数组)
  - psi (1×450 概率分布)
  - C_RSU (3 个区域的容量)
  - W_net (1×450 净收益)
  - CHR_Total (总命中率)
  - CHR_RSU (3 个区域的命中率)
  - algorithmResults (MWC/MPC/MAP/TRWC 对比)
  - dependency_violations
```

关键修改：
- 去掉 `clc; clear; close all`（不能用 clear）
- 从 `_vehicle_input.json` 加载 Prob_Route 和算法参数（而非从 vehicle_export.json）
- 改为读取外部输入 → 写入外部输出
- 增加 `jsonencode` 输出 CacheDecision 到 JSON

### Step 2: Create CachingService (Backend)

**新文件:** `simmap1.0/backend/src/services/cachingService.js`

```javascript
class CachingService {
  // RSU 位置定义（9 个 RSU，3 个走廊区域）
  // 从 5.10/RSU_Positions_Nanjing.txt 同步

  constructor(io) {
    this.io = io;
    this.regionCounts = [0, 0, 0];      // 每区域当前车辆数
    this.probRoute = [0.5, 0.5, 0.5];   // 当前路线概率
    this.cacheDecision = null;           // 从 MATLAB 加载
    this.psi = null;                     // 从 MATLAB 加载
    this.chr = { regions: [0,0,0], total: 0, algorithmResults: null };
    this.broadcastTimer = null;
    this.matlabTimer = null;
  }

  // 每 tick 被 SimulationService 调用
  onVehicleTick(vehicles) {
    this.updateRegionCounts(vehicles);
    this.updateProbRoute();
    this.computeHitRate();
  }

  // 从车辆位置更新区域计数
  // 区域参考纬度: 32.072(北/新模范马路), 32.058(中/北京西路), 32.046(南/汉中路)
  // tolerance: ±0.001（约 100m）

  // 计算命中率 (Hit Rate = Σ(Cached[k] * ψ[k] * Prob_Route[r]) / Σ(ψ[k] * Prob_Route[r]))
  // 纯数学运算，与 MATLAB 公式一致

  // 导出车辆数据触发 MATLAB 运行
  async triggerMatlab() {
    // 1. 收集当前车辆数据 → _vehicle_input.json
    // 2. 启动 MATLAB: matlab -batch "HM_Export_CacheDecision"
    // 3. 等待完成
    // 4. 读取 cache_decision.json
    // 5. 更新 cacheDecision, psi, chr
  }

  // 每 5 秒广播 rsu:update
  startBroadcast(intervalMs = 5000) { ... }

  // 每 60 秒触发 MATLAB
  startMatlabLoop(intervalMs = 60000) { ... }
}
```

核心方法 `computeHitRate()`:
```javascript
computeHitRate() {
  if (!this.cacheDecision || !this.psi) return;
  let totalHit = 0, totalReq = 0;
  for (let r = 0; r < 3; r++) {
    const start = r * this.X;  // X=150
    const end = start + this.X - 1;
    let baseReq = 0, hit = 0;
    for (let k = start; k <= end; k++) {
      baseReq += this.psi[k];
      if (this.cacheDecision[k]) hit += this.psi[k];
    }
    const reqW = baseReq * this.probRoute[r];
    const hitW = hit * this.probRoute[r];
    totalReq += reqW;
    totalHit += hitW;
    this.chr.regions[r] = reqW > 0 ? hitW / reqW : 0;
  }
  this.chr.total = totalReq > 0 ? totalHit / totalReq : 0;
}
```

### Step 3: Modify SimulationService (Backend)

**修改文件:** `simmap1.0/backend/src/services/simulationService.js`

在 `broadcastData()` 末尾或 `updateVehicles()` 末尾，添加：
```javascript
if (this.cachingService) {
  this.cachingService.onVehicleTick(this.vehicles);
}
```

在 `start()` 中启动 CachingService 的广播和 MATLAB 循环：
```javascript
start(speedLevel) {
  // ... existing code ...
  if (this.cachingService) {
    this.cachingService.startBroadcast();
    this.cachingService.startMatlabLoop();
  }
}
```

在 `reset()` 中停止：
```javascript
reset() {
  // ... existing code ...
  if (this.cachingService) {
    this.cachingService.stop();
  }
}
```

### Step 4: Modify Socket Handler (Backend)

**修改文件:** `simmap1.0/backend/src/socket/index.js`

```javascript
import { CachingService } from '../services/cachingService.js';

export function setupSocketHandlers(io) {
  const cachingService = new CachingService(io);
  simulationService.setCachingService(cachingService);

  io.on('connection', (socket) => {
    // ... existing handlers ...

    // 新增: 获取 RSU 数据
    socket.on('rsu:getData', () => {
      socket.emit('rsu:update', cachingService.getCurrentData());
    });

    // 新增: 手动触发 MATLAB 重算
    socket.on('rsu:recalc', async () => {
      await cachingService.triggerMatlab();
      socket.emit('rsu:update', cachingService.getCurrentData());
    });
  });
}
```

### Step 5: Add RSU Markers to MapView (Frontend)

**修改文件:** `simmap1.0/frontend/src/components/MapView.vue`

新增内容：
- RSU 位置常量（9 个经纬度点，与 5.10/RSU_Positions_Nanjing.txt 一致）
- RSU 圆形标记（L.circleMarker），按区域着色（3 种颜色）
- RSU 标记的 popup 显示 RSU ID、区域、命中率
- `watch` RSU 数据变化更新标记颜色/弹出内容
- 可选：点击 RSU 显示详细统计

```javascript
// RSU 位置（南京鼓楼区 9 个十字路口）
const RSU_POSITIONS = [
  { id: 1, lat: 32.0720, lng: 118.7700, name: '中山北路 & 新模范马路', region: 1 },
  { id: 2, lat: 32.0580, lng: 118.7688, name: '中山北路 & 北京西路', region: 2 },
  { id: 3, lat: 32.0460, lng: 118.7677, name: '中山北路 & 汉中路', region: 3 },
  { id: 4, lat: 32.0720, lng: 118.7820, name: '中央路 & 新模范马路', region: 1 },
  { id: 5, lat: 32.0580, lng: 118.7820, name: '中央路 & 北京西路', region: 2 },
  { id: 6, lat: 32.0460, lng: 118.7810, name: '中央路 & 汉中路', region: 3 },
  { id: 7, lat: 32.0720, lng: 118.7520, name: '虎踞路 & 新模范马路', region: 1 },
  { id: 8, lat: 32.0580, lng: 118.7520, name: '虎踞路 & 北京西路', region: 2 },
  { id: 9, lat: 32.0460, lng: 118.7520, name: '虎踞路 & 汉中路', region: 3 },
];
```

RSU 外观规格：
- 半径 10px，边框白色 2px
- Region 1 (北): `#F56C6C` (红)
- Region 2 (中): `#E6A23C` (橙)
- Region 3 (南): `#67C23A` (绿)
- 透明度随命中率变化：0.3~1.0

### Step 6: Create RSUHitRate.vue (Frontend)

**新文件:** `simmap1.0/frontend/src/components/RSUHitRate.vue`

结构：
```
┌─────────────────────────────┐
│  RSU 缓存命中率    [已连接]  │
├─────────────────────────────┤
│  ● 总命中率: 72.34%         │
│  ████████████░░░░ 0.7234    │
├─────────────────────────────┤
│  区域 1 (北/新模范马路)      │
│  命中率: 78.12%  车辆: 2    │
│  ████████████░░░░ 0.7812    │
│  路线概率: 0.9500            │
├─────────────────────────────┤
│  区域 2 (中/北京西路)        │
│  命中率: 65.30%  车辆: 1    │
│  ██████████░░░░░░ 0.6530    │
│  路线概率: 0.7250            │
├─────────────────────────────┤
│  区域 3 (南/汉中路)          │
│  命中率: 55.00%  车辆: 0    │
│  ████████░░░░░░░░ 0.5500    │
│  路线概率: 0.5000            │
├─────────────────────────────┤
│  算法对比                    │
│  MWC:  ████████████ 0.7234  │
│  MPC:  ██████████   0.5231  │
│  MAP:  ███████████   0.6125 │
│  TRWC: ████████████ 0.6872  │
├─────────────────────────────┤
│  [重新计算] 上次计算: 30s前  │
└─────────────────────────────┘
```

Props: `rsuData` object from WebSocket

使用 Element Plus 的 `el-progress` 组件实现进度条。

### Step 7: Integrate RSUHitRate into DataDisplay (Frontend)

**修改文件:** `simmap1.0/frontend/src/components/DataDisplay.vue`

将 RSUHitRate 组件放入 DataDisplay 现有内容下方（通过 `divider` 分隔），作为第二个 section。

### Step 8: Modify Dashboard to Listen for rsu:update (Frontend)

**修改文件:** `simmap1.0/frontend/src/views/Dashboard.vue`

新增：
```javascript
const rsuData = ref(null);

function onRsuUpdate(data) {
  rsuData.value = data;
}

onMounted(() => {
  // ... existing socket listeners ...
  socketService.on('rsu:update', onRsuUpdate);
});
```

将 `rsuData` 传给 `DataDisplay` / `RSUHitRate`：
```html
<DataDisplay :rsuData="rsuData" />
<RSUHitRate v-if="rsuData" :data="rsuData" />
```

### Step 9: Add RSU Store (Frontend, Optional)

如果需要跨组件共享 RSU 数据，可以创建 `frontend/src/stores/rsuStore.js`。

或者直接通过 Dashboard props 传递（更简单，因为只有 DataDisplay/RSUHitRate 需要）。

---

## Files to Create/Modify Summary

### New Files (4)
| File | Purpose |
|------|---------|
| `5.10/HM_Export_CacheDecision.m` | MATLAB 输出 CacheDecision + psi 为 JSON |
| `simmap1.0/backend/src/services/cachingService.js` | RSU 追踪 + 命中率计算 + MATLAB 调度 |
| `simmap1.0/frontend/src/components/RSUHitRate.vue` | 命中率前端展示组件 |
| `simmap1.0/backend/data/_vehicle_input.json` | (生成) 传给 MATLAB 的输入 |

### Modified Files (6)
| File | Changes |
|------|---------|
| `simmap1.0/backend/src/services/simulationService.js` | 注入 CachingService，每 tick 调用 onVehicleTick |
| `simmap1.0/backend/src/socket/index.js` | 初始化 CachingService，新增 rsu:getData/rsu:recalc 事件 |
| `simmap1.0/frontend/src/components/MapView.vue` | 添加 9 个 RSU 圆形标记 |
| `simmap1.0/frontend/src/components/DataDisplay.vue` | 嵌入 RSUHitRate 组件 |
| `simmap1.0/frontend/src/views/Dashboard.vue` | 监听 rsu:update 事件，传递数据 |
| `simmap1.0/frontend/src/services/socket.js` | (如果需要) 添加新的 emit 方法 |

---

## Verification

1. **启动后端:** `cd simmap1.0/backend && npm start`
2. **启动前端:** `cd simmap1.0/frontend && npm run dev`
3. **首次运行 MATLAB:** 点击前端"计算缓存决策"按钮（或等自动触发）
   - 后端写入 `_vehicle_input.json` → 调用 `matlab -batch HM_Export_CacheDecision`
   - MATLAB 输出 `cache_decision.json` → 后端加载
4. **启动模拟:** 点击"开始行驶"
   - 车辆开始运动 → CachingService 每 tick 更新区域计数 → 每 5 秒广播命中率
5. **验证前端显示:**
   - 地图上显示 9 个 RSU 标记（着色圆点）
   - RSUHitRate 面板显示各区域和总命中率
   - 命中率随时间变化（Prob_Route 随车辆位置变化）
6. **验证 MATLAB 重算:** 点击"重新计算"按钮或等待自动循环
   - 观察命中率变化（CacheDecision 可能随 Prob_Route 更新）
7. **边缘情况:**
   - 所有车辆完成 → 车辆数为 0 → Prob_Route 归一化处理
   - MATLAB 首次运行还未完成 → 显示"计算中"
   - MATLAB 运行失败 → 保留上次有效结果 + 日志提示
