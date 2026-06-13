"""
Function_MAMAB (Multi-Armed Bandit) - Online learning benchmark.

Uses Upper Confidence Bound (UCB) algorithm to learn optimal cache
decisions. Maintains per-RSU per-tile reward estimates R_avg and
visit counts J_kf. Runs T_step internal iterations per call.

Input:
    E: number of RSU regions
    X: tiles per RSU region
    Prob_Route: vehicle visit probability per RSU (length E)
    J_in: previous visit counts (E x X), or None to initialize
    R_in: previous reward estimates (E x X), or None to initialize

Output:
    CHR_Total: system-wide total cache hit rate
    J_out: updated visit counts
    R_out: updated reward estimates
"""

import numpy as np
from scipy.stats import poisson


def _probability_distribution_internal(E, X):
    """Internal probability distribution for MAMAB benchmark."""
    K = E * X
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

    psi = np.array(psi_rows)
    return psi


def function_mamab(E, X, Prob_Route, J_in=None, R_in=None):
    """
    Multi-Armed Bandit online learning step.

    Parameters
    ----------
    E : int
        Number of RSU regions.
    X : int
        Tiles per RSU region.
    Prob_Route : np.ndarray
        Vehicle visit probability per RSU (length E).
    J_in : np.ndarray or None
        Previous visit counts (E x X). Initialized to ones if None.
    R_in : np.ndarray or None
        Previous reward estimates (E x X). Initialized to zeros if None.

    Returns
    -------
    CHR_Total : float
        System total hit rate.
    J_out : np.ndarray
        Updated visit counts.
    R_out : np.ndarray
        Updated reward estimates.
    """
    T_step = 800
    Cache_Capacity = 30
    beta = 0.8

    psi_matrix = _probability_distribution_internal(E, X)

    if J_in is None:
        J_kf = np.ones((E, X))
    else:
        J_kf = J_in.copy()

    if R_in is None:
        R_avg = np.zeros((E, X))
    else:
        R_avg = R_in.copy()

    # ---- Online learning loop ----
    for t in range(T_step):
        # 1. Decision (UCB)
        C_decision = np.zeros((E, X), dtype=bool)
        for k in range(E):
            total_t = np.sum(J_kf[k, :])
            perturb = np.sqrt(2 * np.log(total_t + 1) / J_kf[k, :])
            R_hat = R_avg[k, :] + 0.8 * perturb

            top_idx = np.argsort(-R_hat)[:Cache_Capacity]
            C_decision[k, top_idx] = True

        # 2. Reward observation and state update
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

    # ---- Compute current hit rate ----
    Hits = 0.0
    Reqs = 0.0
    for k in range(E):
        idx_start = k * X
        idx_end = (k + 1) * X
        p_req = psi_matrix[k, idx_start:idx_end] * Prob_Route[k]
        Hits += np.sum(C_decision[k, :] * p_req)
        Reqs += np.sum(p_req)

    CHR_Total = Hits / max(Reqs, 1e-6)

    return CHR_Total, J_kf, R_avg
