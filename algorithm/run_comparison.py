#!/usr/bin/env python3
"""
run_comparison.py — 5-算法对比分析脚本 (v5.10)

Runs all 5 caching algorithms (MWC, MPC, MAP, TRWC, MAMAB) for each route
and outputs per-route comparison results including:
  - CHR_Total (system-wide cache hit rate)
  - CHR_RSU (per-RSU hit rate array)
  - CHR_Variance (per-RSU fairness: variance of CHR_RSU)
  - Total_Hit / Total_Req (absolute hit & request counts)
  - elapsed_ms (computation time)

Usage:
    python run_comparison.py

Input:  ../simmap1.0/backend/data/_vehicle_input.json
Output: ../simmap1.0/backend/data/comparison_result.json
"""

import os
import sys
import json
import time
import datetime
import numpy as np

# Ensure algorithm package is importable
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from probability_distribution import probability_distribution
from hm_mwc_solver import hm_mwc_solver
from capacity_refinement_multi_rsu import capacity_refinement_multi_rsu

# ---- Search paths (mirror hm_export_cache_decision.py) ----
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

INPUT_SEARCH_PATHS = [
    os.path.join(PROJECT_ROOT, 'simmap1.0', 'backend', 'data',
                 '_vehicle_input.json'),
    os.path.join(os.getcwd(), '_vehicle_input.json'),
]

OUTPUT_SEARCH_PATHS = [
    os.path.join(PROJECT_ROOT, 'simmap1.0', 'backend', 'data',
                 'comparison_result.json'),
    os.path.join(os.getcwd(), 'comparison_result.json'),
]


def load_json(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(filepath, data):
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def find_input_file():
    for p in INPUT_SEARCH_PATHS:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(
        f"未找到 _vehicle_input.json。已搜索: {INPUT_SEARCH_PATHS}"
    )


def get_output_path(input_file):
    for inp, out in zip(INPUT_SEARCH_PATHS, OUTPUT_SEARCH_PATHS):
        if os.path.normpath(input_file) == os.path.normpath(inp):
            return out
    return os.path.join(os.path.dirname(input_file), 'comparison_result.json')


def _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms):
    """Build a standardized method result dict."""
    return {
        'CHR_Total': round(float(CHR_Total), 4),
        'CHR_RSU': [round(float(v), 4) for v in CHR_RSU],
        'Total_Hit': round(float(Total_Hit), 2),
        'Total_Req': round(float(Total_Req), 2),
        'elapsed_ms': round(elapsed_ms, 1),
    }


# ===================================================================
#  Benchmark implementations (copied from benchmark_*.py with
#  smoothing/caps removed for fair comparison)
# ===================================================================

V_REF = 36.0  # 参考速度 (km/h)，与 MWC 保持一致

def _speed_capacity(C_fixed, route_speed):
    """按速度缩放缓存容量，与 MWC speed_factor 机制一致。"""
    sf = V_REF / max(route_speed, 1.0)
    sf = max(0.2, min(sf, 5.0))
    return max(1, round(C_fixed * sf))


def _run_mpc(E, X, route_speed):
    """Most Popular Caching — capacity scales with speed. Returns dict."""
    t0 = time.perf_counter()
    TOTAL_TILES = E * X
    psi_matrix = probability_distribution(E, X)
    C_fixed = max(round(X * 0.55), 1)
    C_eff = min(_speed_capacity(C_fixed, route_speed), X)

    psi_vec = np.zeros(TOTAL_TILES)
    for r in range(E):
        idx_start = r * X
        idx_end = (r + 1) * X
        col_offset = r % 3
        col_start = col_offset * X
        col_end = (col_offset + 1) * X
        psi_vec[idx_start:idx_end] = psi_matrix[r, col_start:col_end]

    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)
    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)
        local_psi = psi_vec[idx_r]
        sorted_local = np.argsort(-local_psi)
        num_to_cache = min(C_eff, X)
        selected_idx = sorted_local[:num_to_cache]
        CacheDecision[idx_r[selected_idx]] = True

    CHR_RSU = np.zeros(E)
    prob_route = np.ones(E) * 0.5
    Total_Hit = 0.0
    Total_Req = 0.0
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        Base_Req = np.sum(psi_vec[idx])
        Weighted_Req = Base_Req * prob_route[r]
        Hit_val = np.sum(CacheDecision[idx] * psi_vec[idx]) * prob_route[r]
        CHR_RSU[r] = Hit_val / Weighted_Req if Weighted_Req > 0 else 0.0
        Total_Hit += Hit_val
        Total_Req += Weighted_Req
    CHR_Total = Total_Hit / Total_Req if Total_Req > 0 else 0.0
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms)


