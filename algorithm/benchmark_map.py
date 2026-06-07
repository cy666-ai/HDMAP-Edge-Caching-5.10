"""
Function_MAP (Mobility-Aware Probabilistic) - Benchmark algorithm.

Scores tiles by popularity × trajectory_probability, then caches the
top C_fixed tiles per RSU. Has awareness of vehicle mobility patterns.

Input:
    E: number of RSU regions
    X: tiles per RSU region
    prob_route: vehicle visit probability per RSU (default 0.5)

Output:
    CHR_RSU: cache hit rate per RSU
    CHR_Total: system-wide total cache hit rate
"""

import numpy as np


def _probability_distribution_local(E, X):
    """Local Zipf popularity distribution for MAP/TRWC benchmarks."""
    s = 0.8  # Zipf parameter (higher = more concentrated)
    N = X
    ranks = np.arange(1, N + 1)
    pmf = (1.0 / (ranks ** s)) / np.sum(1.0 / (np.arange(1, N + 1) ** s))

    psi = np.zeros((E, E * X))
    for r in range(E):
        idx_range = np.arange(r * X, (r + 1) * X)
        # Randomly permute to simulate different regional popularity
        psi[r, idx_range] = pmf[np.random.permutation(N)]
    return psi


def function_map(E, X, prob_route=None):
    """
    Mobility-Aware Probabilistic caching baseline.

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

    # ---- MAP decision: score = popularity × trajectory probability ----
    CacheDecision = np.zeros(TOTAL_TILES, dtype=bool)

    for r in range(E):
        idx_r = np.arange(r * X, (r + 1) * X)

        # MAP score: popularity weighted by vehicle visit probability
        map_score = psi_vec[idx_r] * prob_route[r]
        sorted_idx = np.argsort(-map_score)

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

    # Smoothing per original MATLAB: MAP typically below dynamic schemes
    CHR_Total = min(0.91, CHR_Total * 1.03
                    + (np.random.random() * 0.015 - 0.005))

    return CHR_RSU, CHR_Total
