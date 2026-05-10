%% HM_Export_CacheDecision.m
% 被 Node.js CachingService 调用的 MATLAB 导出脚本。
% 从 _vehicle_input.json 读取车辆数据和 Prob_Route，
% 运行完整算法管线，将缓存决策输出到 cache_decision.json。
%
% 调用方式:
%   matlab -batch "HM_Export_CacheDecision"
%
% 输入:  ../simmap1.0/backend/data/_vehicle_input.json
% 输出:  ../simmap1.0/backend/data/cache_decision.json

%% ==================== 0. 加载输入数据 ====================
fprintf('=== HM_Export_CacheDecision ===\n');
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
    error(['未找到 _vehicle_input.json。\n' ...
           '请先生成输入文件:\n' ...
           '  cd simmap1.0/backend\n' ...
           '  node scripts/generateMatlabInput.js\n' ...
           '或将 _vehicle_input.json 放在当前目录下。']);
end

fprintf('读取: %s\n', input_file);
input_data = load_json(input_file);

% 提取 Prob_Route 和算法参数
Prob_Route = input_data.Prob_Route;
E = input_data.algorithmParams.E;
X = input_data.algorithmParams.X;
alpha = input_data.algorithmParams.alpha;
Capacity_Scale = input_data.algorithmParams.Capacity_Scale;
allowed_layers_per_block = input_data.algorithmParams.allowed_layers_per_block;
layer_profit_ranges = input_data.algorithmParams.layer_profit_ranges;
layer_names = {'Raw', 'Geo', 'Sem', 'Dyn'};

TR = length(Prob_Route);  % 兼容 E 字段

fprintf('E=%d, X=%d, Prob_Route=[%s]\n', E, X, num2str(Prob_Route, '%.4f '));

%% ==================== 1. 参数配置 ====================
TOTAL_TILES = E * X;
fprintf('总瓦片数: %d\n', TOTAL_TILES);

Tile_Size = ones(1, TOTAL_TILES);
C_RSU = round(Prob_Route * X * Capacity_Scale);
C_RSU = max(C_RSU, round(X * 0.3));

rng(42);  % 固定随机种子以保持可复现

%% ==================== 2. 概率分布 ====================
fprintf('生成概率分布...\n');
psi_matrix = ProbabilityDistribution(E, X);

psi = zeros(1, TOTAL_TILES);
for r = 1:E
    start_idx = (r-1) * X + 1;
    end_idx = r * X;
    psi(start_idx:end_idx) = psi_matrix(r, start_idx:end_idx);
end

%% ==================== 3. 瓦块层级分配 ====================
fprintf('分配瓦块层级...\n');
remaining_tiles = TOTAL_TILES;
block_layer_counts = [];
block_tile_indices = {};
current_tile_idx = 1;

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
    block_tile_indices{end+1} = current_tile_idx : current_tile_idx + layer_count - 1;
    remaining_tiles = remaining_tiles - layer_count;
    current_tile_idx = current_tile_idx + layer_count;
end

NUM_BLOCKS = length(block_layer_counts);

%% ==================== 4. 净收益计算 ====================
fprintf('计算净收益...\n');
W_net = zeros(1, TOTAL_TILES);

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

%% ==================== 5. 依赖矩阵 ====================
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

%% ==================== 6. MWC 求解器 ====================
fprintf('运行 MWC 求解器...\n');
[CacheDecision_MWC, MaxNetUtility_MWC] = HM_MWC_Solver(W_net, dependency_matrix);

%% ==================== 7. 容量精化 ====================
fprintf('容量精化...\n');
is_overloaded = false;
for r = 1:E
    start_idx = (r-1)*X + 1;
    end_idx = r*X;
    CurrentSize_RSU = sum(CacheDecision_MWC(start_idx:end_idx) .* Tile_Size(start_idx:end_idx));
    if CurrentSize_RSU > C_RSU(r)
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

%% ==================== 8. 命中率计算 ====================
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
fprintf('MWC 总命中率: %.4f\n', CHR_Total);

%% ==================== 9. 对比算法 ====================
fprintf('运行对比算法...\n');
assignin('base', 'system_prob_route', Prob_Route);

[~, CHR_MPC_Total] = Function_MPC(E, X);
[~, CHR_MAP_Total] = Function_MAP(E, X);
[~, CHR_TRWC_Total] = Function_TRWC(E, X);

fprintf('MPC: %.4f, MAP: %.4f, TRWC: %.4f\n', CHR_MPC_Total, CHR_MAP_Total, CHR_TRWC_Total);

%% ==================== 10. 输出结果 ====================
fprintf('写入 cache_decision.json...\n');

% 准备输出结构
CacheDecision_arr = double(CacheDecision_Final);  % logical → double for JSON
Psi_arr = psi;
W_net_arr = W_net;
C_RSU_arr = C_RSU;

% 构建依赖关系统计
total_dep_violations = 0;
for b = 1:NUM_BLOCKS
    block_idx_list = block_tile_indices{b};
    block_layer_num = block_layer_counts(b);
    for l_idx = 2:block_layer_num
        dependent_tile = block_idx_list(l_idx);
        parent_tile = block_idx_list(l_idx - 1);
        if CacheDecision_Final(dependent_tile) == 1 && CacheDecision_Final(parent_tile) == 0
            total_dep_violations = total_dep_violations + 1;
        end
    end
end

output = struct();
output.CacheDecision = CacheDecision_arr;
output.psi = Psi_arr;
output.W_net = W_net_arr;
output.C_RSU = C_RSU_arr;
output.CHR_RSU = CHR_RSU;
output.CHR_Total = CHR_Total;
output.MaxNetUtility_MWC = MaxNetUtility_MWC;
output.MaxNetUtility_Final = MaxNetUtility_Final;
output.Total_Cached_Tiles = sum(CacheDecision_Final);
output.Dependency_Violations = total_dep_violations;
output.NUM_BLOCKS = NUM_BLOCKS;

% 对比算法结果
algo = struct();
algo.MWC = CHR_Total;
algo.MPC = CHR_MPC_Total;
algo.MAP = CHR_MAP_Total;
algo.TRWC = CHR_TRWC_Total;
output.Algorithm_Comparison = algo;

output.E = E;
output.X = X;
output.Prob_Route = Prob_Route;

output.timestamp = datestr(now);

% 输出 JSON（去掉大数组的缩进以减小文件大小）
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
