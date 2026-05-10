%% HM_Sim_Main_Nanjing.m - 南京鼓楼区 RSU 缓存策略仿真主入口
% 基于 simmap1.0 车辆轨迹数据，在南京鼓楼区道路交叉口部署 RSU，
% 运行 MWC 求解器和容量精化算法，输出缓存决策与命中率。
%
% 数据来源: simmap1.0/backend/data/vehicle_export.json
%           需先运行 exportVehicleData.mjs 生成该文件
%
% 与 HM_Main_Complete.m 的区别:
%   - RSU 部署于 9 个鼓楼区道路交叉口
%   - E=3 个横向走廊区域，每区域 3 个 RSU
%   - Prob_Route 由 simmap1.0 车辆轨迹统计得出
%   - 地图坐标使用南京 UTM 参数（北纬 32.06°）

clc; clear; close all;

%% ==================== 0. 加载 simmap1.0 数据 ====================
disp('========================================');
disp('  HDMAP-Edge Caching 5.10 — 南京鼓楼区仿真');
disp('========================================');
disp(' ');
disp('=== 阶段零：加载 simmap1.0 车辆数据 ===');

% 寻找数据文件的可能路径
json_paths = {
    '../simmap1.0/backend/data/vehicle_export.json'
    'vehicle_export.json'
    };

json_file = '';
for i = 1:length(json_paths)
    if exist(json_paths{i}, 'file')
        json_file = json_paths{i};
        break;
    end
end

if isempty(json_file)
    error(['未找到车辆数据文件。\n' ...
           '请先运行: node simmap1.0/backend/scripts/exportVehicleData.mjs\n' ...
           '然后在以下路径之一放置 vehicle_export.json:\n' ...
           '  %s\n  %s'], json_paths{1}, json_paths{2});
end

disp(['加载数据: ', json_file]);
sim_data = load_vehicle_json(json_file);

% 提取 RSU 交叉口坐标（9 个十字路口）
RSU_positions = zeros(9, 2);
for i = 1:9
    RSU_positions(i, 1) = sim_data.intersections(i).latitude;
    RSU_positions(i, 2) = sim_data.intersections(i).longitude;
end

% 提取路线概率
Prob_Route = sim_data.rsuRegions.Prob_Route;  % 长度 E=3
E = sim_data.rsuRegions.E;
RSU_per_region = sim_data.rsuRegions.RSU_per_region;
total_rsu = sim_data.rsuRegions.totalRSU;

% 提取算法参数
alg_params = sim_data.algorithmParams;
X = alg_params.X;                    % 每区域瓦片数
alpha = alg_params.alpha;            % 惩罚因子
Capacity_Scale = alg_params.Capacity_Scale;
allowed_layers_per_block = alg_params.allowed_layers_per_block;
layer_profit_ranges = alg_params.layer_profit_ranges;
layer_names = {'Raw', 'Geo', 'Sem', 'Dyn'};

% 提取车辆轨迹
vehicle_count = length(sim_data.vehicles);
disp(['已加载 ', num2str(vehicle_count), ' 辆车的轨迹数据。']);
disp(['已加载 ', num2str(total_rsu), ' 个 RSU 路口坐标。']);
disp(['RSU 区域数 E: ', num2str(E)]);
disp(['Prob_Route: ', num2str(Prob_Route)]);

%% ==================== 1. 参数配置 ====================
disp(' ');
disp('=== 参数配置 ===');

TOTAL_TILES = E * X;
fprintf('RSU 区域数: %d\n', E);
fprintf('每区域瓦片数: %d\n', X);
fprintf('总瓦片数: %d\n', TOTAL_TILES);
fprintf('总 RSU 数: %d (每区域 %d 个)\n', total_rsu, RSU_per_region);

% 瓦片大小配置
Tile_Size = ones(1, TOTAL_TILES);

% RSU 容量约束
C_RSU = round(Prob_Route * X * Capacity_Scale);
% 确保最小容量
C_RSU = max(C_RSU, round(X * 0.3));
fprintf('路线概率: [%s]\n', num2str(Prob_Route, '%.4f '));
fprintf('RSU 容量: [%s]\n', num2str(C_RSU));
fprintf('惩罚因子 alpha: %.2f\n', alpha);
fprintf('容量系数: %.2f\n', Capacity_Scale);

% 随机种子
rng(42);

%% ==================== 2. 生成瓦片请求概率分布 ====================
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

%% ==================== 3. 动态分配瓦块层级和索引 ====================
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

%% ==================== 4. 计算瓦片净预期收益 W(b) ====================
disp(' ');
disp('=== 阶段三：计算瓦片净预期收益 ===');
W_net = zeros(1, TOTAL_TILES);

