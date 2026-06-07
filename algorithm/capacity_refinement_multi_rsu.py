"""
Capacity_Refinement_MultiRSU - Multi-RSU capacity refinement with
dependency-aware tile retention.

Optimized version: removes low-utility tiles one by one instead of
clearing all and re-selecting. When dependency violations occur,
tries to find a higher-utility replacement from the same dependency
chain before falling back to removing the orphan tile.

Input:
    B_MWC: 1-D bool array, MWC cache decisions (length n)
    W_net: 1-D float array, net expected utility
    Tile_Size: 1-D float array, tile sizes
    dependency_matrix: (n, n) dependency matrix
    C_RSU: 1-D float array, capacity per RSU (length E)
    E: number of RSU regions
    X: tiles per RSU region

Output:
    B_Final: 1-D bool array, refined cache decisions
"""

import numpy as np


def _fix_dependency_violation(B_Final, dependency_matrix, Psi,
                              RSU_Indices, C_r, AccumulatedSize, r,
                              Tile_Size):
    """
    Check for dependency violations caused by tile removal within an RSU,
    and attempt to fix by adding high-utility parent tiles.

    Modifies B_Final and AccumulatedSize in-place.
    """
    violating_tiles = []
    for tile in RSU_Indices:
        if B_Final[tile]:
            parents = np.where(dependency_matrix[tile, :] == 1)[0]
            for p in parents:
                if not B_Final[p]:
                    violating_tiles.append(tile)
                    break

    if not violating_tiles:
        return

    # For each violating tile, try to find a high-utility parent
    for v_tile in violating_tiles:
        parents = np.where(dependency_matrix[v_tile, :] == 1)[0]
        # Only consider parents within same RSU
        parent_candidates = np.intersect1d(parents, RSU_Indices)
        # Only parents not already cached
        parent_candidates = parent_candidates[~B_Final[parent_candidates]]

        if len(parent_candidates) > 0:
            # Select the highest-utility-density parent
            best_parent = parent_candidates[np.argmax(Psi[parent_candidates])]
            # Check if adding this parent fits within capacity
            if AccumulatedSize[r] + Tile_Size[best_parent] <= C_r:
                B_Final[best_parent] = True
                AccumulatedSize[r] += Tile_Size[best_parent]
                print(f"  RSU{r+1} 保留父瓦片 {best_parent+1} "
                      f"修复 {v_tile+1} 的依赖")