def _run_map(E, X, route_speed):
    """Mobility-Aware Probabilistic — capacity scales with speed. Returns dict."""
    t0 = time.perf_counter()
    TOTAL_TILES = E * X
    C_fixed = max(round(X * 0.18), 1)
    C_eff = min(_speed_capacity(C_fixed, route_speed), X)

    # Local Zipf distribution (same as benchmark_map.py)
    s = 0.8
    N = X
    ranks = np.arange(1, N + 1)
    pmf = (1.0 / (ranks ** s)) / np.sum(1.0 / (np.arange(1, N + 1) ** s))
    psi_matrix = np.zeros((E, E * X))
    for r in range(E):
        idx_range = np.arange(r * X, (r + 1) * X)
        psi_matrix[r, idx_range] = pmf[np.random.permutation(N)]

    psi_vec = np.zeros(TOTAL_TILES)
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        psi_vec[idx] = psi_matrix[r, idx]

    prob_route = np.ones(E) * 0.35
    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)
    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)
        map_score = psi_vec[idx_r] * prob_route[r]
        sorted_idx = np.argsort(-map_score)
        num_to_cache = min(C_eff, X)
        selected_idx = sorted_idx[:num_to_cache]
        CacheDecision[idx_r[selected_idx]] = True

    CHR_RSU = np.zeros(E)
    Total_Hit = 0.0
    Total_Req = 0.0
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        Base_Req = np.sum(psi_vec[idx]) * prob_route[r]
        Hit_val = np.sum(CacheDecision[idx] * psi_vec[idx]) * prob_route[r]
        CHR_RSU[r] = Hit_val / Base_Req if Base_Req > 0 else 0.0
        Total_Hit += Hit_val
        Total_Req += Base_Req
    CHR_Total = Total_Hit / Total_Req if Total_Req > 0 else 0.0
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms)


def _run_trwc(E, X, route_speed):
    """Trajectory-based Relayed Wireless Caching — capacity scales with speed. Returns dict."""
    t0 = time.perf_counter()
    TOTAL_TILES = E * X
    C_fixed = max(round(X * 0.18), 1)
    C_eff = min(_speed_capacity(C_fixed, route_speed), X)

    # Same Zipf distribution as MAP
    s = 0.8
    N = X
    ranks = np.arange(1, N + 1)
    pmf = (1.0 / (ranks ** s)) / np.sum(1.0 / (np.arange(1, N + 1) ** s))
    psi_matrix = np.zeros((E, E * X))
    for r in range(E):
        idx_range = np.arange(r * X, (r + 1) * X)
        psi_matrix[r, idx_range] = pmf[np.random.permutation(N)]

    psi_vec = np.zeros(TOTAL_TILES)
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        psi_vec[idx] = psi_matrix[r, idx]

    prob_route = np.ones(E) * 0.35
    relay_gain = 1.35
    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)
    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)
        trwc_score = psi_vec[idx_r] * (1 + prob_route[r] * relay_gain)
        sorted_idx = np.argsort(-trwc_score)
        num_to_cache = min(C_eff, X)
        selected_idx = sorted_idx[:num_to_cache]
        CacheDecision[idx_r[selected_idx]] = True

    CHR_RSU = np.zeros(E)
    Total_Hit = 0.0
    Total_Req = 0.0
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        Base_Req = np.sum(psi_vec[idx]) * prob_route[r]
        Hit_val = np.sum(CacheDecision[idx] * psi_vec[idx]) * prob_route[r]
        CHR_RSU[r] = Hit_val / Base_Req if Base_Req > 0 else 0.0
        Total_Hit += Hit_val
        Total_Req += Base_Req
    CHR_Total = Total_Hit / Total_Req if Total_Req > 0 else 0.0
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms)


