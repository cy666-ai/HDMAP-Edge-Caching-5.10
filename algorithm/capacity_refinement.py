"""
Capacity_Refinement - Stage 3: dependency-aware reduction when capacity is
exceeded (single-RSU version).

Input:
    B_MWC: 1-D bool array, MWC algorithm's optimal set (may exceed capacity)
    W_net: 1-D array of net expected utility
    Tile_Size: 1-D array of tile sizes (typically all 1)
    dependency_matrix: (n, n) matrix, dependency_matrix[i, j] == 1 means
                       tile i depends on tile j
    C: scalar, maximum storage capacity of the RSU

Output:
    B_Final: 1-D bool array, final cache decisions satisfying capacity
             and dependency constraints

Algorithm:
    If the current cached set exceeds capacity C, tiles are greedily retained
    in descending order of utility density Psi[b] = W_net[b] / Tile_Size[b].
    When retaining a tile, all its prerequisite parent tiles (that were in the
    original MWC set) are also retained to satisfy dependencies.
"""

import numpy as np


def capacity_refinement(B_MWC, W_net, Tile_Size, dependency_matrix, C):
    """
    Refine cache decisions to satisfy single-RSU capacity constraints.

    Parameters
    ----------
    B_MWC : np.ndarray
        1-D bool array, initial MWC cache decisions.
    W_net : np.ndarray
        1-D float array, net expected utility per tile.
    Tile_Size : np.ndarray
        1-D float array, size of each tile.
    dependency_matrix : np.ndarray
        (n, n) matrix of dependencies.
    C : float
        Maximum storage capacity.

    Returns
    -------
    B_Final : np.ndarray
        1-D bool array, refined cache decisions.
    """
    num_tiles = len(W_net)
    B_Current = B_MWC.copy()
    CurrentSize = np.sum(B_Current * Tile_Size)

    if CurrentSize <= C:
        return B_Current

    # ---- 1. Compute utility density Psi[b] = W_net[b] / Tile_Size[b] ----
    Psi = W_net / Tile_Size

    # ---- 2. Identify tiles currently cached ----
    Indices_To_Consider = np.where(B_Current)[0]
    Psi_to_sort = Psi[Indices_To_Consider]

    # ---- 3. Sort by utility density descending ----
    sorted_local = np.argsort(-Psi_to_sort)  # descending
    Sorted_Indices_Global = Indices_To_Consider[sorted_local]

    # ---- 4. Dependency-aware greedy retention ----
    B_Final = np.zeros(num_tiles, dtype=bool)
    AccumulatedSize = 0.0

    for idx_g in Sorted_Indices_Global:
        # Check if we can retain this tile
        if AccumulatedSize + Tile_Size[idx_g] <= C:
            # Tentatively retain
            B_Final[idx_g] = True
            AccumulatedSize += Tile_Size[idx_g]

            # Find all parent tiles that this tile depends on
            Parent_Tiles = np.where(dependency_matrix[idx_g, :] == 1)[0]

            # Check if retaining parents would exceed capacity
            size_to_add = Tile_Size[idx_g]
            New_Parents_to_add = []

            for parent_idx in Parent_Tiles:
                # Parent must be in original MWC set but not yet retained
                if B_MWC[parent_idx] and not B_Final[parent_idx]:
                    New_Parents_to_add.append(parent_idx)
                    size_to_add += Tile_Size[parent_idx]

            # Final check: can we fit this tile + its newly needed parents?
            if AccumulatedSize - Tile_Size[idx_g] + size_to_add <= C:
                # Yes — retain tile and its parents
                B_Final[idx_g] = True
                AccumulatedSize = (AccumulatedSize - Tile_Size[idx_g]
                                   + size_to_add)
                for parent_idx in New_Parents_to_add:
                    B_Final[parent_idx] = True
            else:
                # No — skip this tile
                B_Final[idx_g] = False
                AccumulatedSize -= Tile_Size[idx_g]

    # Ensure final set is a subset of original MWC set
    B_Final = B_Final & B_MWC

    FinalSize = np.sum(B_Final * Tile_Size)
    print(f"  削减后最终容量: {FinalSize:.0f} (容量C={C:.0f})")

    return B_Final
