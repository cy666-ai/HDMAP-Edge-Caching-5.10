# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

面向自动驾驶的分层高精地图边缘缓存系统 (HLR-Cache Edge Caching System for Autonomous Driving). The system simulates autonomous vehicles driving on real Nanjing road routes, each passing through a chain of Road-Side Units (RSUs) that cache map tiles. A Python MWC (Maximum Weight Closure) algorithm periodically optimizes which tiles each RSU should cache to maximize expected hit rate. A Vue 3 frontend visualizes this in real-time via Socket.IO.

## Commands

### Backend

```bash
cd simmap1.0/backend
npm run dev          # Start with --watch (auto-restart on file changes)
npm start            # Start without watch
```

Runs on `http://localhost:3000`.

### Frontend

```bash
cd simmap1.0/frontend
npm run dev          # Vite dev server
npm run build        # Production build (output: dist/)
npm run preview      # Preview production build
```

Dev server runs on `http://localhost:5173` (falls back to 5174+ if busy).

### Python Algorithm (standalone)

```bash
cd algorithm
pip install -r requirements.txt    # numpy, scipy, networkx
python hm_export_cache_decision.py  # Reads _vehicle_input.json, writes cache_decision.json
```

The algorithm is normally invoked by the backend via `child_process.spawn('python', ['../../algorithm/hm_export_cache_decision.py'])` every 5 simulation ticks.

There are no tests or linting scripts in this project.

## Architecture

```
simmap1.0/
├── backend/                  # Node.js (Express + Socket.IO + Sequelize/SQLite)
│   ├── server.js             # Bootstrap: creates HTTP server, attaches Socket.IO, starts listening
│   └── src/
│       ├── app.js            # Express app: CORS, JSON middleware, /health, /api/* routes
│       ├── routes/api.js     # REST API: /api/roads, /api/vehicles, /api/rsu, etc.
│       ├── models/           # Sequelize models (Road, Vehicle, Trajectory) backed by SQLite
│       ├── socket/index.js   # Socket.IO event wiring + cross-links services
│       ├── services/
│       │   ├── simulationService.js  # Vehicle movement engine: 30 cars on 6 fixed routes
│       │   ├── cachingService.js     # RSU cache hit-rate engine + MWC algorithm trigger
│       │   └── serviceRegistry.js    # Singleton holder for cross-module access
│       └── utils/
│           ├── amapRoute.js          # Gaode (Amap) Driving Route API client + file cache
│           └── rsuDeployment.js      # RSU placement: Haversine-based, 500m spacing
├── frontend/                 # Vue 3 + Vite + Element Plus + ECharts + Leaflet
│   └── src/
│       ├── router.js         # Single route: / → Dashboard
│       ├── stores/vehicleStore.js    # Pinia store (the only store): vehicles, status, timer
│       ├── services/socket.js        # Socket.IO client singleton (connect, re-bind, emit)
│       ├── views/Dashboard.vue       # Orchestrator: WebSocket listeners, rsuData flow, layout
│       └── components/
│           ├── MapView.vue           # Leaflet map: RSU markers, coverage circles, vehicle icons
│           ├── ControlPanel.vue      # Start/Pause/Reset buttons + speed slider
│           ├── DataDisplay.vue       # Real-time vehicle/tile monitor (monitor tab)
│           ├── RSUHitRate.vue        # Per-route hit-rate bars + recalc button
│           └── StatisticsPanel.vue   # 6 ECharts charts (statistics tab)
└── algorithm/                # Python MWC edge-caching optimizer (v5.10)
    ├── hm_export_cache_decision.py   # Main entry: 7-stage pipeline per route
    ├── probability_distribution.py   # Stage 1: Poisson+power-law request probability (BATCH_SIZE=3)
    ├── hm_mwc_solver.py              # Stage 5: MWC via networkx min-cut/max-flow
    ├── capacity_refinement_multi_rsu.py  # Stage 6: Per-RSU capacity refinement + dependency repair
    ├── capacity_refinement.py        # Simpler single-RSU variant (not used by pipeline)
    └── benchmark_*.py                # MPC, MAP, TRWC, MAMAB baselines for comparison
```

## Per-Tick Data Flow

1. `SimulationService` timer fires → moves each vehicle along its route path
2. `broadcastData()` → emits `vehicle:update` (all vehicle positions) to frontend via Socket.IO
3. Also calls `cachingService.onVehicleTick(vehicles, tickCount)` →
   - Tracks which vehicles entered RSU coverage zones (≤300m proximity)
   - Computes intersecting tiles between vehicle requested blocks and RSU cached blocks
   - Every 5 ticks: spawns `python algorithm/hm_export_cache_decision.py` to recompute optimal cache
4. `CachingService.startBroadcast()` → emits `rsu:update` every 5 seconds with per-route stats, RSU state, hit rates, vehicle tile progress

## Key Constants and Configuration

**Backend:**
- `CHUNKS_PER_RSU = 100` (`cachingService.js`) — tiles each RSU can store
- `RSU_PROXIMITY_M = 300` — vehicle-RSU communication range in meters
- `ALGO_INTERVAL_TICKS = 5` — run MWC algorithm every N simulation ticks
- RSU spacing: 500m along paths, cross-route deduplication at 250m radius
- 6 fixed routes: Nanjing Gulou district metro station pairs (古平岗→新庄, 草场门→九华山, etc.)
- 30 vehicles (5 per route)

**Algorithm (Python):**
- `BATCH_SIZE = 3` — probability reset every 3 RSUs to avoid diffusion over long paths
- `alpha = 0.055` — cost penalty coefficient in net utility calculation
- `Capacity_Scale = 2.0` — RSU capacity multiplier

## Python ⇄ Node.js Interface

The Node.js backend communicates with the Python algorithm exclusively through JSON files:

- **Input:** `simmap1.0/backend/data/_vehicle_input.json` — written by `CachingService.triggerAlgorithm()`, contains `{ algorithmParams: {...}, routes: [{routeId, E, X, vehicleCount}] }`
- **Output:** `simmap1.0/backend/data/cache_decision.json` — written by `hm_export_cache_decision.py`, read by `CachingService.loadResults()`, contains per-route `CacheDecision` (boolean array), `psi`, `W_net`, `CHR_RSU` (array), `CHR_Total`, `MaxNetUtility_MWC`, `MaxNetUtility_Final`

The backend polls for the output file with retries (up to 30 attempts, 200ms delay).

## Important Patterns

- The frontend has a single Pinia store (`vehicleStore`) and a single route (`/` → `Dashboard`). All data flows down through props from `Dashboard.vue`.
- `serviceRegistry.js` is necessary because `routes/api.js` needs the `CachingService` instance but has no reference to the Socket.IO layer where it's created. If adding new REST endpoints that need simulation state, use this registry.
- The Python algorithm processes routes independently (each route gets its own psi, W_net, dependency matrix, MWC solve). The benchmarks use separate probability distributions optimized for their strategies.
- `StatisticsPanel.vue` uses `persistedDensity` to avoid vehicle density data zeroing out when vehicles disappear between ticks. All 6 ECharts charts use `appendToBody: true` with `z-index: 9999` on tooltips to prevent clipping within the scrollable sidebar.
