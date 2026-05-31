%% HM_Export_CacheDecision.m
% 被 Node.js CachingService 调用的 MATLAB 导出脚本（v5.10）。
% 从 _vehicle_input.json 读取多路线数据，对每条路线独立运行 MWC 三阶段算法，
% 将每路线的缓存决策输出到 cache_decision.json。
%
% 调用方式:
%   matlab -batch "HM_Export_CacheDecision"
%
% 输入:  ../simmap1.0/backend/data/_vehicle_input.json
%        格式: { algorithmParams: {...}, routes: [{routeId, E, X, vehicleCount}, ...], timestamp }
% 输出:  ../simmap1.0/backend/data/cache_decision.json
%        格式: { routes: [{routeId, CacheDecision, psi, W_net, CHR_RSU, CHR_Total, ...}, ...], timestamp }

%% ==================== 0. 加载输入数据 ====================
fprintf('=== HM_Export_CacheDecision (v5.10 多路线 MWC) ===\n');
fprintf('加载输入数据...\n');

% 寻找输入文件
input_paths = {
    '../simmap1.0/backend/data/_vehicle_input.json'
    '_vehicle_input.json'
    };
input_file = '';
for i = 1:length(input_paths)
    if exist(input_paths{i}, 'file')
        input_file = input_paths{i};
        break;
    end
end

if isempty(input_file)
    error(['未找到 _vehicle_input.json。' ...
           '请先生成输入文件。']);
end

fprintf('读取: %s\n', input_file);
input_data = load_json(input_file);

% 提取算法参数
alpha = input_data.algorithmParams.alpha;
Capacity_Scale = input_data.algorithmParams.Capacity_Scale;
allowed_layers_per_block = input_data.algorithmParams.allowed_layers_per_block;
layer_profit_ranges = input_data.algorithmParams.layer_profit_ranges;
layer_names = {'Raw', 'Geo', 'Sem', 'Dyn'};
profit_ranges_cell = {
    layer_profit_ranges.Raw
    layer_profit_ranges.Geo
    layer_profit_ranges.Sem
    layer_profit_ranges.Dyn
    };

% 获取路线列表
routes_input = input_data.routes;
num_routes = length(routes_input);
fprintf('共 %d 条路线需要计算\n', num_routes);

%% ==================== 为每条路线独立执行 MWC ====================

% 固定随机种子以保持可复现
rng(42);

route_results = struct([]);

