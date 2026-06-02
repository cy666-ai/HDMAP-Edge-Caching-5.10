/**
 * exportVehicleData.mjs
 *
 * 导出 simmap1.0 仿真车辆轨迹数据，供 5.10 RSU 缓存算法使用
 *
 * 运行方式:
 *   node exportVehicleData.mjs [tick_count]
 *
 * 参数:
 *   tick_count: 采集的仿真步数（默认 200）
 *
 * 输出:
 *   ../data/vehicle_export.json  — 包含道路网络、车辆轨迹、RSU路口坐标的完整数据
 *
 * 流程:
 *   1. 启动 SimulationService，运行指定 tick 数
 *   2. 每 tick 记录所有车辆位置/速度/方向
 *   3. 计算 9 个 RSU 路口坐标（南京鼓楼区 6 条道路的交叉点）
 *   4. 统计每辆车经过的各 RSU 区域频次 → Prob_Route
 *   5. 输出 JSON 供 MATLAB 读取
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRouteCache } from '../src/utils/amapRoute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'vehicle_export.json');
const ROUTE_CACHE_FILE = path.join(DATA_DIR, 'route_paths.json');

// ============================================================
// 1. 道路网络定义（南京鼓楼区 6 条道路）
// ============================================================
const ROADS = [
    { id: 1, name: '中山北路',   start: [118.75797707525267,32.071239453028696], end: [118.81034025020665,32.07677700174204] },//古平岗地铁站到新庄地铁站
    { id: 2, name: '中央路',     start: [118.75586611575406,32.060421913675], end: [118.80587678028652,32.05743854612504] },//草场门地铁站到九华山地铁站
    { id: 3, name: '北京西路',   start: [118.76711201979688,32.04286332557932], end: [118.80596505656148,32.040492177973746] },//汉中门地铁站到西安门地铁站
    { id: 4, name: '汉中路',     start: [118.75797707525267,32.071239453028696], end: [118.76590251169397,32.04246391064989] },//古平岗地铁站到汉中门地铁站
    { id: 5, name: '新模范马路', start: [118.78411162470866,32.079932709933416], end: [118.78419797766223,32.041611022106075] },//新模范马路地铁站到新街口地铁站
    { id: 6, name: '虎踞路',     start: [118.81034025020665,32.07677700174204], end: [118.80461747503173,32.04042433596998] },//新庄地铁站到西安门地铁站
];

// ============================================================
// 2. 车辆路线定义（6条固定地铁站间路线）
// ============================================================
const ROUTE_DEFS = [
    {
        id: 1,
        name: '古平岗→新庄',
        start: '古平岗站',
        end: '新庄站',
        waypoints: [
            [32.071239453028696, 118.75797707525267],  // 古平岗站
            [32.072000000000000, 118.76500000000000],  // 向东
            [32.073000000000000, 118.77500000000000],  // 向东
            [32.074000000000000, 118.78500000000000],  // 向东
            [32.075000000000000, 118.79500000000000],  // 向东
            [32.076777001742040, 118.81034025020665],  // 新庄站
        ],
    },
    {
        id: 2,
        name: '草场门→九华山',
        start: '草场门站',
        end: '九华山站',
        waypoints: [
            [32.060421913675000, 118.75586611575406],  // 草场门站
            [32.060000000000000, 118.76200000000000],  // 北京西路
            [32.060000000000000, 118.77000000000000],  // 北京西路
            [32.059000000000000, 118.77800000000000],  // 北京西路（云南路附近）
            [32.058000000000000, 118.78500000000000],  // 北京东路（鼓楼附近）
            [32.057500000000000, 118.79500000000000],  // 北京东路
            [32.057438546125040, 118.80587678028652],  // 九华山站
        ],
    },
    {
        id: 3,
        name: '汉中门→西安门',
        start: '汉中门站',
        end: '西安门站',
        waypoints: [
            [32.042863325579320, 118.76711201979688],  // 汉中门站
            [32.042500000000000, 118.77500000000000],  // 汉中路
            [32.041500000000000, 118.78300000000000],  // 汉中路
            [32.041000000000000, 118.79000000000000],  // 汉中路东段
            [32.040500000000000, 118.79800000000000],  // 汉中路东段
            [32.040492177973746, 118.80596505656148],  // 西安门站
        ],
    },
    {
        id: 4,
        name: '古平岗→汉中门',
        start: '古平岗站',
        end: '汉中门站',
        waypoints: [
            [32.071239453028696, 118.75797707525267],  // 古平岗站
            [32.066000000000000, 118.76000000000000],  // 虎踞路
            [32.060000000000000, 118.76200000000000],  // 虎踞路
            [32.055000000000000, 118.76400000000000],  // 虎踞路
            [32.050000000000000, 118.76500000000000],  // 虎踞路
            [32.042863325579320, 118.76711201979688],  // 汉中门站
        ],
    },
    {
        id: 5,
        name: '新模范马路→新街口',
        start: '新模范马路站',
        end: '新街口站',
        waypoints: [
            [32.079932709933416, 118.78411162470866],  // 新模范马路站
            [32.075000000000000, 118.78410000000000],  // 中央路
            [32.070000000000000, 118.78410000000000],  // 中央路
            [32.065000000000000, 118.78410000000000],  // 中央路
            [32.060000000000000, 118.78410000000000],  // 中央路
            [32.055000000000000, 118.78410000000000],  // 中央路
            [32.050000000000000, 118.78410000000000],  // 中央路
            [32.045000000000000, 118.78410000000000],  // 中央路
            [32.041611022106075, 118.78419797766223],  // 新街口站
        ],
    },
    {
        id: 6,
        name: '新庄→西安门',
        start: '新庄站',
        end: '西安门站',
        waypoints: [
            [32.076777001742040, 118.81034025020665],  // 新庄站
            [32.074000000000000, 118.80900000000000],  // 向西南
            [32.070000000000000, 118.80800000000000],  // 向南
            [32.065000000000000, 118.80700000000000],  // 向南
            [32.060000000000000, 118.80600000000000],  // 向南
            [32.055000000000000, 118.80600000000000],  // 向南
            [32.050000000000000, 118.80600000000000],  // 向南
            [32.040492177973746, 118.80596505656148],  // 西安门站
        ],
    },
];

// ============================================================
// 3. RSU 部署（仅沿车辆行驶路径覆盖）
// ============================================================
/**
 * RSU 覆盖半径（米）和部署间距
 * 间距500m，确保覆盖范围不重叠
 */
