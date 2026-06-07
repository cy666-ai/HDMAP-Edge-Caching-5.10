"""
ProbabilityDistribution - Compute tile request probability distribution
for different hop counts (number of RSUs on a path).

Input:
    E: Number of edge nodes (RSU regions, determines output rows)
    X: Number of tile requests per RSU region

Output:
    psi: Tile request probability matrix (E x K).
         psi[r, k] = probability that tile k is requested on a path of
         (r+1) consecutive RSUs (0-indexed rows).

Version: v5.10
  - Uses power-law distribution to concentrate hot tile probabilities
  - Resets probability base every BATCH_SIZE RSUs to avoid diffusion
    over long paths
"""

import numpy as np
from scipy.stats import poisson


def probability_distribution(E, X):
    """
    Compute tile request probability distribution.

    Parameters
    ----------
    E : int
        Number of RSU regions (output rows).
    X : int
        Number of tiles per RSU region.

    Returns
    -------
    psi : np.ndarray
        Shape (E, K) where K = E * X. psi[r, k] is the probability.
    """
    BATCH_SIZE = 3
    K = E * X  # total number of tiles

    # ---- 1. Base request probability using Poisson ----
    # poisspdf(1:K, X * 0.7) in MATLAB
    px = poisson.pmf(np.arange(1, K + 1), X * 0.7)
    px = px / np.sum(px)  # normalize

    psi_rows = []

    # ---- 2. Initial 1-hop probability (psi1) using power-law ----
    # psi1_full(i) = 1 / (i^beta), beta = 0.6
    i = np.arange(1, K + 1, dtype=float)
    beta = 0.6
    psi1_full = 1.0 / (i ** beta)
    psi1_full = psi1_full / np.max(psi1_full)  # normalize by max
    psi1_full = psi1_full * 0.95 + 0.05 / K     # ensure minimum probability

    psi1 = psi1_full[:K]
    psi_rows.append(psi1)

    # Common normalization factor: peak value of psi1
    norm_factor = np.max(psi1)

    # ---- 3. Compute subsequent hop distributions via convolution ----
    # New logic (v5.10): reset to psi1 every BATCH_SIZE RSUs
    previous_psi = psi1.copy()

    for r in range(1, E):  # r = 1..E-1 corresponds to MATLAB r=2..E
        # Check if this RSU starts a new batch
        # MATLAB: mod(r-1, BATCH_SIZE) == 0 → new batch starts
        if r % BATCH_SIZE == 0:
            # New batch: use 1-hop distribution directly (no convolution)
            current_psi = psi1.copy()
        else:
            # Within batch: convolve with previous hop
            current_psi_full = np.convolve(px, previous_psi)

            # Truncate/pad to length K
            current_psi = np.zeros(K)
            length = min(K, len(current_psi_full))
            current_psi[:length] = current_psi_full[:length]

            # Normalize using common norm_factor
            current_psi = current_psi / norm_factor
            current_psi = current_psi * 0.95 + 0.05 / K

        psi_rows.append(current_psi)
        previous_psi = current_psi.copy()

    # ---- 4. Stack into final output matrix ----
    psi = np.array(psi_rows)  # shape (E, K)
    return psi
