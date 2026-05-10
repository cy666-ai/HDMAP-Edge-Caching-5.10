function B_Final = Capacity_Refinement_MultiRSU(B_MWC, W_net, Tile_Size, dependency_matrix, C_RSU, E, X)
% Capacity_Refinement_MultiRSU - 优化版：逐次剔除低效用瓦片+依赖感知替代保留
% 核心改进：
% 1. 不清空初始缓存，仅剔除超出容量的低效用瓦片
% 2. 按效用升序逐次剔除，而非全清重选
% 3. 依赖违规时优先替换同依赖链高效用瓦片，减少连锁剔除

num_tiles = length(W_net);
B_Final = B_MWC; % 保留MWC初始缓存集，不清空
Psi = W_net ./ Tile_Size; % 效用密度（越大越优先保留）
AccumulatedSize = zeros(1, E); 

% 1. 初始化各RSU当前容量
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    AccumulatedSize(r) = sum(B_Final(start_idx:end_idx) .* Tile_Size(start_idx:end_idx));
end

% 2. 逐RSU处理容量超限：逐次剔除低效用瓦片
for r = 1:E
    C_r = C_RSU(r);
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    RSU_Indices = start_idx:end_idx;
    CurrentSize = AccumulatedSize(r);
    
    % 若未超限，跳过
    if CurrentSize <= C_r
        disp(['RSU ', num2str(r), ' 容量 (', num2str(CurrentSize), ') 满足约束 (', num2str(C_r), ')。']);
        continue;
    end
    disp(['RSU ', num2str(r), ' 容量超限 (', num2str(CurrentSize), ' > ', num2str(C_r), ')。逐次剔除低效用瓦片...']);
    
    % 提取当前RSU内被缓存的瓦片（B_Final=1）
    Cached_Tiles = RSU_Indices(B_Final(RSU_Indices));
    if isempty(Cached_Tiles)
        continue;
    end
    
    % 按效用密度升序排序（先剔除效用最低的）
    [Psi_vals, Sorted_Indices] = sort(Psi(Cached_Tiles), 'ascend');
    Tiles_To_Remove = Cached_Tiles(Sorted_Indices);
    
    % 逐次剔除低效用瓦片，直到容量满足
    remove_count = 0;
    for tile_idx = Tiles_To_Remove
        if AccumulatedSize(r) <= C_r
            break;
        end
        
        % 暂存当前瓦片状态（用于依赖检查）
        tile_size = Tile_Size(tile_idx);
        B_Final(tile_idx) = false; % 剔除当前低效用瓦片
        AccumulatedSize(r) = AccumulatedSize(r) - tile_size;
        remove_count = remove_count + 1;
        
        % 3. 检查并修复依赖连锁剔除：尝试保留同依赖链高效用瓦片
        fix_dependency_violation(B_Final, dependency_matrix, Psi, RSU_Indices, C_r, AccumulatedSize, r, Tile_Size);
    end
    
    disp(['RSU ', num2str(r), ' 剔除 ', num2str(remove_count), ' 个低效用瓦片，最终容量: ', num2str(AccumulatedSize(r))]);
end

% 4. 最终全局依赖校验（仅剔除无法修复的违规）
disp('--- 最终全局依赖校验 ---');
violations_fixed = true;
iteration = 0;
while violations_fixed
    violations_fixed = false;
    tiles_removed = 0;
    iteration = iteration + 1;
    
    for dependent_tile = 1:num_tiles
        if B_Final(dependent_tile) == 1
            Parent_Tiles = find(dependency_matrix(dependent_tile, :) == 1);
            for parent_tile = Parent_Tiles
                if B_Final(parent_tile) == 0
                    % 尝试替换父瓦片：找同RSU内次高效用的父瓦片替代
                    r_parent = ceil(parent_tile / X);
                    parent_rsu_start = (r_parent-1)*X + 1;
                    parent_rsu_end = r_parent*X;
                    parent_candidates = find(B_Final(parent_rsu_start:parent_rsu_end) == 0);
                    parent_candidates = parent_candidates + parent_rsu_start - 1;
                    
                    if ~isempty(parent_candidates)
                        % 按效用密度降序选替代父瓦片
                        [~, sorted_idx] = sort(Psi(parent_candidates), 'descend');
                        best_parent = parent_candidates(sorted_idx(1));
                        % 检查容量是否允许添加
                        if sum(B_Final(parent_rsu_start:parent_rsu_end) .* Tile_Size(parent_rsu_start:parent_rsu_end)) + Tile_Size(best_parent) <= C_RSU(r_parent)
                            B_Final(best_parent) = true;
                            AccumulatedSize(r_parent) = AccumulatedSize(r_parent) + Tile_Size(best_parent);
                            violations_fixed = true;
                            disp(['替换父瓦片：RSU', num2str(r_parent), ' 保留 ', num2str(best_parent), ' 修复 ', num2str(dependent_tile), ' 的依赖']);
                            break;
                        end
                    end
                    
                    % 无替代父瓦片，剔除子瓦片
                    B_Final(dependent_tile) = false;
                    r_dep = ceil(dependent_tile / X);
                    AccumulatedSize(r_dep) = AccumulatedSize(r_dep) - Tile_Size(dependent_tile);
                    violations_fixed = true;
                    tiles_removed = tiles_removed + 1;
                    break;
                end
            end
        end
    end
    
    if tiles_removed > 0
        disp(['第 ', num2str(iteration), ' 轮依赖修正：移除 ', num2str(tiles_removed), ' 个违规子瓦片']);
    end
end

% 输出最终容量
for r = 1:E
    FinalSize = sum(B_Final((r-1)*X + 1 : r*X) .* Tile_Size((r-1)*X + 1 : r*X));
    disp(['最终 RSU ', num2str(r), ' 容量: ', num2str(FinalSize), ' (上限: ', num2str(C_RSU(r)), ')']);
end

end

% 内部辅助函数：修复依赖违规（避免链式剔除）
function fix_dependency_violation(B_Final, dependency_matrix, Psi, RSU_Indices, C_r, AccumulatedSize, r, Tile_Size)
% 检查当前RSU内因剔除瓦片导致的依赖违规，尝试用高效用瓦片替代
violating_tiles = [];
for tile = RSU_Indices
    if B_Final(tile) == 1
        parents = find(dependency_matrix(tile, :) == 1);
        for p = parents
            if B_Final(p) == 0
                violating_tiles = [violating_tiles, tile];
                break;
            end
        end
    end
end

if isempty(violating_tiles)
    return;
end

% 对违规瓦片，尝试找同依赖链的高效用父瓦片
for v_tile = violating_tiles
    parents = find(dependency_matrix(v_tile, :) == 1);
    % 找当前RSU内未被缓存的父瓦片候选
    parent_candidates = intersect(parents, RSU_Indices);
    parent_candidates = parent_candidates(B_Final(parent_candidates) == 0);
    
    if ~isempty(parent_candidates)
        % 按效用密度降序选最优父瓦片
        [~, sorted_idx] = sort(Psi(parent_candidates), 'descend');
        best_parent = parent_candidates(sorted_idx(1));
        % 检查容量是否允许添加
        if AccumulatedSize(r) + Tile_Size(best_parent) <= C_r
            B_Final(best_parent) = true;
            AccumulatedSize(r) = AccumulatedSize(r) + Tile_Size(best_parent);
            disp(['RSU', num2str(r), ' 保留父瓦片 ', num2str(best_parent), ' 修复 ', num2str(v_tile), ' 的依赖']);
        end
    end
end
end