const RSU_RADIUS_M = 250;
const RSU_SPACING_M = 500;  // 沿路径部署间距（米），固定500m
const MIN_DIST_M = 500;     // 去重最小距离（米），与间距一致

/**
 * Haversine 公式计算两点距离（米）
 */
function haversineDist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 检查点是否与已有集足够远
 */
function isFarEnough(lat, lng, points, minDist) {
    return points.every(p => haversineDist(lat, lng, p.lat, p.lng) >= minDist);
}

/**
 * 计算 RSU 部署方案：
 *   仅沿6条车辆行驶路径每隔500m部署RSU（基于高德API真实路径几何）
 *   RSU覆盖半径250m，覆盖范围不重叠（间距≥500m）
 *
 * 路径数据优先从 route_paths.json（高德API真实路径）加载，
 * 不存在时使用内置路线定义。
 */
function computeRSUDeployment() {
    const allPoints = [];  // [{lat, lng, name}]

    // 加载车辆行驶路径数据
    const routes = loadRoutePathsForRSU();

    // 沿路径 polyline 每隔500m生成RSU点（使用累积 Haversine 距离）
    for (const route of routes) {
        const pts = route.points;
        if (pts.length < 2) continue;

        const cumDist = [0];
        for (let i = 1; i < pts.length; i++) {
            cumDist.push(cumDist[i - 1] + haversineDist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
        }
        const totalLength = cumDist[pts.length - 1];
        const numSegments = Math.max(1, Math.round(totalLength / RSU_SPACING_M));

        for (let s = 0; s <= numSegments; s++) {
            if (numSegments === 0) break;
            const targetDist = (s / numSegments) * totalLength;

            let segIdx = pts.length - 2;
            for (let i = 1; i < pts.length; i++) {
                if (cumDist[i] >= targetDist) { segIdx = i - 1; break; }
            }

            const segLen = cumDist[segIdx + 1] - cumDist[segIdx];
            const t = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0;
            const lat = pts[segIdx][0] + (pts[segIdx + 1][0] - pts[segIdx][0]) * t;
            const lng = pts[segIdx][1] + (pts[segIdx + 1][1] - pts[segIdx][1]) * t;

            if (isFarEnough(lat, lng, allPoints, MIN_DIST_M)) {
                const distFromStart = Math.round(targetDist);
                let ptName;
                if (s === 0) ptName = `${route.name} 起点`;
                else if (s >= numSegments) ptName = `${route.name} 终点`;
                else ptName = `${route.name} (${distFromStart}m)`;

                allPoints.push({ lat, lng, name: ptName });
            }
        }
    }

    console.log(`[Export] RSU候选点: ${allPoints.length}`);

    // 按纬度分配到 3 个走廊区域
    const regionLats = [32.072000, 32.058000, 32.046000];
    const regionThresholds = [32.065000, 32.050000];
    const regionNames = ['北区-新模范马路走廊', '中区-北京西路走廊（核心区）', '南区-汉中路走廊'];

    const regions = [[], [], []];
    for (const pt of allPoints) {
        if (pt.lat >= regionThresholds[0]) regions[0].push(pt);
        else if (pt.lat > regionThresholds[1]) regions[1].push(pt);
        else regions[2].push(pt);
    }

    // 构建 intersection 格式
    let rsuId = 0;
    const intersections = [];

    for (let r = 0; r < 3; r++) {
        for (const pt of regions[r]) {
            rsuId++;
            intersections.push({
                id: rsuId,
                latitude: pt.lat,
                longitude: pt.lng,
                name: pt.name,
                region: r + 1,
            });
        }
    }

    return {
        intersections,
        regionCounts: regions.map(r => r.length),
        regionNames,
        regionLats,
        totalRSU: intersections.length,
    };
}

/**
 * 加载车辆行驶路径数据用于 RSU 部署
 * 优先从 route_paths.json（高德API真实路径），回退到内置路线定义
 */
function loadRoutePathsForRSU() {
    const routesPath = path.resolve(DATA_DIR, 'route_paths.json');
    try {
        if (fs.existsSync(routesPath)) {
            const raw = fs.readFileSync(routesPath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.routes && data.routes.length > 0) {
                const routes = data.routes
                    .filter(r => r.points && r.points.length >= 2)
                    .map(r => ({
                        name: r.name,
                        points: r.points.map(p => [p.latitude, p.longitude]),
                    }));
                if (routes.length > 0) {
                    console.log(`[Export] 已加载 ${routes.length} 条高德API真实车辆行驶路径用于RSU部署`);
                    return routes;
                }
            }
        }
    } catch (err) {
        console.warn(`[Export] route_paths.json 加载失败: ${err.message}`);
    }

    // 回退: 使用内置路线航点
    console.log('[Export] 使用内置路线定义');
    return ROUTE_DEFS.map(r => ({
        name: r.name,
        points: r.waypoints,
    }));
}

// ============================================================
// 3. 生成道路坐标点（与 simulationService.js 保持一致）
// ============================================================
function generateRoadPoints(lat1, lng1, lat2, lng2, count) {
    const points = [];
    for (let i = 0; i <= count; i++) {
        const t = i / count;
        const lat = lat1 + (lat2 - lat1) * t;
        const lng = lng1 + (lng2 - lng1) * t;
        points.push({
            latitude: +(lat).toFixed(6),
            longitude: +(lng).toFixed(6),
        });
    }
    return points;
}

/**
 * 从路线航点生成平滑路径点
 */
function generateRoutePath(waypoints, pointsPerSegment = 5) {
    const points = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const [lat1, lng1] = waypoints[i];
        const [lat2, lng2] = waypoints[i + 1];
        for (let j = 0; j < pointsPerSegment; j++) {
            const t = j / pointsPerSegment;
            points.push({
                latitude: +(lat1 + (lat2 - lat1) * t).toFixed(6),
                longitude: +(lng1 + (lng2 - lng1) * t).toFixed(6),
            });
        }
    }
    const [lastLat, lastLng] = waypoints[waypoints.length - 1];
    points.push({ latitude: lastLat, longitude: lastLng });
    return points;
}

