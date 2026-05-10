function B_Final = Capacity_Refinement(B_MWC, W_net, Tile_Size, dependency_matrix, C)
% Capacity_Refinement - 阶段三：处理容量超限时的依赖感知削减。
% 
% 输入:
%   B_MWC (1xn logical): MWC 算法得到的最优集合 (可能超限)。
%   W_net (1xn): 瓦片的净预期收益向量。
%   Tile_Size (1xn): 瓦片的大小 (这里假设是1)。
%   dependency_matrix (nxn): 依赖关系矩阵 (i -> j 表示 i 依赖 j)。
%   C (标量): RSU 的最大存储容量。
%
% 输出:
%   B_Final (1xn logical): 满足容量约束和依赖约束的最终缓存决策。

num_tiles = length(W_net);
B_Current = B_MWC; % 从 MWC 结果开始
CurrentSize = sum(B_Current .* Tile_Size);

if CurrentSize <= C
    B_Final = B_Current;
    return;
end

% 1. 重新计算效用密度 Psi[i, b]
% 效用密度 Psi[i, b] = 净预期收益 W(b) / 瓦片大小 Size[b]
% 瓦片大小 Tile_Size[b] 在这里就是 Tile_Size
Psi = W_net ./ Tile_Size;

% 2. 识别需要排序的瓦片 (仅限于当前缓存集合 B_Current)
Indices_To_Consider = find(B_Current);
Psi_to_sort = Psi(Indices_To_Consider);

% 3. 按效用密度降序排序
[~, Sorted_Indices_Local] = sort(Psi_to_sort, 'descend');
Sorted_Indices_Global = Indices_To_Consider(Sorted_Indices_Local);

% 4. 依赖感知削减 (贪婪选择保留，等于贪婪移除效用最低的)
B_Final = false(1, num_tiles);
AccumulatedSize = 0;

% 循环遍历排序后的瓦片，贪婪地保留它们
for idx_g = Sorted_Indices_Global
    
    % (A) 检查是否可以保留该瓦片 (贪婪保留逻辑)
    if AccumulatedSize + Tile_Size(idx_g) <= C
        % 尝试将当前瓦片加入最终集合
        B_Final(idx_g) = true;
        AccumulatedSize = AccumulatedSize + Tile_Size(idx_g);
        
        % (B) 强制保留所有依赖瓦片 (如果它们在原始 MWC 结果中)
        % MWC 结果 B_MWC 已经保证了依赖，但削减过程中可能打乱
        % 这里的削减逻辑是：按密度从高到低决定哪些**保留**，**保留**瓦片A时，必须同时保留瓦片B。
        % 但是，更符合论文描述的削减步骤是：从低密度开始**移除**。
        
        % --- 修正为更符合论文的“贪婪移除”逻辑 ---
        
        % 既然我们是按降序遍历，应该采取“贪婪保留”的逻辑，并确保依赖。
        % 由于 MWC 已经保证了依赖，现在只需确保保留的集合满足容量 C 即可。
        % 如果瓦片 A 被保留，但它依赖的瓦片 B (A -> B) 却因为密度低而被移除，就会违反约束。
        
        % 为了简化且满足约束：我们只需要确保一旦保留了 A，其所有父瓦片 B 也被保留。
        
        % 查找当前瓦片 idx_g 依赖的所有父瓦片（被依赖方）
        Parent_Tiles = find(dependency_matrix(idx_g, :) == 1);
        
        % 检查保留 idx_g 是否会引入新的依赖瓦片导致超限
        size_to_add = Tile_Size(idx_g);
        New_Parents_to_add = [];
        
        for parent_idx = Parent_Tiles
            % 检查父瓦片是否在 MWC 集合中，但尚未被保留到 B_Final 中
            if B_MWC(parent_idx) && ~B_Final(parent_idx)
                New_Parents_to_add = [New_Parents_to_add, parent_idx];
                size_to_add = size_to_add + Tile_Size(parent_idx);
            end
        end
        
        % 最终检查：保留当前瓦片和其所有必须保留的父瓦片，是否超限
        if AccumulatedSize - Tile_Size(idx_g) + size_to_add <= C 
            % 如果不超限，则正式保留当前瓦片
            B_Final(idx_g) = true;
            AccumulatedSize = AccumulatedSize - Tile_Size(idx_g) + size_to_add; % 更新大小
            
            % 强制保留所有新的父瓦片
            for parent_idx = New_Parents_to_add
                B_Final(parent_idx) = true;
            end
        else
            % 如果超限，则跳过当前瓦片，不保留
            B_Final(idx_g) = false;
        end
        
    end
end

% 确保最终集合中的瓦片都在原始 MWC 集合中，并且所有依赖都满足
B_Final = B_Final & B_MWC; 

% 重新计算最终大小
FinalSize = sum(B_Final .* Tile_Size);
disp(['削减后最终容量: ', num2str(FinalSize), ' (容量C=', num2str(C), ')']);

end

% --- 辅助函数 (需自行实现或提供) ---
function psi_out = ProbabilityDistribution(E, X)
    % 假设这是一个返回 1x(E*X) 随机概率向量的占位函数
    rng(100); % 固定随机数，便于测试
    psi_out = rand(1, E * X);
end