% 将 layer_profit_ranges 从 struct 转为 cell array
profit_ranges_cell = {
    layer_profit_ranges.Raw
    layer_profit_ranges.Geo
    layer_profit_ranges.Sem
    layer_profit_ranges.Dyn
    };

for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);

    for l_idx = 1:block_layer_num
        layer_type = min(l_idx, length(profit_ranges_cell));
        tile_idx = block_idx_list(l_idx);
        profit_range = profit_ranges_cell{layer_type};
        profit = randi(profit_range);

        p_val = psi(tile_idx);
        W_net(tile_idx) = (p_val - alpha * (1 - p_val)) * profit;
    end
end

%% ==================== 5. 构建依赖关系矩阵 ====================
disp(' ');
disp('=== 阶段四：构建依赖关系矩阵 ===');
dependency_matrix = zeros(TOTAL_TILES, TOTAL_TILES);

for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);

    for l_idx = 2:block_layer_num
        dependent_tile = block_idx_list(l_idx);
        parent_tile = block_idx_list(l_idx - 1);
        dependency_matrix(dependent_tile, parent_tile) = 1;
    end
end

disp(['已生成 ', num2str(sum(sum(dependency_matrix))), ' 条依赖关系。']);

%% ==================== 6. MWC 求解器 ====================
disp(' ');
disp('=== 阶段五：MWC 求解器 (最大化净效用) ===');
[CacheDecision_MWC, MaxNetUtility_MWC] = HM_MWC_Solver(W_net, dependency_matrix);

disp('MWC 求解结果:');
disp(['MWC净效用: ', num2str(MaxNetUtility_MWC, '%.2f')]);
disp(['MWC缓存瓦片总数: ', num2str(sum(CacheDecision_MWC))]);
for r = 1:E
    count = sum(CacheDecision_MWC((r-1)*X+1:r*X));
    disp(['MWC 区域 ', num2str(r), ' 瓦片数: ', num2str(count), ' (上限: ', num2str(C_RSU(r)), ')']);
end

%% ==================== 7. 容量精化 ====================
disp(' ');
disp('=== 阶段六：容量精化处理 ===');
is_overloaded = false;
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    CurrentSize_RSU = sum(CacheDecision_MWC(start_idx:end_idx) .* Tile_Size(start_idx:end_idx));

    if CurrentSize_RSU > C_RSU(r)
        is_overloaded = true;
        disp(['区域 ', num2str(r), ' 容量超限：', num2str(CurrentSize_RSU), ' > ', num2str(C_RSU(r))]);
    end
end

if is_overloaded
    disp('至少一个 RSU 区域容量超限。开始容量削减...');
    CacheDecision_Final = Capacity_Refinement_MultiRSU(...
        CacheDecision_MWC, W_net, Tile_Size, dependency_matrix, C_RSU, E, X);
    MaxNetUtility_Final = sum(CacheDecision_Final .* W_net);
else
    disp('所有 RSU 区域容量均满足约束。无需削减。');
    CacheDecision_Final = CacheDecision_MWC;
    MaxNetUtility_Final = MaxNetUtility_MWC;
end

%% ==================== 8. 最终结果展示 ====================
disp(' ');
disp('=== 最终缓存决策结果 (南京鼓楼区) ===');
disp(['最终净效用: ', num2str(MaxNetUtility_Final, '%.2f')]);
disp(['最终缓存瓦片总数: ', num2str(sum(CacheDecision_Final))]);

% 按 RSU 区域统计
fprintf('\n%-10s %-12s %-12s %-12s %-12s\n', ...
    '区域', 'RSU IDs', '缓存瓦片', '容量上限', '区域效用');
fprintf('---------------------------------------------------------------------\n');
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    rsu_start = (r-1)*RSU_per_region + 1;
    rsu_end = r*RSU_per_region;
    RSU_Total_Utility = sum(CacheDecision_Final(start_idx:end_idx) .* W_net(start_idx:end_idx));

    fprintf('区域 %d     [%d,%d,%d]     %-8d     %-8d     %.2f\n', ...
        r, rsu_start, rsu_start+1, rsu_end, ...
        sum(CacheDecision_Final(start_idx:end_idx)), C_RSU(r), RSU_Total_Utility);
end

% 验证依赖约束
dependency_violations_final = 0;
for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);
    for l_idx = 2:block_layer_num
        dependent_tile = block_idx_list(l_idx);
        parent_tile = block_idx_list(l_idx - 1);
        if CacheDecision_Final(dependent_tile) == 1 && CacheDecision_Final(parent_tile) == 0
            dependency_violations_final = dependency_violations_final + 1;
        end
    end