def _run_mamab(E, X, route_speed):
    """Multi-Armed Bandit — capacity scales with speed. Returns dict."""
    t0 = time.perf_counter()
    from scipy.stats import poisson

    K = E * X
    Cache_Capacity = min(_speed_capacity(22, route_speed), X)
    beta = 0.8
    T_step = 800

    # Internal Poisson distribution (same as benchmark_mamab.py)
    px = poisson.pmf(np.arange(1, K + 1), X)
    psi1 = np.zeros(K)
    for i in range(K):
        psi1[i] = 1 - poisson.cdf(i, X)

    psi_rows = []
    prev = psi1.copy()
    for r in range(E):
        curr_full = np.convolve(px, prev)
        curr = np.zeros(K)
        curr[:min(K, len(curr_full))] = curr_full[:min(K, len(curr_full))]
        psi_rows.append(curr)
        prev = curr.copy()
    psi_matrix = np.array(psi_rows)

    Prob_Route = np.ones(E) * 0.5
    J_kf = np.ones((E, X))
    R_avg = np.zeros((E, X))

    for t in range(T_step):
        C_decision = np.zeros((E, X), dtype=bool)
        for k in range(E):
            total_t = np.sum(J_kf[k, :])
            perturb = np.sqrt(2 * np.log(total_t + 1) / J_kf[k, :])
            R_hat = R_avg[k, :] + 0.8 * perturb
            top_idx = np.argsort(-R_hat)[:Cache_Capacity]
            C_decision[k, top_idx] = True

        for k in range(E):
            idx_start = k * X
            idx_end = (k + 1) * X
            req_prob = psi_matrix[k, idx_start:idx_end] * Prob_Route[k]
            obs_req = np.random.random(X) < req_prob
            reward_instant = (obs_req & C_decision[k, :]).astype(float) \
                * (1 + beta)
            for f in range(X):
                if C_decision[k, f]:
                    R_avg[k, f] = ((R_avg[k, f] * J_kf[k, f]
                                    + reward_instant[f])
                                   / (J_kf[k, f] + 1))
                    J_kf[k, f] = J_kf[k, f] + 1

    # Compute per-RSU hit rates (same as other benchmarks)
    CHR_RSU = np.zeros(E)
    Total_Hit = 0.0
    Total_Req = 0.0
    for k in range(E):
        idx_start = k * X
        idx_end = (k + 1) * X
        p_req = psi_matrix[k, idx_start:idx_end] * Prob_Route[k]
        hits_r = np.sum(C_decision[k, :] * p_req)
        reqs_r = np.sum(p_req)
        CHR_RSU[k] = hits_r / reqs_r if reqs_r > 0 else 0.0
        Total_Hit += hits_r
        Total_Req += reqs_r
    CHR_Total = Total_Hit / max(Total_Req, 1e-6)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms)


# ===================================================================
#  MWC (calls the real pipeline, matching hm_export_cache_decision.py)
# ===================================================================

