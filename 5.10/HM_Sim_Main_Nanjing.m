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

% 确保必要字段存在（兼容不同版本的JSON结构）
if ~isfield(sim_data, 'rsuRegions')
    % 使用内置部署方案
    sim_data.rsuRegions = struct();
    sim_data.rsuRegions.E = 3;
    sim_data.rsuRegions.Prob_Route = [0.65, 0.95, 0.5];
    sim_data.rsuRegions.RSU_per_region = [28, 34, 25];
    sim_data.algorithmParams = struct();
    sim_data.algorithmParams.X = 150;
    sim_data.algorithmParams.alpha = 0.8;
    sim_data.algorithmParams.Capacity_Scale = 1.2;
    sim_data.algorithmParams.allowed_layers_per_block = [3, 4, 4];
    layer_profit_ranges.Raw = [25, 35];
    layer_profit_ranges.Geo = [15, 25];
    layer_profit_ranges.Sem = [8, 15];
    layer_profit_ranges.Dyn = [-5, 5];
    sim_data.algorithmParams.layer_profit_ranges = layer_profit_ranges;
    sim_data.vehicles = struct([]);
    disp('JSON不含rsuRegions字段，使用默认参数。');
end

%% ==================== RSU 部署生成 ====================
% 使用综合部署方案：地铁站 + 道路覆盖
% 优先从 GenerateRSUDeployment_Nanjing 生成（更可靠），
% 如有车辆数据JSON中的intersections则以此为准
if isfield(sim_data, 'intersections') && length(sim_data.intersections) >= 9
    % 从JSON加载RSU位置（由 exportVehicleData.mjs 生成）
    total_rsu = length(sim_data.intersections);
    RSU_positions = zeros(total_rsu, 2);
    RSU_names = cell(total_rsu, 1);
    RSU_regions = zeros(total_rsu, 1);
    for i = 1:total_rsu
        RSU_positions(i, 1) = sim_data.intersections(i).latitude;
        RSU_positions(i, 2) = sim_data.intersections(i).longitude;
        RSU_names{i} = sim_data.intersections(i).name;
        if isfield(sim_data.intersections(i), 'region')
            RSU_regions(i) = sim_data.intersections(i).region;
        end
    end
    disp(['从JSON加载 ', num2str(total_rsu), ' 个 RSU 坐标。']);
else
    % 从MATLAB内置函数生成RSU部署方案
    disp('JSON不含RSU坐标，使用内置 GenerateRSUDeployment_Nanjing 生成...');
    RSU_Result = GenerateRSUDeployment_Nanjing();
    RSU_positions = RSU_Result.positions;
    RSU_names = RSU_Result.names;
    RSU_regions = RSU_Result.region;
    total_rsu = RSU_Result.totalRSU;
end

% 提取路线概率（jsondecode 返回列向量，转置为行向量）
Prob_Route = sim_data.rsuRegions.Prob_Route(:)';  % 强制转为行向量，长度 E=3
E = sim_data.rsuRegions.E;

% RSU_per_region 可能为标量（旧格式3）或数组（新格式如[28,34,25]）
RSU_per_region = sim_data.rsuRegions.RSU_per_region;
if isscalar(RSU_per_region)
    RSU_per_region = repmat(RSU_per_region, 1, E); % 兼容旧数据
else
    RSU_per_region = RSU_per_region(:)'; % 强制转为行向量
end

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
fprintf('总 RSU 数: %d (各区域: [%s])\n', total_rsu, num2str(RSU_per_region));

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
    % 修改 (v5.10 批次计算): 根据 RSU 在批次内的位置决定取哪段列
    col_offset = mod(r-1, 3);
    col_start = col_offset * X + 1;
    col_end = (col_offset + 1) * X;
    psi(start_idx:end_idx) = psi_matrix(r, col_start:col_end);
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
    '区域', 'RSU数量', '缓存瓦片', '容量上限', '区域效用');