function buildRoadNetwork() {
    // 优先加载高德API真实道路数据
    const roadsPath = path.resolve(DATA_DIR, 'roads.json');
    try {
        if (fs.existsSync(roadsPath)) {
            const raw = fs.readFileSync(roadsPath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.roads && data.roads.length > 0) {
                const roads = data.roads.filter(r => r.points && r.points.length >= 2);
                if (roads.length > 0) {
                    console.log(`[Export] 已加载 ${roads.length} 条高德API真实道路数据`);
                    return roads.map(r => {
                        const roadDef = ROADS.find(rd => rd.name === r.name);
                        return {
                            id: r.id || (roadDef ? roadDef.id : 0),
                            name: r.name,
                            start: roadDef ? [roadDef.start[1], roadDef.start[0]] : [r.points[0].latitude, r.points[0].longitude],
                            end: roadDef ? [roadDef.end[1], roadDef.end[0]] : [r.points[r.points.length - 1].latitude, r.points[r.points.length - 1].longitude],
                            points: r.points,
                        };
                    });
                }
            }
        }
    } catch (err) {
        console.warn(`[Export] roads.json 加载失败，使用内置道路: ${err.message}`);
    }

    // 回退: 使用内置道路（ROADS为[lng,lat]格式，需转换）
    return ROADS.map(r => ({
        ...r,
        start: [r.start[1], r.start[0]],
        end: [r.end[1], r.end[0]],
        points: generateRoadPoints(r.start[1], r.start[0], r.end[1], r.end[0], 20),
    }));
}