def run_mwc(route_info, alpha, Capacity_Scale, allowed_layers_per_block,
            layer_profit_ranges):
    """
    Run the full MWC pipeline for one route. Returns method result dict.
    Adapted from hm_export_cache_decision.process_route().
    """
    t0 = time.perf_counter()
    V_REF = 36.0
    E = route_info['E']
    X = route_info['X']
    route_speed = float(route_info.get('speedKmh', V_REF))
    route_speed = max(route_speed, 1.0)
    speed_factor = V_REF / route_speed
    speed_factor = max(0.2, min(speed_factor, 5.0))
    TOTAL_TILES = E * X

    if E < 1 or X < 1:
        return _build_method_result(0.0, np.zeros(1), 0.0, 0.0,
                                    (time.perf_counter() - t0) * 1000)

    Prob_Route = np.ones(E) * 0.5
    Tile_Size = np.ones(TOTAL_TILES)
    C_RSU = np.round(Prob_Route * X * Capacity_Scale)
    C_RSU = np.minimum(C_RSU, X).astype(int)
    C_RSU = np.maximum(C_RSU, round(X * 0.2)).astype(int)

    # Stage 1: Probability Distribution
    psi_matrix = probability_distribution(E, X)
    psi = np.zeros(TOTAL_TILES)
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        col_offset = r % 3
        col_start = col_offset * X
        col_end = (col_offset + 1) * X
        psi[start_idx:end_idx] = psi_matrix[r, col_start:col_end]

    psi_eff = np.clip(psi * speed_factor, 0.0, 0.99)

    # Stage 2: Tile Block Layer Assignment
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
            layer_count = temp_allowed[np.random.randint(len(temp_allowed))]
        else:
            layer_count = allowed_layers_per_block[
                np.random.randint(len(allowed_layers_per_block))]
        block_layer_counts.append(layer_count)
        start = TOTAL_TILES - remaining_tiles
        block_tile_indices.append(list(range(start, start + layer_count)))
        remaining_tiles -= layer_count
    NUM_BLOCKS = len(block_layer_counts)

    # Stage 3: Net Expected Utility
    W_net = np.zeros(TOTAL_TILES)
    profit_ranges_list = [
        layer_profit_ranges['Raw'], layer_profit_ranges['Geo'],
        layer_profit_ranges['Sem'], layer_profit_ranges['Dyn'],
    ]
    for b in range(NUM_BLOCKS):
        block_idx_list = block_tile_indices[b]
        block_layer_num = block_layer_counts[b]
        for l_idx in range(block_layer_num):
            layer_type = min(l_idx, len(profit_ranges_list) - 1)
            tile_idx = block_idx_list[l_idx]
            profit_range = profit_ranges_list[layer_type]
            profit = np.random.randint(profit_range[0], profit_range[1] + 1)
            p_val = psi_eff[tile_idx]
            W_net[tile_idx] = (p_val - alpha * (1 - p_val)) * profit

    # Stage 4: Dependency Matrix
    dependency_matrix = np.zeros((TOTAL_TILES, TOTAL_TILES), dtype=int)
    for b in range(NUM_BLOCKS):
        block_idx_list = block_tile_indices[b]
        block_layer_num = block_layer_counts[b]
        for l_idx in range(1, block_layer_num):
            dependent_tile = block_idx_list[l_idx]
            parent_tile = block_idx_list[l_idx - 1]
            dependency_matrix[dependent_tile, parent_tile] = 1

    # Stage 5: MWC Solver
    CacheDecision_MWC, _ = hm_mwc_solver(W_net, dependency_matrix)

    # Stage 6: Capacity Refinement
    is_overloaded = False
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        CurrentSize = np.sum(
            CacheDecision_MWC[start_idx:end_idx]
            * Tile_Size[start_idx:end_idx])
        if CurrentSize > C_RSU[r]:
            is_overloaded = True
            break
    if is_overloaded:
        CacheDecision_Final = capacity_refinement_multi_rsu(
            CacheDecision_MWC, W_net, Tile_Size,
            dependency_matrix, C_RSU, E, X)
    else:
        CacheDecision_Final = CacheDecision_MWC.copy()

    # Stage 7: Cache Hit Rate
    CHR_RSU = np.zeros(E)
    Total_Hit = 0.0
    Total_Req = 0.0
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        Tile_Indices_r = np.arange(start_idx, end_idx)
        Base_Request_r = np.sum(psi_eff[Tile_Indices_r])
        Request_Weighted_r = Base_Request_r * Prob_Route[r]
        Total_Req += Request_Weighted_r
        Hit_RSU_r = (np.sum(CacheDecision_Final[Tile_Indices_r]
                            * psi_eff[Tile_Indices_r])
                     * Prob_Route[r])
        Total_Hit += Hit_RSU_r
        CHR_RSU[r] = Hit_RSU_r / Request_Weighted_r if Request_Weighted_r > 0 else 0.0
    CHR_Total = Total_Hit / Total_Req if Total_Req > 0 else 0.0
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return _build_method_result(CHR_Total, CHR_RSU, Total_Hit, Total_Req, elapsed_ms)