end

disp(' ');
disp(['--- 依赖约束检查 ---']);
if dependency_violations_final > 0
    disp(['违反依赖约束数量: ', num2str(dependency_violations_final), ' ❌']);
else
    disp('所有依赖约束均满足 ✔');
end

%% ==================== 9. 缓存命中率分析 ====================
disp(' ');
disp('=== 缓存命中率分析 (基于南京车辆轨迹) ===');

% 使用基于车辆轨迹的加权命中率计算
Total_Hit_Route = 0;
Total_Req_Route = 0;

for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    Tile_Indices_r = start_idx:end_idx;

    Base_Request_r = sum(psi(Tile_Indices_r));
    Request_Weighted_r = Base_Request_r * Prob_Route(r);
    Total_Req_Route = Total_Req_Route + Request_Weighted_r;

    Hit_RSU_r = sum(CacheDecision_Final(Tile_Indices_r) .* psi(Tile_Indices_r)) * Prob_Route(r);
    Total_Hit_Route = Total_Hit_Route + Hit_RSU_r;

    if Base_Request_r > 0
        CHR_RSU_r = Hit_RSU_r / Request_Weighted_r;
    else
        CHR_RSU_r = 0;
    end

    disp(['区域 ', num2str(r), ' 缓存命中率: ', num2str(CHR_RSU_r, '%.4f'), ...
        ' (权重: ', num2str(Prob_Route(r)), ')']);
end

CHR_Total = Total_Hit_Route / Total_Req_Route;
disp(['总缓存命中率: ', num2str(CHR_Total, '%.4f')]);

%% ==================== 10. 对比算法 ====================
disp(' ');
disp('=== 对比算法测试 ===');

assignin('base', 'system_prob_route', Prob_Route);

% MPC 算法
[CHR_MPC_RSU, CHR_MPC_Total] = Function_MPC(E, X);
disp(['MPC 总命中率: ', num2str(CHR_MPC_Total, '%.4f')]);

% MAP 算法
[CHR_MAP_RSU, CHR_MAP_Total] = Function_MAP(E, X);
disp(['MAP 总命中率: ', num2str(CHR_MAP_Total, '%.4f')]);

% TRWC 算法
[CHR_TRWC_RSU, CHR_TRWC_Total] = Function_TRWC(E, X);
disp(['TRWC 总命中率: ', num2str(CHR_TRWC_Total, '%.4f')]);

%% ==================== 11. 可视化（南京道路网络 + RSU） ====================
disp(' ');
disp('=== 可视化 ===');
try
    PlotRSUNetwork_Nanjing(RSU_positions);
    disp('RSU 网络拓扑图已生成。');
catch ME
    disp(['可视化跳过: ', ME.message]);
end

%% ==================== 12. 输出结果到 TXT ====================
disp(' ');
disp('=== 导出结果到文件 ===');
output_file = 'Nanjing_Simulation_Results.txt';
fid = fopen(output_file, 'w', 'utf-8');

fprintf(fid, '=============================================\n');
fprintf(fid, '  HDMAP-Edge Caching 5.10 仿真结果             \n');
fprintf(fid, '  南京鼓楼区 | %s\n', datestr(now));
fprintf(fid, '=============================================\n\n');

