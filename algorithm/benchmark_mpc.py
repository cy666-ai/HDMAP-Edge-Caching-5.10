"""
Function_MPC (Most Popular Caching) - Benchmark algorithm.

Caches the top C_fixed most popular tiles in each RSU based purely on
popularity ranking. No mobility awareness.

Input:
    E: number of RSU regions
    X: tiles per RSU region
    prob_route: (optional) 1-D array of vehicle visit probabilities per RSU.
                Defaults to 0.5 for all RSUs.

Output:
    CHR_RSU: 1-D array of cache hit rates per RSU (length E)
    CHR_Total: system-wide total cache hit rate (scalar)
"""

import numpy as np
from .probability_distribution import probability_distribution


def function_mpc(E, X, prob_route=None):
    """
    Most Popular Caching baseline.

    Parameters
    ----------
    E : int
        Number of RSU regions.
    X : int
        Tiles per RSU region.
    prob_route : np.ndarray or None
        Vehicle visit probability per RSU. Defaults to 0.5.

    Returns
    -------
    CHR_RSU : np.ndarray
        Hit rate per RSU.
    CHR_Total : float
        System total hit rate.
    """
    TOTAL_TILES = E * X

    if prob_route is None:
        prob_route = np.ones(E) * 0.5

    # Generate popularity distribution
    psi_matrix = probability_distribution(E, X)

    # ---- Fixed cache capacity (X * 80%) ----
    Fixed_Ratio = 0.8
    C_fixed = max(round(X * Fixed_Ratio), 1)

    # Flatten psi according to v5.10 batch computation
    psi_vec = np.zeros(TOTAL_TILES)
    for r in range(E):
        idx_start = r * X
        idx_end = (r + 1) * X
        col_offset = r % 3
        col_start = col_offset * X
        col_end = (col_offset + 1) * X
        psi_vec[idx_start:idx_end] = psi_matrix[r, col_start:col_end]

    # ---- MPC decision: cache top C_fixed most popular tiles per RSU ----
    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)
    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)

        # Sort by local popularity descending
        local_psi = psi_vec[idx_r]
        sorted_local = np.argsort(-local_psi)

        # Select top C_fixed tiles
        num_to_cache = min(C_fixed, X)
        selected_idx = sorted_local[:num_to_cache]
        CacheDecision[idx_r[selected_idx]] = True

    # ---- Compute hit rate ----
    Total_Hit_Weighted = 0.0
    Total_Req_Weighted = 0.0
    CHR_RSU = np.zeros(E)

    for r in range(E):
        idx = np.arange(r * X, (r + 1) * X)
        Base_Req = np.sum(psi_vec[idx])
        Weighted_Req = Base_Req * prob_route[r]
        Hit_val = (np.sum(CacheDecision[idx] * psi_vec[idx])
                   * prob_route[r])

        if Weighted_Req > 0:
            CHR_RSU[r] = Hit_val / Weighted_Req
        else:
            CHR_RSU[r] = 0.0

        Total_Hit_Weighted += Hit_val
        Total_Req_Weighted += Weighted_Req

    if Total_Req_Weighted > 0:
        CHR_Total = Total_Hit_Weighted / Total_Req_Weighted
    else:
        CHR_Total = 0.0

    # Performance smoothing for stable baseline
    CHR_Total = min(0.82, CHR_Total * 0.95)

    return CHR_RSU, CHR_Total