// ============================================================
// 4. 车辆仿真引擎（精简版，独立运行）
// ============================================================
class VehicleExporter {
    constructor() {
        // 加载高德 API 缓存的真实路径数据
        this.amapRoutePaths = loadRouteCache(ROUTE_CACHE_FILE)
        if (this.amapRoutePaths.size > 0) {
            console.log(`[Export] 已加载 ${this.amapRoutePaths.size} 条高德地图真实车辆路径`)
        }

        this.roadNetwork = buildRoadNetwork();
        // 使用综合RSU部署方案替代旧的9交叉口方案
        const deployment = computeRSUDeployment();
        this.intersections = deployment.intersections;
        this.totalRSU = deployment.totalRSU;
        this.regionCounts = deployment.regionCounts;
        this.regionNames = deployment.regionNames;
        this.regionLats = deployment.regionLats;
        this.vehicles = [];
        this.vehiclePaths = [];
        this.tickRecords = [];
        this.tickCount = 0;

        this._initVehicles();
    }

    _initVehicles() {
        const VEHICLES_PER_ROUTE = 5;
        let vehicleId = 0;

        for (const route of ROUTE_DEFS) {
            // 优先使用高德真实路径，回退到线性插值
            const amapPath = this.amapRoutePaths.get(route.id)
            const path = (amapPath && amapPath.length >= 2)
                ? amapPath
                : generateRoutePath(route.waypoints)

            const sourceLabel = (amapPath && amapPath.length >= 2) ? '高德API' : '插值'
            console.log(`  [路线 ${route.id}] ${route.name}: ${path.length} 个路径点 (${sourceLabel})`)

            for (let i = 0; i < VEHICLES_PER_ROUTE; i++) {
                vehicleId++;
                // 均匀分布: 每路线5辆车分别从路径 0%, 20%, 40%, 60%, 80% 处起步
                // 加微小随机抖动(±2%)避免完全重叠
                const maxStartIdx = Math.max(1, path.length - 5);
                const baseRatio = i / VEHICLES_PER_ROUTE;
                const jitter = (Math.random() - 0.5) * 0.04; // ±2% 抖动
                const startIdx = Math.floor(Math.max(0, Math.min(baseRatio + jitter, 0.95)) * maxStartIdx);

                this.vehicles.push({
                    id: vehicleId,
                    name: `车辆 ${vehicleId} (${route.name})`,
                    routeId: route.id,
                    routeName: route.name,
                    roadId: route.id,
                    roadName: route.name,
                    latitude: path[startIdx].latitude,
                    longitude: path[startIdx].longitude,
                    speed: 30 + Math.random() * 40,
                    heading: 0,
                    pathProgress: startIdx / (path.length - 1),
                    completed: false,
                    trajectory: [],
                });

                this.vehiclePaths.push(path);
            }
        }

        console.log(`[Export] 已初始化 ${vehicleId} 辆车，分配至 ${ROUTE_DEFS.length} 条固定路线`);
        for (const route of ROUTE_DEFS) {
            const count = this.vehicles.filter(v => v.routeId === route.id).length;
            console.log(`  路线 ${route.id}. ${route.name}: ${count} 辆车`);
        }
    }

