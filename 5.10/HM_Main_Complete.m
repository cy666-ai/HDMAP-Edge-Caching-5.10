%% HM_Main_Complete.m - RSU 缓存策略完整算法流程主入口
% 整合参数配置、MWC求解、容量精化和对比算法的完整流程
% 
% 可调参数：
%   E: RSU区域数量 (默认: 3)
%   X: 每个RSU区域的瓦片数量 (默认: 150)
%   alpha: 惩罚因子 (默认: 2)
%   Tile_Size: 瓦片大小向量 (默认: 全1)
%   allowed_layers_per_block: 每个瓦块允许的层级数 (默认: [2, 3, 4])

clc; clear; close all;

%% ==================== 参数配置区域 ====================
% 核心参数
E = 5;                  % RSU 区域数量
X = 150;                % 每个 RSU 区域的瓦片数量
% Prob_Route: 路线概率向量，根据RSU数量E自动生成递减序列
% 生成规则: 从高概率(0.95)线性递减到低概率(0.5)，提高整体访问概率
Prob_Route = linspace(0.95, max(0.5, 0.95 - 0.4*(E-1)/E), E);
alpha = 0.8;            % 惩罚因子 (降低惩罚，让更多瓦片获得正收益，提高命中率)

% 瓦片大小配置 (可根据实际需求调整)
Tile_Size = ones(1, E * X);  % 所有瓦片大小为1

% 瓦块层级配置 - 增加高收益层的比例
allowed_layers_per_block = [3, 4, 4];  % 优先分配更多层级，增加高收益瓦片比例
layer_names = {'Raw', 'Geo', 'Sem', 'Dyn'};  % 层级名称

% 各层级收益范围配置 - 整体提高收益，减少负收益瓦片
layer_profit_ranges = {
    [25, 35],   % Raw层（第1层）：高收益，范围扩大
    [15, 25],   % Geo层（第2层）：中高收益，显著提高
    [8, 15],    % Sem层（第3层）：中等收益，全部为正
    [-5, 5]     % Dyn层（第4层）：低收益，减少负收益幅度
};

% 容量放大系数 - 增加整体缓存容量，提高命中率
Capacity_Scale = 1.2;  % 容量放大1.2倍

% 随机种子（固定以保证结果可复现）
rng(42);

%% ==================== 参数校验和初始化 ====================
TOTAL_TILES = E * X;  % 总瓦片数

% 计算各RSU容量约束 - 应用容量放大系数
C_RSU = round(Prob_Route * X * Capacity_Scale);
% 确保最小容量至少为 X 的 30%
C_RSU = max(C_RSU, round(X * 0.3));
disp('=== 参数配置 ===');
disp(['RSU 区域数量 E: ', num2str(E)]);
disp(['每个区域瓦片数 X: ', num2str(X)]);
disp(['总瓦片数 TOTAL_TILES: ', num2str(TOTAL_TILES)]);
disp(['路线概率 Prob_Route: ', num2str(Prob_Route)]);
disp(['RSU 容量约束 C_RSU: ', num2str(C_RSU)]);
disp(['惩罚因子 alpha: ', num2str(alpha)]);
disp(['容量放大系数 Capacity_Scale: ', num2str(Capacity_Scale)]);
disp('=================');

% 检查输入合法性
if length(Prob_Route) ~= E
    error('Prob_Route 长度必须与 RSU 区域数量 E 相等。');
end

%% ==================== 1. 生成瓦片请求概率分布 ====================
disp(' ');
disp('=== 阶段一：生成瓦片请求概率分布 ===');
psi_matrix = ProbabilityDistribution(E, X);

% 构建 1 x K 瓦片请求概率向量 psi
psi = zeros(1, TOTAL_TILES);
for r = 1:E
    start_idx = (r-1) * X + 1;
    end_idx = r * X;
    psi(start_idx:end_idx) = psi_matrix(r, start_idx:end_idx);
end

%% ==================== 2. 动态分配瓦块层级和索引 ====================
disp(' ');
disp('=== 阶段二：动态分配瓦块层级 ===');
remaining_tiles = TOTAL_TILES;
block_layer_counts = [];
block_tile_indices = {};
current_tile_idx = 1;

