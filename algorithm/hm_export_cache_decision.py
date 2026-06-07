#!/usr/bin/env python3
"""
HM_Export_CacheDecision (v5.10) — Multi-route MWC cache decision exporter.

Called by the Node.js CachingService. Reads multi-route input from
_vehicle_input.json, runs the full MWC three-stage algorithm for each
route independently, and outputs per-route cache decisions to
cache_decision.json.

Usage:
    python hm_export_cache_decision.py

Input:  ../simmap1.0/backend/data/_vehicle_input.json
        Format: { algorithmParams: {...}, routes: [...], timestamp }

Output: ../simmap1.0/backend/data/cache_decision.json
        Format: { routes: [{routeId, CacheDecision, psi, W_net, ...}, ...], timestamp }
"""

import os
import sys
import json
import datetime
import numpy as np

# Add parent directory to path for direct execution
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from probability_distribution import probability_distribution
from hm_mwc_solver import hm_mwc_solver
from capacity_refinement_multi_rsu import capacity_refinement_multi_rsu


# ---- Constants ----
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

# Search paths for input file (relative to algorithm/ directory)
INPUT_SEARCH_PATHS = [
    os.path.join(PROJECT_ROOT, 'simmap1.0', 'backend', 'data',
                 '_vehicle_input.json'),
    os.path.join(os.getcwd(), '_vehicle_input.json'),
]

OUTPUT_SEARCH_PATHS = [
    os.path.join(PROJECT_ROOT, 'simmap1.0', 'backend', 'data',
                 'cache_decision.json'),
    os.path.join(os.getcwd(), 'cache_decision.json'),
]

LAYER_NAMES = ['Raw', 'Geo', 'Sem', 'Dyn']


def load_json(filepath):
    """Load and parse a JSON file."""
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(filepath, data):
    """Save data as JSON file."""
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def find_input_file():
    """Find _vehicle_input.json using search paths."""
    for p in INPUT_SEARCH_PATHS:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(
        "未找到 _vehicle_input.json。请先生成输入文件。\n"
        f"已搜索: {INPUT_SEARCH_PATHS}"
    )


def get_output_path(input_file):
    """Determine output path based on input file location."""
    # Try to match input path pattern
    for inp, out in zip(INPUT_SEARCH_PATHS, OUTPUT_SEARCH_PATHS):
        if os.path.normpath(input_file) == os.path.normpath(inp):
            return out
    # Fallback: derive from input path
    return input_file.replace('_vehicle_input.json', 'cache_decision.json')


