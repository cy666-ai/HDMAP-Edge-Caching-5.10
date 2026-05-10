function RSU_Result = GenerateRSUDeployment_Nanjing()
    % GenerateRSUDeployment_Nanjing - 生成南京鼓楼区行驶路径RSU部署方案
    %
    % 部署策略：
    %   1. 沿6条高德地图车辆行驶路径每隔~500m部署RSU（基于高德API真实路径几何）
    %   2. RSU覆盖半径250m，覆盖范围不重叠（间距=500m）
    %   3. 合并去重，按纬度分为3个走廊区域
    %
    % 路径数据与 simmap1.0/backend/data/route_paths.json（高德API获取）保持一致
    %
    % 输出:
    %   RSU_Result — 结构体包含 positions, names, regions, Prob_Route 等字段

    %% ==================== 1. 加载车辆行驶路径数据 ====================
    route_paths_file = '../simmap1.0/backend/data/route_paths.json';
    [route_names, route_points] = load_route_paths(route_paths_file);
    num_routes = length(route_names);

    %% ==================== 2. 沿行驶路径生成RSU点（使用多段线累积距离） ====================
    RSU_SPACING_M = 500;   % RSU部署间距（米），固定500m
    MIN_DIST_M = 500;      % 去重最小距离（米），与间距一致

    % 所有候选RSU点 [纬度, 经度]
    candidate_points = [];
    candidate_names = {};

    % 对每条路径的多段线，使用累积Haversine距离生成RSU点（经纬度转米）
    for r = 1:num_routes
        route_name = route_names{r};
        waypoints = route_points{r};  % N×2矩阵 [lat, lng]
        n_pts = size(waypoints, 1);

        if n_pts < 2, continue; end

        % 计算累积距离
        cum_dist = zeros(n_pts, 1);
        for i = 2:n_pts
            cum_dist(i) = cum_dist(i-1) + ...
                haversine_dist(waypoints(i-1,1), waypoints(i-1,2), waypoints(i,1), waypoints(i,2));
        end
        total_len = cum_dist(n_pts);

        % 分段数（每隔500m）
        num_segments = max(1, round(total_len / RSU_SPACING_M));

        for s = 0:num_segments
            if num_segments == 0, break; end
            t = s / num_segments;
            target_dist = t * total_len;

            % 查找目标距离所在的线段
            seg_idx = n_pts - 1;
            for i = 2:n_pts
                if cum_dist(i) >= target_dist
                    seg_idx = i - 1;
                    break;
                end
            end

            seg_len = cum_dist(seg_idx + 1) - cum_dist(seg_idx);
            if seg_len > 0
                local_t = (target_dist - cum_dist(seg_idx)) / seg_len;
            else
                local_t = 0;
            end

            lat = waypoints(seg_idx, 1) + (waypoints(seg_idx + 1, 1) - waypoints(seg_idx, 1)) * local_t;
            lng = waypoints(seg_idx, 2) + (waypoints(seg_idx + 1, 2) - waypoints(seg_idx, 2)) * local_t;

            if isempty(candidate_points) || is_far_enough(lat, lng, candidate_points, MIN_DIST_M)
                candidate_points(end + 1, :) = [lat, lng];
                if t == 0
                    pt_name = sprintf('%s 起点', route_name);
                elseif t >= 1
                    pt_name = sprintf('%s 终点', route_name);
                else
                    pt_name = sprintf('%s (%.0fm)', route_name, round(target_dist));
                end
                candidate_names{end + 1, 1} = pt_name;
            end
        end
    end

    N_total = size(candidate_points, 1);
    fprintf('沿路径生成RSU候选点: %d\n', N_total);

    %% ==================== 3. 按纬度划分为3个走廊区域 ====================
    region_boundaries = [32.065000, 32.050000];  % [北区下限, 中区下限]
    region_names = {'北区-新模范马路走廊', '中区-北京西路走廊（核心区）', '南区-汉中路走廊'};

    region_assignments = zeros(N_total, 1);
    region_rsu_names = cell(3, 1);
    region_rsu_names(:) = {''};

    for i = 1:N_total
        lat = candidate_points(i, 1);
        if lat >= region_boundaries(1)
            region_assignments(i) = 1;  % 北区
        elseif lat > region_boundaries(2)
            region_assignments(i) = 2;  % 中区
        else
            region_assignments(i) = 3;  % 南区
        end
    end

    region_counts = [sum(region_assignments == 1), sum(region_assignments == 2), sum(region_assignments == 3)];
    fprintf('\n区域RSU分布:\n');
    for r = 1:3
        fprintf('  %s: %d 个RSU\n', region_names{r}, region_counts(r));
    end
    fprintf('  总RSU数: %d\n', N_total);

    %% ==================== 4. 路线概率 ====================
    raw_probs = region_counts / sum(region_counts);
    min_p = 0.5; max_p = 0.95;
    if length(raw_probs) > 1
        Prob_Route = min_p + (raw_probs - min(raw_probs)) / ...
            (max(raw_probs) - min(raw_probs) + eps) * (max_p - min_p);
    else
        Prob_Route = max_p;
    end

    %% ==================== 5. 输出结构化结果 ====================
    RSU_Result = struct();
    RSU_Result.positions = candidate_points(:, 1:2);
    RSU_Result.names = candidate_names;
    RSU_Result.region = region_assignments;
    RSU_Result.E = 3;
    RSU_Result.region_names = region_names;
    RSU_Result.region_lats = [32.072000, 32.058000, 32.046000];
    RSU_Result.RSU_per_region = region_counts;
    RSU_Result.totalRSU = N_total;
    RSU_Result.Prob_Route = Prob_Route;

    fprintf('\n========================================\n');
    fprintf('  南京鼓楼区 RSU 部署方案\n');
    fprintf('========================================\n');
    fprintf('  总RSU数: %d 个\n', N_total);
    fprintf('  覆盖路径: %d 条\n', num_routes);
    fprintf('  RSU间距: %d 米 (覆盖半径250m, 不重叠)\n', RSU_SPACING_M);
    fprintf('  Prob_Route: [%.6f, %.6f, %.6f]\n', Prob_Route);
    fprintf('========================================\n');