while remaining_tiles > 0
    if remaining_tiles == 1
        layer_count = 1;
        warning('最后一个瓦块只分配了 1 层。');
    elseif remaining_tiles == 2
        layer_count = 2;
    elseif remaining_tiles == 3
        temp_allowed = allowed_layers_per_block(allowed_layers_per_block <= 3);
        layer_count = temp_allowed(randi(length(temp_allowed)));
    else
        layer_count = allowed_layers_per_block(randi(length(allowed_layers_per_block)));
    end
    
    block_layer_counts = [block_layer_counts, layer_count];
    block_tile_indices{end+1} = current_tile_idx : current_tile_idx + layer_count - 1;
    remaining_tiles = remaining_tiles - layer_count;
    current_tile_idx = current_tile_idx + layer_count;
end

NUM_BLOCKS = length(block_layer_counts);
disp(['模拟 ', num2str(TOTAL_TILES), ' 个瓦片，共 ', num2str(NUM_BLOCKS), ' 个地图区块。']);

%% ==================== 3. 计算瓦片净预期收益 W(b) ====================
disp(' ');
disp('=== 阶段三：计算瓦片净预期收益 ===');
W_net = zeros(1, TOTAL_TILES);
num = 0;

for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);
    
    for l_idx = 1:block_layer_num
        layer_type = min(l_idx, length(layer_profit_ranges));
        tile_idx = block_idx_list(l_idx);
        num = num + 1;
        profit_range = layer_profit_ranges{layer_type};
        profit = randi(profit_range);
        
        p_val = psi(tile_idx);
        W_net(tile_idx) = (p_val - alpha * (1 - p_val)) * profit;
    end
end

%% ==================== 4. 构建依赖关系矩阵 ====================
disp(' ');
disp('=== 阶段四：构建依赖关系矩阵 ===');
dependency_matrix = zeros(TOTAL_TILES, TOTAL_TILES);

for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);
    
    for l_idx = 2:block_layer_num
        dependent_tile = block_idx_list(l_idx);   % 依赖方
        parent_tile = block_idx_list(l_idx-1);    % 被依赖方
        dependency_matrix(dependent_tile, parent_tile) = 1;
    end
end

disp(['已生成 ', num2str(sum(sum(dependency_matrix))), ' 条依赖关系。']);

%% ==================== 5. MWC 求解器 (阶段二：最大化净效用) ====================
disp(' ');
disp('=== 阶段五：MWC 求解器 (最大化净效用) ===');
[CacheDecision_MWC, MaxNetUtility_MWC] = HM_MWC_Solver(W_net, dependency_matrix);

disp('MWC 求解结果:');
disp(['MWC净效用: ', num2str(MaxNetUtility_MWC, '%.2f')]);
disp(['MWC缓存瓦片总数: ', num2str(sum(CacheDecision_MWC))]);
for r = 1:E
    disp(['MWC RSU ', num2str(r), ' 瓦片数: ', num2str(sum(CacheDecision_MWC((r-1)*X+1:r*X))), ' (Max: ', num2str(C_RSU(r)), ')']);
end

%% ==================== 6. 容量精化阶段 (阶段三：处理容量约束) ====================
disp(' ');
disp('=== 阶段六：容量精化处理 ===');
is_overloaded = false;
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    CurrentSize_RSU = sum(CacheDecision_MWC(start_idx:end_idx) .* Tile_Size(start_idx:end_idx));
    
    if CurrentSize_RSU > C_RSU(r)
        is_overloaded = true;
        disp(['RSU ', num2str(r), ' 容量超限：', num2str(CurrentSize_RSU), ' > ', num2str(C_RSU(r))]);
    end
end

if is_overloaded
    disp('至少一个 RSU 容量超限。开始多 RSU 容量削减...');
    CacheDecision_Final = Capacity_Refinement_MultiRSU(CacheDecision_MWC, W_net, Tile_Size, dependency_matrix, C_RSU, E, X);
    MaxNetUtility_Final = sum(CacheDecision_Final .* W_net);
else
    disp('所有 RSU 容量均满足约束。无需削减。');
    CacheDecision_Final = CacheDecision_MWC;
    MaxNetUtility_Final = MaxNetUtility_MWC;