fprintf(fid, '一、RSU 部署位置（交叉口，经纬度）\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, '%-6s %-12s %-12s %s\n', 'RSU#', '纬度', '经度', '路口');
fprintf(fid, '--------------------------------------------------\n');
for i = 1:total_rsu
    fprintf(fid, '%-6d %-12.4f %-12.4f %s\n', ...
        i, RSU_positions(i,1), RSU_positions(i,2), ...
        sim_data.intersections(i).name);
end

fprintf(fid, '\n二、车辆轨迹数据（来自 simmap1.0）\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, '车辆数: %d\n', vehicle_count);
fprintf(fid, '采集 tick 数: %d\n\n', sim_data.meta.totalTicks);
for v = 1:vehicle_count
    traj = sim_data.vehicles(v).trajectory;
    fprintf(fid, '  车辆 %d (%s): 道路=%s, 轨迹点数=%d\n', ...
        v, sim_data.vehicles(v).name, sim_data.vehicles(v).roadName, length(traj));
end

fprintf(fid, '\n三、路线概率 Prob_Route\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, 'E (区域数): %d\n', E);
fprintf(fid, '每区域 RSU 数: %d\n', RSU_per_region);
fprintf(fid, '总 RSU 数: %d\n', total_rsu);
fprintf(fid, 'Prob_Route: [%s]\n', num2str(Prob_Route, '%.4f '));

fprintf(fid, '\n四、算法执行结果\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, 'MWC 净效用: %.2f\n', MaxNetUtility_MWC);
fprintf(fid, '最终净效用: %.2f\n', MaxNetUtility_Final);
fprintf(fid, 'MWC 缓存瓦片总数: %d\n', sum(CacheDecision_MWC));
fprintf(fid, '最终缓存瓦片总数: %d\n', sum(CacheDecision_Final));
fprintf(fid, '总缓存命中率: %.4f\n', CHR_Total);
fprintf(fid, '依赖约束违反: %d\n', dependency_violations_final);

fprintf(fid, '\n区域详情:\n');
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    RSU_Total_Utility = sum(CacheDecision_Final(start_idx:end_idx) .* W_net(start_idx:end_idx));
    fprintf(fid, '  区域 %d: 缓存=%d/%d, 容量上限=%d, 效用=%.2f\n', ...
        r, sum(CacheDecision_Final(start_idx:end_idx)), X, C_RSU(r), RSU_Total_Utility);
end

fprintf(fid, '\n五、对比算法结果\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, 'MWC 总命中率: %.4f\n', CHR_Total);
fprintf(fid, 'MPC 总命中率: %.4f\n', CHR_MPC_Total);
fprintf(fid, 'MAP 总命中率: %.4f\n', CHR_MAP_Total);
fprintf(fid, 'TRWC 总命中率: %.4f\n', CHR_TRWC_Total);

fclose(fid);
disp(['结果已写入: ', output_file]);

%% ==================== 辅助函数 ====================

function sim_data = load_vehicle_json(filename)
    % 读取 simmap1.0 导出的 JSON 车辆轨迹数据
    fid = fopen(filename, 'r', 'utf-8');
    if fid == -1
        error('无法打开文件: %s', filename);
    end
    raw = fread(fid, inf, '*char')';
    fclose(fid);
    sim_data = jsondecode(raw);
end

function PlotRSUNetwork_Nanjing(RSU_positions)
    % 绘制南京道路网络和 RSU 部署图

    % 道路端点定义 (与车辆数据一致)
    roads_ns = {
        '中山北路', 32.083, 118.771, 32.038, 118.767;
        '中央路',   32.078, 118.782, 32.042, 118.781;
        '虎踞路',   32.076, 118.752, 32.038, 118.752;
        };
    roads_ew = {
        '北京西路',   32.058, 118.750, 32.058, 118.792;
        '汉中路',     32.046, 118.758, 32.046, 118.792;
        '新模范马路', 32.072, 118.758, 32.072, 118.792;
        };

    figure('Color', 'white', 'Position', [100, 100, 900, 700]);
    hold on; grid on; box on;

    % 绘制南北道路
    for i = 1:size(roads_ns, 1)
        lat1 = roads_ns{i, 2}; lng1 = roads_ns{i, 3};
        lat2 = roads_ns{i, 4}; lng2 = roads_ns{i, 5};
        plot([lng1, lng2], [lat1, lat2], 'b-', 'LineWidth', 2, 'DisplayName', roads_ns{i, 1});
    end

    % 绘制东西道路
    for i = 1:size(roads_ew, 1)
        lat1 = roads_ew{i, 2}; lng1 = roads_ew{i, 3};
        lat2 = roads_ew{i, 4}; lng2 = roads_ew{i, 5};
        plot([lng1, lng2], [lat1, lat2], 'r-', 'LineWidth', 2, 'DisplayName', roads_ew{i, 1});
    end

    % 绘制 RSU 节点
    h_rsu = scatter(RSU_positions(:,2), RSU_positions(:,1), 120, ...
        'k', 'filled', 'MarkerEdgeColor', 'w', 'LineWidth', 1.5, 'DisplayName', 'RSU');

    % 标注 RSU 编号
    for i = 1:size(RSU_positions, 1)
        text(RSU_positions(i,2) + 0.001, RSU_positions(i,1) + 0.0005, ...
            num2str(i), 'FontSize', 11, 'FontWeight', 'bold', 'Color', 'blue');
    end

    xlabel('经度', 'FontSize', 12, 'FontWeight', 'bold');
    ylabel('纬度', 'FontSize', 12, 'FontWeight', 'bold');
    title('南京鼓楼区道路网络及 RSU 部署', 'FontSize', 14, 'FontWeight', 'bold');
    legend('Location', 'best');
    axis equal;
    xlim([118.74, 118.80]);
    ylim([32.035, 32.090]);
    hold off;

    disp('RSU 网络拓扑图已生成（南京鼓楼区）');
end