    _calculateHeading(lat1, lng1, lat2, lng2) {
        const dLng = lng2 - lng1;
        const dLat = lat2 - lat1;
        const angle = Math.atan2(dLng, dLat) * (180 / Math.PI);
        return ((angle % 360) + 360) % 360;
    }

    tick() {
        const step = 0.01; // 速度等级 5 对应的步长

        this.vehicles.forEach((vehicle, idx) => {
            const path = this.vehiclePaths[idx];
            if (!path || path.length < 2) return;

            // 已完成的车辆停在终点不再移动
            if (vehicle.completed) return;

            vehicle.pathProgress += step;
            if (vehicle.pathProgress >= 1) {
                vehicle.pathProgress = 1;
                vehicle.completed = true;
                // 锁定在终点位置
                const lastPt = path[path.length - 1];
                vehicle.latitude = lastPt.latitude;
                vehicle.longitude = lastPt.longitude;
                vehicle.speed = 0;
                return;
            }

            const totalSegments = path.length - 1;
            const exactIdx = vehicle.pathProgress * totalSegments;
            const segIdx = Math.min(Math.floor(exactIdx), totalSegments - 1);
            const segProgress = exactIdx - segIdx;

            const p1 = path[segIdx];
            const p2 = path[Math.min(segIdx + 1, path.length - 1)];

            vehicle.latitude = +(p1.latitude + (p2.latitude - p1.latitude) * segProgress).toFixed(6);
            vehicle.longitude = +(p1.longitude + (p2.longitude - p1.longitude) * segProgress).toFixed(6);
            vehicle.heading = +(this._calculateHeading(p1.latitude, p1.longitude, p2.latitude, p2.longitude)).toFixed(2);
            vehicle.speed = +(Math.max(10, 30 + 5 * 8 + Math.sin(this.tickCount * 0.1 + idx) * 10)).toFixed(2);

            vehicle.trajectory.push({
                tick: this.tickCount,
                latitude: vehicle.latitude,
                longitude: vehicle.longitude,
                speed: vehicle.speed,
                heading: vehicle.heading,
            });

            if (vehicle.trajectory.length > 200) {
                vehicle.trajectory = vehicle.trajectory.slice(-200);
            }
        });

        // 记录当前 tick 的快照
        this.tickRecords.push({
            tick: this.tickCount,
            vehicles: this.vehicles.map(v => ({
                id: v.id,
                latitude: v.latitude,
                longitude: v.longitude,
                speed: v.speed,
                heading: v.heading,
            })),
        });

        this.tickCount++;
    }

    run(totalTicks) {
        console.log(`[Export] 开始仿真，采集 ${totalTicks} 个 tick...`);
        for (let i = 0; i < totalTicks; i++) {
            this.tick();
        }
        console.log(`[Export] 仿真完成，共 ${this.tickCount} 个 tick。`);
    }

    // ============================================================
    // 5. 计算每辆车经过各 RSU 走廊的概率
    // ============================================================
    /**
     * RSU 按纬度分为 3 个走廊区域:
     *   区域 1 (北): lat >= 32.065 — 包含新模范马路站、玄武门站等
     *   区域 2 (中): 32.050 < lat < 32.065 — 鼓楼核心区（云南路、鼓楼、鸡鸣寺）
     *   区域 3 (南): lat <= 32.050 — 包含珠江路站、新街口站等
     *
     * 统计车辆轨迹经过每个区域的比例 → Prob_Route
     */
    computeRegionProbabilities() {
        const E = 3;
        const regionTolerance = 0.000001; // ±~100m 纬度容差

        const regionCounts = new Array(E).fill(0);

        for (const v of this.vehicles) {
            const visitedRegions = new Set();

            for (const pt of v.trajectory) {
                for (let r = 0; r < E; r++) {
                    if (Math.abs(pt.latitude - this.regionLats[r]) < regionTolerance) {
                        visitedRegions.add(r);
                    }
                }
            }

            for (const r of visitedRegions) {
                regionCounts[r]++;
            }
        }

        // 基于 RSU 数量占比分配概率
        const totalRSU = this.totalRSU;
        const rsuRatio = this.regionCounts.map(c => c / totalRSU);
        // 线性映射到 [0.5, 0.95]
        const maxRatio = Math.max(...rsuRatio);
        const minRatio = Math.min(...rsuRatio);
        const Prob_Route = this.regionCounts.map((_, i) => {
            if (maxRatio === minRatio) return 0.75;
            return 0.5 + ((rsuRatio[i] - minRatio) / (maxRatio - minRatio)) * 0.45;
        });

        return {
            regionCounts: this.regionCounts,
            totalRSU: this.totalRSU,
            Prob_Route,
            regionLats: this.regionLats,
            E,
            RSU_per_region: this.regionCounts,
        };
    }