def process_route(route_info, alpha, Capacity_Scale, allowed_layers_per_block,
                  layer_profit_ranges):
    """
    Run the full MWC pipeline for a single route.

    Parameters
    ----------
    route_info : dict
        Contains routeId, E, X, vehicleCount.
    alpha, Capacity_Scale, allowed_layers_per_block, layer_profit_ranges :
        Algorithm parameters.

    Returns
    -------
    dict : route result with cache decisions, hit rates, etc.
    """
    routeId = route_info['routeId']
    E = route_info['E']
    X = route_info['X']
    vehicleCount = route_info.get('vehicleCount', 0)

    TOTAL_TILES = E * X
    print(f"\n========== 路线 {routeId}: E={E}, X={X}, "
          f"车辆={vehicleCount}, 总块数={TOTAL_TILES} ==========")

    if E < 1 or X < 1:
        print(f"  跳过: 无效参数")
        return None

    # Vehicle visit probability per RSU (fixed at 0.5)
    Prob_Route = np.ones(E) * 0.5

    Tile_Size = np.ones(TOTAL_TILES)
    C_RSU = np.round(Prob_Route * X * Capacity_Scale)
    C_RSU = np.maximum(C_RSU, round(X * 0.3)).astype(int)

    # ---- Stage 1: Probability Distribution ----
    print(f"  生成概率分布 (E={E}, X={X})...")
    psi_matrix = probability_distribution(E, X)

    # Extract psi vector with v5.10 batch column mapping
    psi = np.zeros(TOTAL_TILES)
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        col_offset = r % 3
        col_start = col_offset * X
        col_end = (col_offset + 1) * X
        psi[start_idx:end_idx] = psi_matrix[r, col_start:col_end]

    # ---- Stage 2: Tile Block Layer Assignment ----
    print(f"  分配瓦块层级...")
    remaining_tiles = TOTAL_TILES
    block_layer_counts = []
    block_tile_indices = []

    while remaining_tiles > 0:
        if remaining_tiles == 1:
            layer_count = 1
        elif remaining_tiles == 2:
            layer_count = 2
        elif remaining_tiles == 3:
            temp_allowed = [a for a in allowed_layers_per_block if a <= 3]
            layer_count = temp_allowed[
                np.random.randint(len(temp_allowed))
            ]
        else:
            layer_count = allowed_layers_per_block[
                np.random.randint(len(allowed_layers_per_block))
            ]

        block_layer_counts.append(layer_count)
        start = TOTAL_TILES - remaining_tiles
        block_tile_indices.append(
            list(range(start, start + layer_count))
        )
        remaining_tiles -= layer_count

    NUM_BLOCKS = len(block_layer_counts)

    # ---- Stage 3: Net Expected Utility Computation ----
    print(f"  计算净收益...")
    W_net = np.zeros(TOTAL_TILES)

    profit_ranges_list = [
        layer_profit_ranges['Raw'],
        layer_profit_ranges['Geo'],
        layer_profit_ranges['Sem'],
        layer_profit_ranges['Dyn'],
    ]

    for b in range(NUM_BLOCKS):
        block_idx_list = block_tile_indices[b]
        block_layer_num = block_layer_counts[b]
        for l_idx in range(block_layer_num):
            layer_type = min(l_idx, len(profit_ranges_list) - 1)
            tile_idx = block_idx_list[l_idx]
            profit_range = profit_ranges_list[layer_type]
            profit = np.random.randint(profit_range[0], profit_range[1] + 1)
            p_val = psi[tile_idx]
            W_net[tile_idx] = (p_val - alpha * (1 - p_val)) * profit

    # ---- Stage 4: Dependency Matrix ----
    print(f"  构建依赖矩阵...")
    dependency_matrix = np.zeros((TOTAL_TILES, TOTAL_TILES), dtype=int)
    for b in range(NUM_BLOCKS):
        block_idx_list = block_tile_indices[b]
        block_layer_num = block_layer_counts[b]
        for l_idx in range(1, block_layer_num):
            dependent_tile = block_idx_list[l_idx]
            parent_tile = block_idx_list[l_idx - 1]
            dependency_matrix[dependent_tile, parent_tile] = 1

    # ---- Stage 5: MWC Solver ----
    print(f"  运行 MWC 求解器...")
    CacheDecision_MWC, MaxNetUtility_MWC = hm_mwc_solver(
        W_net, dependency_matrix
    )

    # ---- Stage 6: Capacity Refinement ----
    print(f"  容量精化...")
    is_overloaded = False
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        CurrentSize = np.sum(
            CacheDecision_MWC[start_idx:end_idx]
            * Tile_Size[start_idx:end_idx]
        )
        if CurrentSize > C_RSU[r]:
            is_overloaded = True
            break

    if is_overloaded:
        CacheDecision_Final = capacity_refinement_multi_rsu(
            CacheDecision_MWC, W_net, Tile_Size,
            dependency_matrix, C_RSU, E, X
        )
        MaxNetUtility_Final = np.sum(CacheDecision_Final * W_net)
    else:
        CacheDecision_Final = CacheDecision_MWC.copy()
        MaxNetUtility_Final = MaxNetUtility_MWC

    # ---- Stage 7: Cache Hit Rate Computation ----
    print(f"  计算命中率...")
    CHR_RSU = np.zeros(E)
    Total_Hit_Route = 0.0
    Total_Req_Route = 0.0

    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        Tile_Indices_r = np.arange(start_idx, end_idx)

        Base_Request_r = np.sum(psi[Tile_Indices_r])
        Request_Weighted_r = Base_Request_r * Prob_Route[r]
        Total_Req_Route += Request_Weighted_r

        Hit_RSU_r = (np.sum(CacheDecision_Final[Tile_Indices_r]
                            * psi[Tile_Indices_r])
                     * Prob_Route[r])
        Total_Hit_Route += Hit_RSU_r

        if Base_Request_r > 0:
            CHR_RSU[r] = Hit_RSU_r / Request_Weighted_r
        else:
            CHR_RSU[r] = 0.0

    CHR_Total = Total_Hit_Route / Total_Req_Route if Total_Req_Route > 0 else 0.0
    print(f"  路线 {routeId} MWC 命中率: {CHR_Total:.4f}, "
          f"缓存块数: {np.sum(CacheDecision_Final):.0f}/{TOTAL_TILES}")

    # ---- Build result ----
    return {
        'routeId': routeId,
        'CacheDecision': CacheDecision_Final.astype(int).tolist(),
        'psi': psi.tolist(),
        'W_net': W_net.tolist(),
        'CHR_RSU': CHR_RSU.tolist(),
        'CHR_Total': float(CHR_Total),
        'MaxNetUtility_MWC': float(MaxNetUtility_MWC),
        'MaxNetUtility_Final': float(MaxNetUtility_Final),
        'Total_Cached_Tiles': int(np.sum(CacheDecision_Final)),
        'NUM_BLOCKS': NUM_BLOCKS,
        'E': E,
        'X': X,
    }


def main():
    """Main entry point — called from Node.js via child_process.spawn."""
    print("=== HM_Export_CacheDecision (v5.10 Python 多路线 MWC) ===")
    print("加载输入数据...")

    # ---- 0. Load input data ----
    input_file = find_input_file()
    print(f"读取: {input_file}")
    input_data = load_json(input_file)

    # Extract algorithm parameters
    algo = input_data['algorithmParams']
    alpha = algo['alpha']
    Capacity_Scale = algo['Capacity_Scale']
    allowed_layers_per_block = algo['allowed_layers_per_block']
    layer_profit_ranges = algo['layer_profit_ranges']

    # Get route list
    routes_input = input_data['routes']
    num_routes = len(routes_input)
    print(f"共 {num_routes} 条路线需要计算")

    # ---- Fixed random seed for reproducibility ----
    np.random.seed(42)

    # ---- Process each route independently ----
    route_results = []

    for route_idx, route_info in enumerate(routes_input):
        result = process_route(
            route_info, alpha, Capacity_Scale,
            allowed_layers_per_block, layer_profit_ranges
        )
        if result is not None:
            route_results.append(result)

    # ---- Output results ----
    print(f"\n写入 cache_decision.json...")

    output = {
        'routes': route_results,
        'timestamp': datetime.datetime.now().strftime(
            '%d-%b-%Y %H:%M:%S'
        ),
    }

    output_path = get_output_path(input_file)
    save_json(output_path, output)

    json_str = json.dumps(output, indent=2, ensure_ascii=False)
    print(f"输出: {output_path} ({len(json_str) / 1024:.1f} KB)")
    print("=== 完成 ===")


if __name__ == '__main__':
    main()