def capacity_refinement_multi_rsu(B_MWC, W_net, Tile_Size,
                                  dependency_matrix, C_RSU, E, X):
    """
    Refine cache decisions to satisfy per-RSU capacity constraints.

    Parameters
    ----------
    B_MWC : np.ndarray
        1-D bool array, initial MWC cache decisions (length E*X).
    W_net : np.ndarray
        1-D float array, net expected utility per tile.
    Tile_Size : np.ndarray
        1-D float array, size of each tile.
    dependency_matrix : np.ndarray
        (n, n) dependency matrix.
    C_RSU : np.ndarray
        1-D array, capacity limit per RSU (length E).
    E : int
        Number of RSU regions.
    X : int
        Tiles per RSU region.

    Returns
    -------
    B_Final : np.ndarray
        1-D bool array, refined cache decisions.
    """
    num_tiles = len(W_net)
    B_Final = B_MWC.copy()  # preserve initial MWC cache set
    Psi = W_net / Tile_Size  # utility density (higher = keep priority)

    # ---- 1. Initialize per-RSU current sizes ----
    AccumulatedSize = np.zeros(E)
    for r in range(E):
        start_idx = r * X
        end_idx = (r + 1) * X
        AccumulatedSize[r] = np.sum(
            B_Final[start_idx:end_idx] * Tile_Size[start_idx:end_idx]
        )

    # ---- 2. Per-RSU capacity refinement: remove lowest-utility tiles ----
    for r in range(E):
        C_r = C_RSU[r]
        start_idx = r * X
        end_idx = (r + 1) * X
        RSU_Indices = np.arange(start_idx, end_idx)
        CurrentSize = AccumulatedSize[r]

        if CurrentSize <= C_r:
            print(f"  RSU {r+1} 容量 ({CurrentSize:.0f}) "
                  f"满足约束 ({C_r:.0f})。")
            continue

        print(f"  RSU {r+1} 容量超限 ({CurrentSize:.0f} > {C_r:.0f})。"
              f" 逐次剔除低效用瓦片...")

        # Get cached tiles within this RSU
        Cached_Tiles = RSU_Indices[B_Final[RSU_Indices]]
        if len(Cached_Tiles) == 0:
            continue

        # Sort by utility density ascending (remove lowest first)
        psi_vals_order = np.argsort(Psi[Cached_Tiles])  # ascending
        Tiles_To_Remove = Cached_Tiles[psi_vals_order]

        remove_count = 0
        for tile_idx in Tiles_To_Remove:
            if AccumulatedSize[r] <= C_r:
                break

            tile_size = Tile_Size[tile_idx]
            B_Final[tile_idx] = False  # remove this low-utility tile
            AccumulatedSize[r] -= tile_size
            remove_count += 1

            # Check and fix dependency chain violations
            _fix_dependency_violation(
                B_Final, dependency_matrix, Psi, RSU_Indices,
                C_r, AccumulatedSize, r, Tile_Size
            )

        print(f"  RSU {r+1} 剔除 {remove_count} 个低效用瓦片，"
              f"最终容量: {AccumulatedSize[r]:.0f}")

    # ---- 3. Final global dependency validation ----
    print("--- 最终全局依赖校验 ---")
    iteration = 0
    while True:
        iteration += 1
        tiles_removed = 0
        violations_found = False

        for dependent_tile in range(num_tiles):
            if not B_Final[dependent_tile]:
                continue

            Parent_Tiles = np.where(
                dependency_matrix[dependent_tile, :] == 1
            )[0]

            for parent_tile in Parent_Tiles:
                if B_Final[parent_tile]:
                    continue  # parent is cached, OK

                # Try to replace parent: find a high-utility alternative
                # within the same RSU
                r_parent = parent_tile // X
                parent_rsu_start = r_parent * X
                parent_rsu_end = (r_parent + 1) * X

                # Candidate parents: not cached, within same RSU
                parent_candidates = np.arange(parent_rsu_start,
                                              parent_rsu_end)
                parent_candidates = parent_candidates[
                    ~B_Final[parent_candidates]
                ]

                if len(parent_candidates) > 0:
                    best_parent = parent_candidates[
                        np.argmax(Psi[parent_candidates])
                    ]
                    # Check if adding parent fits within capacity
                    current_rsu_size = np.sum(
                        B_Final[parent_rsu_start:parent_rsu_end]
                        * Tile_Size[parent_rsu_start:parent_rsu_end]
                    )
                    if (current_rsu_size + Tile_Size[best_parent]
                            <= C_RSU[r_parent]):
                        B_Final[best_parent] = True
                        AccumulatedSize[r_parent] += Tile_Size[best_parent]
                        print(f"  替换父瓦片：RSU{r_parent+1} "
                              f"保留 {best_parent+1} "
                              f"修复 {dependent_tile+1} 的依赖")
                        violations_found = True
                        break  # move to next dependent_tile

                # No alternative parent → remove orphan child tile
                B_Final[dependent_tile] = False
                r_dep = dependent_tile // X
                AccumulatedSize[r_dep] -= Tile_Size[dependent_tile]
                tiles_removed += 1
                violations_found = True
                break  # move to next dependent_tile

        if tiles_removed > 0:
            print(f"  第 {iteration} 轮依赖修正："
                  f"移除 {tiles_removed} 个违规子瓦片")

        if not violations_found:
            break

    # ---- 4. Print final per-RSU capacity ----
    for r in range(E):
        FinalSize = np.sum(
            B_Final[r * X:(r + 1) * X] * Tile_Size[r * X:(r + 1) * X]
        )
        print(f"  最终 RSU {r+1} 容量: {FinalSize:.0f} "
              f"(上限: {C_RSU[r]:.0f})")

    return B_Final
