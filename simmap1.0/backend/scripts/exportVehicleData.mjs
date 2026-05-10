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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'vehicle_export.json');

// ============================================================
// 1. 道路网络定义（南京鼓楼区 6 条道路）
// ============================================================
const ROADS = [
    { id: 1, name: '中山北路',   start: [32.083, 118.771], end: [32.038, 118.767] },
    { id: 2, name: '中央路',     start: [32.078, 118.782], end: [32.042, 118.781] },
    { id: 3, name: '北京西路',   start: [32.058, 118.750], end: [32.058, 118.792] },
    { id: 4, name: '汉中路',     start: [32.046, 118.758], end: [32.046, 118.792] },
    { id: 5, name: '新模范马路', start: [32.072, 118.758], end: [32.072, 118.792] },
    { id: 6, name: '虎踞路',     start: [32.076, 118.752], end: [32.038, 118.752] },
];

// ============================================================
// 2. RSU 路口坐标（3 条南北路 × 3 条东西路 = 9 个交叉口）
// ============================================================
function computeIntersections() {
    // 南北道路（编号 1=中山北路, 2=中央路, 6=虎踞路）
    const nsRoads = ROADS.filter(r => [1, 2, 6].includes(r.id));
    // 东西道路（编号 3=北京西路, 4=汉中路, 5=新模范马路）
    const ewRoads = ROADS.filter(r => [3, 4, 5].includes(r.id));

    const intersections = [];
    let rsuId = 0;

    for (const ns of nsRoads) {
        for (const ew of ewRoads) {
            rsuId++;
            // 南北道路在东西路纬度上的经度插值
            const targetLat = ew.start[0]; // 东西路的纬度是常数
            const t = (targetLat - ns.start[0]) / (ns.end[0] - ns.start[0]);
            const lngAtIntersection = ns.start[1] + t * (ns.end[1] - ns.start[1]);

            intersections.push({
                id: rsuId,
                latitude: targetLat,
                longitude: lngAtIntersection,
                name: `${ns.name} & ${ew.name} 交叉口`,
                nsRoadId: ns.id,
                ewRoadId: ew.id,
            });
        }
    }
    return intersections;
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
        const jitter = 0.0002 * Math.sin(i * 1.5);
        points.push({
            latitude: +(lat + jitter).toFixed(6),
            longitude: +(lng + jitter * 0.5).toFixed(6),
        });
    }
    return points;
}

function buildRoadNetwork() {
    return ROADS.map(r => ({
        ...r,
        points: generateRoadPoints(r.start[0], r.start[1], r.end[0], r.end[1], 10),
    }));
}

// ============================================================
// 4. 车辆仿真引擎（精简版，独立运行）
// ============================================================
class VehicleExporter {
    constructor() {
        this.roadNetwork = buildRoadNetwork();
        this.intersections = computeIntersections();
        this.vehicles = [];
        this.vehiclePaths = [];
        this.tickRecords = []; // [{tick, vehicles: [...]}]
        this.tickCount = 0;

        this._initVehicles();
    }

    _initVehicles() {
        const vehicleCount = 5;
        for (let i = 0; i < vehicleCount; i++) {
            const road = this.roadNetwork[i % this.roadNetwork.length];
            const path = road.points;
            const startIdx = Math.floor(Math.random() * Math.max(1, path.length - 5));

            this.vehicles.push({
                id: i + 1,
                name: `车辆 ${i + 1}`,
                roadId: road.id,
                roadName: road.name,
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
     * 将 9 个 RSU 按纬度分为 3 个区域（走廊）:
     *   区域 1 (北): RSU [1,4,7] — 新模范马路走廊 (lat ~32.072)
     *   区域 2 (中): RSU [2,5,8] — 北京西路走廊   (lat ~32.058)
     *   区域 3 (南): RSU [3,6,9] — 汉中路走廊     (lat ~32.046)
     *
     * 统计每辆车经过每个区域的频次：
     *   - N-S 走向车辆（中山北路/中央路/虎踞路）经过全部 3 个区域
     *   - E-W 走向车辆只经过 1 个区域
     */
    computeRegionProbabilities() {
        const E = 3;
        const regionLats = [32.072, 32.058, 32.046]; // 每个区域的参考纬度
        const regionTolerance = 0.001; // ±~100m 纬度容差

        // regionCounts[r] = 经过区域 r 的车辆数
        const regionCounts = new Array(E).fill(0);
        const totalVehicles = this.vehicles.length;

        for (const v of this.vehicles) {
            const visitedRegions = new Set();

            // 检查车辆轨迹中经过哪些区域
            for (const pt of v.trajectory) {
                for (let r = 0; r < E; r++) {
                    if (Math.abs(pt.latitude - regionLats[r]) < regionTolerance) {
                        visitedRegions.add(r);
                    }
                }
            }

            for (const r of visitedRegions) {
                regionCounts[r]++;
            }
        }

        // 归一化到 [0.5, 0.95] 范围
        const maxCount = Math.max(...regionCounts, 1);
        const Prob_Route = regionCounts.map(c => 0.5 + (c / maxCount) * 0.45);

        return {
            regionCounts,
            Prob_Route,
            regionLats,
            E,
            RSU_per_region: 3,
            totalRSU: 9,
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
                centerLat: 32.059,
                centerLng: 118.769,
                totalTicks: this.tickCount,
                totalVehicles: this.vehicles.length,
                totalRoads: this.roadNetwork.length,
                totalRSU: 9,
                coordinateSystem: 'GCJ-02',
                description: 'simmap1.0 南京鼓楼区车辆仿真数据，供 HDMAP-Edge Caching 5.10 算法使用',
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
                roadId: v.roadId,
                roadName: v.roadName,
                trajectory: v.trajectory,
            })),
            tickRecords: this.tickRecords,
            rsuRegions: regionInfo,
            algorithmParams: {
                E: regionInfo.E,
                X: 150,
                RSU_per_region: 3,
                totalRSU: 9,
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
        console.log(`每区域 RSU 数: ${data.rsuRegions.RSU_per_region}`);
        console.log(`总 RSU 数: ${data.rsuRegions.totalRSU}`);
        console.log(`区域参考纬度: [${data.rsuRegions.regionLats.join(', ')}]`);
        console.log(`各区域车辆数: [${data.rsuRegions.regionCounts.join(', ')}]`);
        console.log(`Prob_Route: [${data.rsuRegions.Prob_Route.map(v => v.toFixed(4)).join(', ')}]`);

        return OUTPUT_FILE;
    }
}

// ============================================================
// 7. 主入口
// ============================================================
function main() {
    const totalTicks = parseInt(process.argv[2], 10) || 200;
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
        console.log(`${rsu.id}\t${rsu.latitude.toFixed(4)}\t${rsu.longitude.toFixed(4)}\t${rsu.name}`);
    }

    console.log('\n=== 使用说明 ===');
    console.log(`1. 在 MATLAB 中运行: HM_Sim_Main_Nanjing.m`);
    console.log(`2. 该脚本会自动加载 ${outputPath}`);
    console.log('3. 算法将基于南京道路网络和车辆轨迹进行 RSU 缓存优化');
    console.log('\n完成！');
}

main();