end

%% ==================== 辅助函数 ====================

function [route_names, route_points] = load_route_paths(json_file)
    % 加载车辆行驶路径数据
    % 优先从 route_paths.json（高德API真实路径），回退到内置路线定义
    route_names = {};
    route_points = {};

    % 尝试加载 route_paths.json
    if exist(json_file, 'file') == 2
        try
            json_str = fileread(json_file);
            data = jsondecode(json_str);
            if isfield(data, 'routes') && ~isempty(data.routes)
                for i = 1:length(data.routes)
                    r = data.routes(i);
                    pts = r.points;
                    if length(pts) >= 2
                        route_names{end + 1, 1} = r.name;
                        mat = zeros(length(pts), 2);
                        for j = 1:length(pts)
                            mat(j, 1) = pts(j).latitude;
                            mat(j, 2) = pts(j).longitude;
                        end
                        route_points{end + 1, 1} = mat;
                    end
                end
                fprintf('已加载 %d 条高德API车辆行驶路径数据\n', length(route_names));
                return;
            end
        catch ME
            fprintf('警告: route_paths.json 解析失败: %s，使用内置路线\n', ME.message);
        end
    else
        fprintf('route_paths.json 不存在，使用内置路线定义\n');
    end

    % 回退：内置6条路线定义
    route_names{1} = '古平岗→新庄';
    route_points{1} = [
        32.071239, 118.757977;
        32.072000, 118.765000;
        32.073000, 118.775000;
        32.074000, 118.785000;
        32.075000, 118.795000;
        32.076777, 118.810340;
    ];
    route_names{2} = '草场门→九华山';
    route_points{2} = [
        32.060422, 118.755866;
        32.060000, 118.762000;
        32.060000, 118.770000;
        32.059000, 118.778000;
        32.058000, 118.785000;
        32.057500, 118.795000;
        32.057439, 118.805877;
    ];
    route_names{3} = '汉中门→西安门';
    route_points{3} = [
        32.042863, 118.767112;
        32.042500, 118.775000;
        32.041500, 118.783000;
        32.041000, 118.790000;
        32.040500, 118.798000;
        32.040492, 118.805965;
    ];
    route_names{4} = '古平岗→汉中门';
    route_points{4} = [
        32.071239, 118.757977;
        32.066000, 118.760000;
        32.060000, 118.762000;
        32.055000, 118.764000;
        32.050000, 118.765000;
        32.042863, 118.767112;
    ];
    route_names{5} = '新模范马路→新街口';
    route_points{5} = [
        32.079933, 118.784112;
        32.075000, 118.784100;
        32.070000, 118.784100;
        32.065000, 118.784100;
        32.060000, 118.784100;
        32.055000, 118.784100;
        32.050000, 118.784100;
        32.045000, 118.784100;
        32.041611, 118.784198;
    ];
    route_names{6} = '新庄→西安门';
    route_points{6} = [
        32.076777, 118.810340;
        32.074000, 118.809000;
        32.070000, 118.808000;
        32.065000, 118.807000;
        32.060000, 118.806000;
        32.055000, 118.806000;
        32.050000, 118.806000;
        32.040492, 118.805965;
    ];
    fprintf('使用内置路线定义，共 %d 条路线\n', length(route_names));
end

function d = haversine_dist(lat1, lng1, lat2, lng2)
    R = 6371000;
    phi1 = lat1 * pi / 180;
    phi2 = lat2 * pi / 180;
    d_phi = (lat2 - lat1) * pi / 180;
    d_lambda = (lng2 - lng1) * pi / 180;
    a = sin(d_phi / 2)^2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2)^2;
    c = 2 * atan2(sqrt(a), sqrt(1 - a));
    d = R * c;
end

function ok = is_far_enough(lat, lng, points, min_dist)
    ok = true;
    for i = 1:size(points, 1)
        d = haversine_dist(lat, lng, points(i, 1), points(i, 2));
        if d < min_dist
            ok = false;
            return;
        end
    end
end