for route_idx = 1:num_routes
    route_info = routes_input(route_idx);
    routeId = route_info.routeId;
    E = route_info.E;          % 该路线的 RSU 数量
    X = route_info.X;          % 每 RSU 的内容块数
    vehicleCount = route_info.vehicleCount;

    TOTAL_TILES = E * X;
    fprintf('\n========== 路线 %d (ID=%d): E=%d, X=%d, 车辆=%d, 总块数=%d ==========\n', ...
        route_idx, routeId, E, X, vehicleCount, TOTAL_TILES);

    if E < 1 || X < 1
        fprintf('  跳过: 无效参数\n');
        continue;
    end

    % Prob_Route: 车辆访问该路线各 RSU 的概率
    % 同一条路线上车辆会经过所有 RSU，设为 0.5 使缓存容量为 X 的 60%
    Prob_Route = ones(1, E) * 0.5;

    Tile_Size = ones(1, TOTAL_TILES);
    C_RSU = round(Prob_Route * X * Capacity_Scale);
    C_RSU = max(C_RSU, round(X * 0.3));

    %% ==================== 1. 概率分布 ====================
    fprintf('生成概率分布 (E=%d, X=%d)...\n', E, X);
    psi_matrix = ProbabilityDistribution(E, X);

    psi = zeros(1, TOTAL_TILES);
    for r = 1:E
        start_idx = (r-1) * X + 1;
        end_idx = r * X;
        psi(start_idx:end_idx) = psi_matrix(r, start_idx:end_idx);
    end

    %% ==================== 2. 瓦块层级分配 ====================
    fprintf('分配瓦块层级...\n');
    remaining_tiles = TOTAL_TILES;
    block_layer_counts = [];
    block_tile_indices = {};

    while remaining_tiles > 0
        if remaining_tiles == 1
            layer_count = 1;
        elseif remaining_tiles == 2
            layer_count = 2;
        elseif remaining_tiles == 3
            temp_allowed = allowed_layers_per_block(allowed_layers_per_block <= 3);
            layer_count = temp_allowed(randi(length(temp_allowed)));
        else
            layer_count = allowed_layers_per_block(randi(length(allowed_layers_per_block)));
        end
        block_layer_counts = [block_layer_counts, layer_count];
        block_tile_indices{end+1} = (TOTAL_TILES - remaining_tiles + 1) : ...
                                     (TOTAL_TILES - remaining_tiles + layer_count);
        remaining_tiles = remaining_tiles - layer_count;
    end

    NUM_BLOCKS = length(block_layer_counts);

    %% ==================== 3. 净收益计算 ====================
    fprintf('计算净收益...\n');
    W_net = zeros(1, TOTAL_TILES);

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

    %% ==================== 4. 依赖矩阵 ====================
    fprintf('构建依赖矩阵...\n');
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

    %% ==================== 5. MWC 求解器 ====================
    fprintf('运行 MWC 求解器...\n');
    [CacheDecision_MWC, MaxNetUtility_MWC] = HM_MWC_Solver(W_net, dependency_matrix);

    %% ==================== 6. 容量精化 ====================
    fprintf('容量精化...\n');
    is_overloaded = false;
    for r = 1:E
        start_idx = (r-1)*X + 1;
        end_idx = r*X;
        CurrentSize = sum(CacheDecision_MWC(start_idx:end_idx) .* Tile_Size(start_idx:end_idx));
        if CurrentSize > C_RSU(r)
            is_overloaded = true;
        end
    end

    if is_overloaded
        CacheDecision_Final = Capacity_Refinement_MultiRSU(...
            CacheDecision_MWC, W_net, Tile_Size, dependency_matrix, C_RSU, E, X);
        MaxNetUtility_Final = sum(CacheDecision_Final .* W_net);
    else
        CacheDecision_Final = CacheDecision_MWC;
        MaxNetUtility_Final = MaxNetUtility_MWC;
    end

    %% ==================== 7. 命中率计算 ====================
    fprintf('计算命中率...\n');
    CHR_RSU = zeros(1, E);
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
            CHR_RSU(r) = Hit_RSU_r / Request_Weighted_r;
        else
            CHR_RSU(r) = 0;
        end
    end

    CHR_Total = Total_Hit_Route / Total_Req_Route;
    fprintf('路线 %d MWC 命中率: %.4f, 缓存块数: %d/%d\n', ...
        routeId, CHR_Total, sum(CacheDecision_Final), TOTAL_TILES);

    %% ==================== 8. 构建该路线结果 ====================
    CacheDecision_arr = double(CacheDecision_Final);

    route_result = struct();
    route_result.routeId = routeId;
    route_result.CacheDecision = CacheDecision_arr;
    route_result.psi = psi;
    route_result.W_net = W_net;
    route_result.CHR_RSU = CHR_RSU;
    route_result.CHR_Total = CHR_Total;
    route_result.MaxNetUtility_MWC = MaxNetUtility_MWC;
    route_result.MaxNetUtility_Final = MaxNetUtility_Final;
    route_result.Total_Cached_Tiles = sum(CacheDecision_Final);
    route_result.NUM_BLOCKS = NUM_BLOCKS;
    route_result.E = E;
    route_result.X = X;

    if isempty(route_results)
        route_results = route_result;
    else
        route_results(end+1) = route_result;
    end
end

%% ==================== 9. 输出结果 ====================
fprintf('\n写入 cache_decision.json...\n');

output = struct();
output.routes = route_results;
output.timestamp = datestr(now);

% 输出 JSON
json_str = jsonencode(output);
output_path = '';
for i = 1:length(input_paths)
    if ~isempty(input_file) && strcmp(input_file, input_paths{i})
        output_path = strrep(input_paths{i}, '_vehicle_input.json', 'cache_decision.json');
        break;
    end
end
if isempty(output_path)
    output_path = 'cache_decision.json';
end

fid = fopen(output_path, 'w');
if fid == -1
    error('无法写入: %s', output_path);
end
fprintf(fid, '%s', json_str);
fclose(fid);
fprintf('输出: %s (%.1f KB)\n', output_path, length(json_str) / 1024);
fprintf('=== 完成 ===\n');

%% ==================== 辅助函数 ====================
function data = load_json(filename)
    fid = fopen(filename, 'r');
    if fid == -1
        error('无法打开: %s', filename);
    end
    raw = fread(fid, inf, '*char')';
    fclose(fid);
    data = jsondecode(raw);
end
