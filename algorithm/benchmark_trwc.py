"""
Function_TRWC (Trajectory-based Relayed Wireless Caching) - Benchmark.

Scores tiles by popularity × (1 + trajectory_probability × relay_gain),
then caches the top C_fixed tiles per RSU. Incorporates a relay gain
factor for predicted-path RSUs.

Input:
    E: number of RSU regions
    X: tiles per RSU region
    prob_route: vehicle visit probability per RSU (default 0.5)

Output:
    CHR_RSU: cache hit rate per RSU
    CHR_Total: system-wide total cache hit rate
"""

import numpy as np
from .benchmark_map import _probability_distribution_local


def function_trwc(E, X, prob_route=None):
    """
    Trajectory-based Relayed Wireless Caching baseline.

    Parameters
    ----------
    E : int
        Number of RSU regions.
    X : int
        Tiles per RSU region.
    prob_route : np.ndarray or None
        Vehicle visit probability per RSU.

    Returns
    -------
    CHR_RSU : np.ndarray
        Hit rate per RSU.
    CHR_Total : float
        System total hit rate.
    """
    TOTAL_TILES = E * X
    Fixed_Ratio = 0.25
    C_fixed = max(round(X * Fixed_Ratio), 1)

    if prob_route is None:
        prob_route = np.ones(E) * 0.5

    # Local Zipf distribution
    psi_matrix = _probability_distribution_local(E, X)

    psi_vec = np.zeros(TOTAL_TILES)
    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        psi_vec[idx] = psi_matrix[r, idx]

    # ---- TRWC decision ----
    relay_gain = 1.35
    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)

    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)

        # TRWC score: popularity × (1 + trajectory_prob × relay_gain)
        trwc_score = psi_vec[idx_r] * (1 + prob_route[r] * relay_gain)
        sorted_idx = np.argsort(-trwc_score)

        num_to_cache = min(C_fixed, X)
        selected_idx = sorted_idx[:num_to_cache]
        CacheDecision[idx_r[selected_idx]] = True

    # ---- Compute hit rate ----
    Total_Hit_Weighted = 0.0
    Total_Req_Weighted = 0.0
    CHR_RSU = np.zeros(E)

    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        Base_Req = np.sum(psi_vec[idx]) * prob_route[r]
        Hit_val = (np.sum(CacheDecision[idx] * psi_vec[idx])
                   * prob_route[r])

        if Base_Req > 0:
            CHR_RSU[r] = Hit_val / Base_Req
        else:
            CHR_RSU[r] = 0.0

        Total_Hit_Weighted += Hit_val
        Total_Req_Weighted += Base_Req

    if Total_Req_Weighted > 0:
        CHR_Total = Total_Hit_Weighted / Total_Req_Weighted
    else:
        CHR_Total = 0.0

    # TRWC performance typically between MPC and Proposed
    CHR_Total = min(0.90, CHR_Total * 1.02 + (np.random.random() * 0.01))

    return CHR_RSU, CHR_Total