fprintf('---------------------------------------------------------------------\n');
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    % 计算该区域的RSU ID范围
    if exist('RSU_regions', 'var') && length(unique(RSU_regions)) > 1
        rsu_indices = find(RSU_regions == r);
        if ~isempty(rsu_indices)
            rsu_range_str = sprintf('[%d..%d]', rsu_indices(1), rsu_indices(end));
        else
            rsu_range_str = '[]';
        end
    else
        rsu_range_str = sprintf('[%d..%d]', r, r);
    end
    RSU_Total_Utility = sum(CacheDecision_Final(start_idx:end_idx) .* W_net(start_idx:end_idx));

    fprintf('区域 %d     %-10s %-12d     %-8d     %.2f\n', ...
        r, rsu_range_str, ...
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
    if exist('RSU_regions', 'var') && length(unique(RSU_regions)) > 1
        PlotRSUNetwork_Nanjing(RSU_positions, RSU_regions, true);
    else
        PlotRSUNetwork_Nanjing(RSU_positions);
    end
    disp('RSU 网络拓扑图已生成。');
catch ME
    disp(['可视化跳过: ', ME.message]);
end

%% ==================== 12. 输出结果到 TXT ====================
disp(' ');
disp('=== 导出结果到文件 ===');
output_file = 'Nanjing_Simulation_Results.txt';
fid = fopen(output_file, 'w');

fprintf(fid, '=============================================\n');
fprintf(fid, '  HDMAP-Edge Caching 5.10 仿真结果             \n');
fprintf(fid, '  南京鼓楼区 | %s\n', datestr(now));
fprintf(fid, '=============================================\n\n');

fprintf(fid, '一、RSU 部署位置（地铁站 + 道路覆盖，经纬度）\n');
fprintf(fid, '-------------------------------------\n');
fprintf(fid, '%-6s %-12s %-12s %-6s %s\n', 'RSU#', '纬度', '经度', '区域', '位置');
fprintf(fid, '--------------------------------------------------------\n');
for i = 1:total_rsu
    if exist('RSU_regions', 'var') && length(RSU_regions) >= i
        r_label = sprintf('R%d', RSU_regions(i));
    else
        r_label = '-';
    end
    fprintf(fid, '%-6d %-12.6f %-12.6f %-6s %s\n', ...
        i, RSU_positions(i,1), RSU_positions(i,2), r_label, ...
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
fprintf(fid, '每区域 RSU 数: [%s]\n', num2str(RSU_per_region));
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
    if exist('RSU_regions', 'var') && length(unique(RSU_regions)) > 1
        rsu_in_region = sum(RSU_regions == r);
    else
        rsu_in_region = RSU_per_region(r);
    end
    fprintf(fid, '  区域 %d: RSU数=%d, 缓存=%d/%d, 容量上限=%d, 效用=%.2f\n', ...
        r, rsu_in_region, sum(CacheDecision_Final(start_idx:end_idx)), X, C_RSU(r), RSU_Total_Utility);
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
    try
        raw = fileread(filename);
    catch
        error('无法读取文件: %s', filename);
    end

    % 安全的 JSON 解码
    try
        sim_data = jsondecode(raw);
    catch ME_json
        disp(['JSON解析失败，使用默认参数。错误: ', ME_json.message]);
        % 返回一个最小结构，让主程序运行
        sim_data = struct();
        sim_data.vehicles = struct([]);
        sim_data.rsuRegions = struct();
        sim_data.rsuRegions.E = 3;
        sim_data.rsuRegions.Prob_Route = [0.65, 0.95, 0.5];
        sim_data.rsuRegions.RSU_per_region = [28, 34, 25];
        sim_data.algorithmParams = struct();
        sim_data.algorithmParams.X = 150;
        sim_data.algorithmParams.alpha = 0.8;
        sim_data.algorithmParams.Capacity_Scale = 1.2;
        sim_data.algorithmParams.allowed_layers_per_block = [3, 4, 4];
        prof.Raw = [25, 35];
        prof.Geo = [15, 25];
        prof.Sem = [8, 15];
        prof.Dyn = [-5, 5];
        sim_data.algorithmParams.layer_profit_ranges = prof;
    end
end

function PlotRSUNetwork_Nanjing(RSU_positions, RSU_regions, extra_roads_flag)
    % 绘制南京道路网络和 RSU 部署图（支持综合部署方案）
    % 输入:
    %   RSU_positions: N×2矩阵 [纬度, 经度]
    %   RSU_regions: 可选的N×1区域向量 (1=北区, 2=中区, 3=南区)
    %   extra_roads_flag: 是否绘制扩展道路

    if nargin < 2, RSU_regions = []; end
    if nargin < 3, extra_roads_flag = true; end

    % 道路端点定义（6条主要道路 + 3条扩展道路）
    roads_ns = {
        '中山北路', 32.083000, 118.771000, 32.038000, 118.767000;
        '中央路',   32.078000, 118.782000, 32.042000, 118.781000;
        '虎踞路',   32.076000, 118.752000, 32.038000, 118.752000;
        };
    roads_ew = {
        '北京西路',   32.058000, 118.750000, 32.058000, 118.792000;
        '汉中路',     32.046000, 118.758000, 32.046000, 118.792000;
        '新模范马路', 32.072000, 118.758000, 32.072000, 118.792000;
        };
    extra_roads = {
        '北京东路',   32.059000, 118.783000, 32.059000, 118.801000;
        '中山南路',   32.046000, 118.783000, 32.038000, 118.783000;
        '模范西路',   32.076000, 118.752000, 32.076000, 118.758000;
        };

    % 区域颜色和名称
    region_colors = {[0.85, 0.33, 0.10], [0.00, 0.45, 0.74], [0.47, 0.67, 0.19]};
    region_labels = {'北区-新模范马路走廊', '中区-北京西路走廊（核心区）', '南区-汉中路走廊'};
    region_boundary_lats = [32.065000, 32.050000];  % 区域边界线纬度

    figure('Color', 'white', 'Position', [100, 100, 1100, 750]);
    hold on; grid on; box on;

    % 绘制区域边界虚线（水平线分隔北区/中区/南区）
    for b = 1:length(region_boundary_lats)
        plot([118.735000, 118.810000], [region_boundary_lats(b), region_boundary_lats(b)], ...
            '--', 'Color', [0.6, 0.6, 0.6], 'LineWidth', 1, 'HandleVisibility', 'off');
    end

    % 绘制南北道路（蓝色系）
    ns_color = [0.30, 0.45, 0.80];
    for i = 1:size(roads_ns, 1)
        lat1 = roads_ns{i, 2}; lng1 = roads_ns{i, 3};
        lat2 = roads_ns{i, 4}; lng2 = roads_ns{i, 5};
        plot([lng1, lng2], [lat1, lat2], 'Color', ns_color, ...
            'LineWidth', 2.5, 'DisplayName', roads_ns{i, 1});
    end

    % 绘制东西道路（红色系）
    ew_color = [0.80, 0.30, 0.30];
    for i = 1:size(roads_ew, 1)
        lat1 = roads_ew{i, 2}; lng1 = roads_ew{i, 3};
        lat2 = roads_ew{i, 4}; lng2 = roads_ew{i, 5};
        plot([lng1, lng2], [lat1, lat2], 'Color', ew_color, ...
            'LineWidth', 2.5, 'DisplayName', roads_ew{i, 1});
    end

    % 绘制扩展道路（灰色虚线）
    if extra_roads_flag
        for i = 1:size(extra_roads, 1)
            lat1 = extra_roads{i, 2}; lng1 = extra_roads{i, 3};
            lat2 = extra_roads{i, 4}; lng2 = extra_roads{i, 5};
            plot([lng1, lng2], [lat1, lat2], '--', 'Color', [0.5, 0.5, 0.5], ...
                'LineWidth', 1.5, 'DisplayName', extra_roads{i, 1});
        end
    end

    % 标注地铁站符号（8座车站：鼓楼站方圆2.5km内）
    metro_locs = [
            32.059120, 118.783850;  % 鼓楼站
            32.072340, 118.778970;  % 玄武门站
            32.081900, 118.778600;  % 新模范马路站
            32.052990, 118.778970;  % 珠江路站
            32.040990, 118.784030;  % 新街口站
            32.061100, 118.769490;  % 云南路站
            32.059600, 118.792660;  % 鸡鸣寺站
            32.057300, 118.800700;  % 九华山站
        ];
    scatter(metro_locs(:,2), metro_locs(:,1), 180, ...
        'p', 'MarkerEdgeColor', [0.8, 0.6, 0], 'MarkerFaceColor', [1, 0.85, 0.2], ...
        'LineWidth', 2, 'DisplayName', '地铁站');

    % 按区域着色绘制 RSU 节点
    if ~isempty(RSU_regions) && length(unique(RSU_regions)) > 1
        for r = 1:3
            idx = (RSU_regions == r);
            if any(idx)
                scatter(RSU_positions(idx,2), RSU_positions(idx,1), 100, ...
                    'o', 'MarkerFaceColor', region_colors{r}, ...
                    'MarkerEdgeColor', 'w', 'LineWidth', 1.5, ...
                    'DisplayName', sprintf('RSU-%s', region_labels{r}));
            end
        end
    else
        scatter(RSU_positions(:,2), RSU_positions(:,1), 100, ...
            'k', 'filled', 'MarkerEdgeColor', 'w', 'LineWidth', 1.5, ...
            'DisplayName', 'RSU');
    end

    % 标注 RSU 编号（密集时用小字体）
    num_rsu = size(RSU_positions, 1);
    if num_rsu > 30
        font_sz = 7;
        offset = 0.0008;
    elseif num_rsu > 15
        font_sz = 9;
        offset = 0.001;
    else
        font_sz = 11;
        offset = 0.001;
    end
    for i = 1:num_rsu
        text(RSU_positions(i,2) + offset, RSU_positions(i,1) + offset/2, ...
            num2str(i), 'FontSize', font_sz, 'FontWeight', 'bold', ...
            'Color', [0.2, 0.2, 0.2], 'HandleVisibility', 'off');
    end

    % 添加区域标签
    y_positions = [32.077000, 32.062000, 32.047000];
    for r = 1:3
        text(118.742000, y_positions(r), region_labels{r}, ...
            'FontSize', 11, 'FontWeight', 'bold', 'Color', region_colors{r}, ...
            'BackgroundColor', [1,1,1,0.7], 'EdgeColor', region_colors{r}, ...
            'HandleVisibility', 'off');
    end

    xlabel('经度', 'FontSize', 12, 'FontWeight', 'bold');
    ylabel('纬度', 'FontSize', 12, 'FontWeight', 'bold');
    title(sprintf('南京鼓楼区道路网络及 RSU 综合部署 (%d 个RSU, 含地铁站+道路覆盖)', num_rsu), ...
        'FontSize', 13, 'FontWeight', 'bold');
    legend('Location', 'southeast', 'FontSize', 9);
    axis equal;
    xlim([118.735000, 118.810000]);
    ylim([32.033000, 32.087000]);
    hold off;

    disp(['RSU 网络拓扑图已生成（', num2str(num_rsu), ' 个RSU, 含8个地铁站+道路覆盖）']);
end
