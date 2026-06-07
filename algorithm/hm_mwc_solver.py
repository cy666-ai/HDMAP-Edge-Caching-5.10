"""
HM_MWC_Solver - Maximum Weight Closure (MWC) cache problem solver.
Based on min-cut / max-flow graph theory.

Input:
    W_net: 1-D array of net expected utility for each tile (length n)
    dependency_matrix: (n, n) matrix, dependency_matrix[i, j] == 1 means
                       tile i depends on tile j (i → j)

Output:
    B_MWC: 1-D boolean array of cache decisions (True = cached)
    MaxUtility: scalar, maximum net utility value

Theory:
    The MWC problem is solved by constructing a flow network:
    - Positive-weight tiles connect from source S with capacity W(b)
    - Negative-weight tiles connect to sink T with capacity |W(b)|
    - Dependency edges (dependent → prerequisite) have infinite capacity
    - Min-cut / max-flow yields the optimal closure (source-side nodes)
"""

import numpy as np
import networkx as nx


def hm_mwc_solver(W_net, dependency_matrix):
    """
    Solve the Maximum Weight Closure problem for cache decisions.

    Parameters
    ----------
    W_net : np.ndarray
        1-D array of net expected utility values, length n.
    dependency_matrix : np.ndarray
        (n, n) boolean/int matrix. dependency_matrix[i, j] == 1 means
        tile i depends on tile j.

    Returns
    -------
    B_MWC : np.ndarray
        1-D bool array, length n. True = cache this tile.
    MaxUtility : float
        Maximum achievable net utility.
    """
    num_tiles = len(W_net)
    S_node = num_tiles       # source node ID (0-indexed)
    T_node = num_tiles + 1   # sink node ID (0-indexed)

    G = nx.DiGraph()
    total_positive_weight = 0.0

    # ---- 1. Edges based on net utility W(b) ----
    for b in range(num_tiles):
        Wb = W_net[b]
        if Wb > 0:
            # Profit edge: S → b, capacity = W(b)
            G.add_edge(S_node, b, capacity=float(Wb))
            total_positive_weight += Wb
        else:
            # Cost edge: b → T, capacity = |W(b)|
            G.add_edge(b, T_node, capacity=float(abs(Wb)))

    # ---- 2. Dependency constraint edges (infinite capacity) ----
    INF = float(np.sum(np.abs(W_net)) + 1.0)
    rows, cols = np.where(dependency_matrix == 1)
    for i in range(len(rows)):
        b_dependent = rows[i]      # tile A (depends on B)
        b_prerequisite = cols[i]   # tile B (required by A)
        # Critical: MWC dependency edge direction is dependent → prerequisite
        G.add_edge(int(b_dependent), int(b_prerequisite), capacity=INF)

    # ---- 3. Solve min-cut / max-flow ----
    try:
        cut_value, (S_set, T_set) = nx.minimum_cut(G, S_node, T_node)
    except Exception as e:
        raise RuntimeError(
            f"HM_MWC_Solver: max-flow/min-cut failed: {e}"
        ) from e

    # ---- 4. Determine MWC (source-side tiles) ----
    B_MWC = np.zeros(num_tiles, dtype=bool)
    for tile_id in S_set:
        if tile_id < num_tiles:
            B_MWC[tile_id] = True

    # ---- 5. Compute max net utility ----
    MaxUtility = total_positive_weight - cut_value

    return B_MWC, MaxUtility