# ===================================================================
#  Main
# ===================================================================

def main():
    print("=== 5-算法对比分析 ===")
    input_file = find_input_file()
    print(f"读取: {input_file}")
    input_data = load_json(input_file)

    algo = input_data['algorithmParams']
    alpha = algo['alpha']
    Capacity_Scale = algo['Capacity_Scale']
    allowed_layers_per_block = algo['allowed_layers_per_block']
    layer_profit_ranges = algo['layer_profit_ranges']

    routes_input = input_data['routes']
    # Filter out non-default routes (keep only routes 1-6, those with names)
    routes_input = [r for r in routes_input
                    if r.get('routeName') and r['routeId'] <= 6]

    print(f"对比 {len(routes_input)} 条路线, 5 种算法...")

    # Fixed seed for reproducibility
    np.random.seed(42)

    results = []
    for route_info in routes_input:
        routeId = route_info['routeId']
        E = route_info['E']
        X = route_info['X']
        speed = float(route_info.get('speedKmh', 35))
        routeName = route_info.get('routeName', f'路线{routeId}')

        print(f"\n路线 {routeId} ({routeName}): E={E}, X={X}, 速度={speed:.0f}km/h")

        # Run all 5 algorithms (each returns a dict with all metrics)
        mwc_result = run_mwc(route_info, alpha, Capacity_Scale,
                             allowed_layers_per_block, layer_profit_ranges)
        print(f"  MWC:   CHR={mwc_result['CHR_Total']:.4f}, "
              f"Hit={mwc_result['Total_Hit']:.1f}/{mwc_result['Total_Req']:.1f}, "
              f"耗时={mwc_result['elapsed_ms']:.0f}ms")

        mpc_result = _run_mpc(E, X, speed)
        print(f"  MPC:   CHR={mpc_result['CHR_Total']:.4f}, "
              f"Hit={mpc_result['Total_Hit']:.1f}/{mpc_result['Total_Req']:.1f}, "
              f"耗时={mpc_result['elapsed_ms']:.0f}ms")

        map_result = _run_map(E, X, speed)
        print(f"  MAP:   CHR={map_result['CHR_Total']:.4f}, "
              f"Hit={map_result['Total_Hit']:.1f}/{map_result['Total_Req']:.1f}, "
              f"耗时={map_result['elapsed_ms']:.0f}ms")

        trwc_result = _run_trwc(E, X, speed)
        print(f"  TRWC:  CHR={trwc_result['CHR_Total']:.4f}, "
              f"Hit={trwc_result['Total_Hit']:.1f}/{trwc_result['Total_Req']:.1f}, "
              f"耗时={trwc_result['elapsed_ms']:.0f}ms")

        mamab_result = _run_mamab(E, X, speed)
        print(f"  MAMAB: CHR={mamab_result['CHR_Total']:.4f}, "
              f"Hit={mamab_result['Total_Hit']:.1f}/{mamab_result['Total_Req']:.1f}, "
              f"耗时={mamab_result['elapsed_ms']:.0f}ms")

        results.append({
            'routeId': routeId,
            'routeName': routeName,
            'E': E,
            'X': X,
            'speedKmh': speed,
            'methods': {
                'MWC': mwc_result,
                'MPC': mpc_result,
                'MAP': map_result,
                'TRWC': trwc_result,
                'MAMAB': mamab_result,
            }
        })

    output = {
        'routes': results,
        'methods': ['MWC', 'MPC', 'MAP', 'TRWC', 'MAMAB'],
        'timestamp': datetime.datetime.now().strftime('%d-%b-%Y %H:%M:%S'),
    }

    output_path = get_output_path(input_file)
    save_json(output_path, output)
    print(f"\n输出: {output_path}")
    print("=== 完成 ===")


if __name__ == '__main__':
    main()