end

%% ==================== 7. 最终结果展示 ====================
disp(' ');
disp('=== 最终缓存决策结果 ===');
disp(['最终净效用 (Total Net Utility): ', num2str(MaxNetUtility_Final, '%.2f')]);
disp(['最终缓存瓦片总数: ', num2str(sum(CacheDecision_Final))]);

% 各RSU详细结果
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    RSU_Total_Utility = sum(CacheDecision_Final(start_idx:end_idx) .* W_net(start_idx:end_idx));
    disp(['最终 RSU ', num2str(r), ' 容量: ', num2str(sum(CacheDecision_Final(start_idx:end_idx))), ' (Max: ', num2str(C_RSU(r)), ')']);
    disp(['最终 RSU ', num2str(r), ' 效用: ', num2str(RSU_Total_Utility, '%.2f')]);
end

% 验证依赖约束
dependency_violations_final = 0;
for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);
    for l_idx = 2:block_layer_num
        dependent_tile = block_idx_list(l_idx);
        parent_tile = block_idx_list(l_idx-1);
        if CacheDecision_Final(dependent_tile) == 1 && CacheDecision_Final(parent_tile) == 0
            dependency_violations_final = dependency_violations_final + 1;
        end
    end
end

disp(' ');
disp(['--- 依赖约束检查 ---']);
if dependency_violations_final > 0
    disp(['违反依赖约束的数量: ', num2str(dependency_violations_final), ' ❌']);
else
    disp('所有依赖约束均满足 ✔');
end

%% ==================== 8. 缓存命中率分析 (可选) ====================
disp(' ');
disp('=== 缓存命中率分析 ===');
Calculate_CHR(E, X, psi, CacheDecision_Final, Prob_Route);

%% ==================== 9. 对比算法测试 (可选) ====================
disp(' ');
disp('=== 对比算法测试 ===');

% 设置全局变量供对比算法使用
assignin('base', 'system_prob_route', Prob_Route);

% MPC 算法
[CHR_MPC_RSU, CHR_MPC_Total] = Function_MPC(E, X);
disp(['MPC 算法总命中率: ', num2str(CHR_MPC_Total, '%.4f')]);

% MAP 算法
[CHR_MAP_RSU, CHR_MAP_Total] = Function_MAP(E, X);
disp(['MAP 算法总命中率: ', num2str(CHR_MAP_Total, '%.4f')]);

% TRWC 算法
[CHR_TRWC_RSU, CHR_TRWC_Total] = Function_TRWC(E, X);
disp(['TRWC 算法总命中率: ', num2str(CHR_TRWC_Total, '%.4f')]);

%% ==================== 辅助函数 ====================
function Calculate_CHR(E, X, psi_vec, CacheDecision_Final, Prob_Route)
    % 计算指定路线流量概率下的 RSU 缓存命中率
    Total_Hit_Route = 0;
    Total_Req_Route = 0;
    
    disp(['容量权重 (Prob_Route): ', num2str(Prob_Route)]);
    
    for r = 1:E
        start_idx = (r-1)*X + 1;
        end_idx = r*X;
        
        Tile_Indices_r = start_idx:end_idx;
        Base_Request_r = sum(psi_vec(Tile_Indices_r));
        Request_Weighted_r = Base_Request_r * Prob_Route(r);
        Total_Req_Route = Total_Req_Route + Request_Weighted_r;
        
        Hit_RSU_r = sum(CacheDecision_Final(Tile_Indices_r) .* psi_vec(Tile_Indices_r)) * Prob_Route(r);
        Total_Hit_Route = Total_Hit_Route + Hit_RSU_r;
        
        if Base_Request_r > 0
            CHR_RSU_r = Hit_RSU_r / Request_Weighted_r;
        else
            CHR_RSU_r = 0;
        end
        
        disp(['RSU ', num2str(r), ' 缓存命中率: ', num2str(CHR_RSU_r, '%.4f'), ...
             ' (权重: ', num2str(Prob_Route(r)), ')']);
    end
    
    CHR_Route_Total = Total_Hit_Route / Total_Req_Route;
    disp(['总缓存命中率: ', num2str(CHR_Route_Total, '%.4f')]);
end