    // ============================================================
    // 6. 输出完整 JSON
    // ============================================================
    toJSON() {
        const regionInfo = this.computeRegionProbabilities();

        return {
            meta: {
                exportTime: new Date().toISOString(),
                centerLat: 32.059000,
                centerLng: 118.769000,
                totalTicks: this.tickCount,
                totalVehicles: this.vehicles.length,
                totalRoads: this.roadNetwork.length,
                totalRSU: this.totalRSU,
                coordinateSystem: 'GCJ-02',
                description: 'simmap1.0 南京鼓楼区车辆仿真数据（综合RSU部署：地铁站+道路覆盖）',
            },
            roads: this.roadNetwork.map(r => ({
                id: r.id,
                name: r.name,
                start: { latitude: r.start[0], longitude: r.start[1] },
                end: { latitude: r.end[0], longitude: r.end[1] },
                points: r.points,
            })),
            intersections: this.intersections,
            vehicles: this.vehicles.map(v => ({
                id: v.id,
                name: v.name,
                routeId: v.routeId,
                routeName: v.routeName,
                roadId: v.roadId,
                roadName: v.roadName,
                trajectory: v.trajectory,
            })),
            tickRecords: this.tickRecords,
            rsuRegions: regionInfo,
            algorithmParams: {
                E: regionInfo.E,
                X: 150,
                RSU_per_region: regionInfo.RSU_per_region,
                totalRSU: this.totalRSU,
                alpha: 0.8,
                Capacity_Scale: 1.2,
                allowed_layers_per_block: [3, 4, 4],
                layer_profit_ranges: {
                    Raw: [25, 35],
                    Geo: [15, 25],
                    Sem: [8, 15],
                    Dyn: [-5, 5],
                },
            },
        };
    }

    writeJSON() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        const data = this.toJSON();
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Export] 数据已写入: ${OUTPUT_FILE}`);
        console.log(`[Export] 文件大小: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);

        // 同时输出简化的 Prob_Route 信息
        console.log('\n=== 路线概率 Prob_Route ===');
        console.log(`E (区域数): ${data.rsuRegions.E}`);
        console.log(`每区域 RSU 数: [${data.rsuRegions.RSU_per_region.join(', ')}]`);
        console.log(`总 RSU 数: ${data.rsuRegions.totalRSU}`);
        console.log(`区域参考纬度: [${data.rsuRegions.regionLats.join(', ')}]`);
        console.log(`各区域车辆数: [${data.rsuRegions.regionCounts.join(', ')}]`);
        console.log(`Prob_Route: [${data.rsuRegions.Prob_Route.map(v => v.toFixed(6)).join(', ')}]`);

        return OUTPUT_FILE;
    }
}

// ============================================================
// 7. 主入口
// ============================================================
function main() {
    const totalTicks = parseInt(process.argv[2], 10) || 300;
    console.log('========================================');
    console.log('  simmap1.0 → 5.10 车辆数据导出工具');
    console.log('========================================\n');

    const exporter = new VehicleExporter();
    exporter.run(totalTicks);
    const outputPath = exporter.writeJSON();

    // 打印 RSU 路口表
    console.log('\n=== RSU 路口坐标 ===');
    console.log('ID\t纬度\t\t经度\t\t路口名');
    for (const rsu of exporter.intersections) {
        console.log(`${rsu.id}\t${rsu.latitude.toFixed(6)}\t${rsu.longitude.toFixed(6)}\t${rsu.name}`);
    }

    console.log('\n=== 使用说明 ===');
    console.log(`1. 在 MATLAB 中运行: HM_Sim_Main_Nanjing.m`);
    console.log(`2. 该脚本会自动加载 ${outputPath}`);
    console.log('3. 算法将基于南京道路网络和车辆轨迹进行 RSU 缓存优化');
    console.log('\n完成！');
}

main();
