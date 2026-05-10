%% HM_Utils.m - RSU 缓存策略辅助工具函数集合
% 包含坐标转换、RSU网络绘制、车辆请求生成等辅助功能

%% ==================== UTM 坐标转换函数 ====================
function [X, Y] = latlon2utm(lat, lon, utmZone)
    % LATLON2UTM - 简化的经纬度到UTM坐标转换
    % 输入:
    %   lat: 纬度向量（度）
    %   lon: 经度向量（度）
    %   utmZone: UTM 区域编号（默认33）
    % 输出:
    %   X, Y: UTM坐标（米）
    
    if nargin < 3
        utmZone = 33;  % 默认 UTM Zone 33
    end
    
    % 粗略的经纬度转米系数（在纬度 41.89 附近）
    K_lat = 110940;  % 1度纬度约等于 110940 米
    K_lon = 83500;   % 1度经度约等于 83500 米 (cos(41.89) * 111320)
    
    % 以第一个点为原点进行近似计算
    X = (lon - lon(1)) * K_lon;
    Y = (lat - lat(1)) * K_lat;
end

%% ==================== RSU 网络可视化函数 ====================
function PlotRSUNetwork(Routes, RouteStyles)
    % PLOTRSUNETWORK - 绘制 RSU 平面坐标分布和路线
    % 输入:
    %   Routes: 路线单元格数组，每个元素是RSU编号序列
    %   RouteStyles: 路线样式单元格数组
    
    % 默认RSU坐标数据
    P_RSU = [41.890843, 12.498359; 41.89158578343158, 12.499088433064271; ...
             41.89200108780592, 12.49949612882326; 41.89353830222886, 12.501073143825243; ...
             41.894063493475194, 12.501619366973616; 41.89478633026997, 12.502332491650654; ...
             41.89061296453875, 12.499517925125907; 41.89094616613163, 12.499806209565199; ...
             41.891623858924184, 12.500526920663429; 41.89266297391715, 12.50155108906951; ...
             41.89301310670516, 12.50193041071574; 41.89360606910373, 12.502484220296488; ...
             41.89431761671564, 12.503182172096881; 41.890324941423444, 12.500989693057814; ...
             41.89109300018128, 12.501702817723436; 41.8915673848072, 12.502203522284217; ...
             41.89239190207172, 12.503015270573806; 41.89298487023722, 12.50358425301978; ...
             41.89373595536069, 12.504304964127888; 41.89023458096101, 12.50294699269303; ...
             41.8905226044869, 12.50409254401735; 41.890940518665765, 12.505351891833481; ...
             41.89123418645127, 12.506254677314423; 41.89118900687983, 12.502393183114423; ...
             41.891527852886654, 12.50353114800637; 41.891934465722194, 12.504782909387508; ...
             41.892262013068446, 12.505769145627195; 41.893227703227005, 12.50670227683859; ...
             41.89208694486819, 12.50322769070185; 41.89245402280084, 12.504426347054698; ...
             41.89321076142455, 12.505200163181224; 41.893747249806594, 12.505776732071821; ...
             41.894323263877986, 12.506269850191664];
    
    % 道路网连接对
    connect_pairs = [1,2; 1,7; 2,3; 2,8; 3,4; 3,9; 4,5; 4,10; 5,6; 5,12; 6,13; ...
                     7,8; 7,14; 8,9; 9,10; 9,15; 10,11; 10,16; 11,12; 11,17; 12,13; 12,18; 13,19; ...
                     14,15; 14,20; 15,16; 16,17; 16,24; 17,18; 17,29; 18,19; 18,30; 19,31; ...
                     20,21; 20,24; 21,22; 21,25; 22,23; 22,26; 23,27; 24,25; 25,29; 26,27; 26,30; 27,28; 27,31; 28,32; ...
                     29,30; 30,31; 31,32; 32,33];
    
    % 坐标转换
    lat = P_RSU(:,1);
    lon = P_RSU(:,2);
    [X, Y] = latlon2utm(lat, lon, 33);
    P_RSU_UTM = [X, Y];
    P_RSU_local = P_RSU_UTM - P_RSU_UTM(1,:);
    
    % 创建画布
    figure('Color','white','Position',[100,100,800,600]);
    hold on; grid on; box on;
    
    % 绘制道路网
    for i = 1:size(connect_pairs,1)
        start_idx = connect_pairs(i,1);
        end_idx = connect_pairs(i,2);
        x_line = P_RSU_local([start_idx, end_idx], 1);
        y_line = P_RSU_local([start_idx, end_idx], 2);
        plot(x_line, y_line, 'Color', [0.7 0.7 0.7], 'LineWidth', 1.5, 'HandleVisibility', 'off');
    end
    
    % 绘制定义的路线
    h_routes = [];
    route_legend = cell(length(Routes), 1);
    for r = 1:length(Routes)
        route = Routes{r};
        style = RouteStyles{r};
        
        x_route = P_RSU_local(route, 1);
        y_route = P_RSU_local(route, 2);
        
        h_route = plot(x_route, y_route, style{:});
        h_routes = [h_routes; h_route];
        route_legend{r} = ['路线 ', num2str(r), ' (', num2str(route(1)), '->', num2str(route(end)), ')'];
        
        % 突出起点和终点
        scatter(x_route(1), y_route(1), 120, 'b', 'd', 'filled', 'MarkerEdgeColor', 'k', 'HandleVisibility', 'off');
        scatter(x_route(end), y_route(end), 120, 'k', 's', 'filled', 'MarkerEdgeColor', 'w', 'HandleVisibility', 'off');
    end
    
    % 绘制 RSU 节点
    h_rsu = scatter(P_RSU_local(:,1), P_RSU_local(:,2), 80, 'k', 'filled', 'MarkerEdgeColor','w');
    
    % 标注顶点编号
    for i = 1:size(P_RSU_local,1)
        text(P_RSU_local(i,1)+5, P_RSU_local(i,2)+5, num2str(i), ...
             'FontSize',10, 'FontWeight','bold', 'Color','blue', 'HandleVisibility', 'off');
    end
    
    % 图形美化
    xlabel('东向坐标（米）','FontSize',12, 'FontWeight','bold');
    ylabel('北向坐标（米）','FontSize',12, 'FontWeight','bold');
    title('RSU平面坐标分布及车辆路线','FontSize',14, 'FontWeight','bold');
    
    h_combined = [h_rsu; h_routes];
    legend_entries = [{'RSU'}; route_legend];
    legend(h_combined, legend_entries, 'Location','best');
    
    axis equal;
    xlim([min(P_RSU_local(:,1))-50, max(P_RSU_local(:,1))+50]);
    ylim([min(P_RSU_local(:,2))-50, max(P_RSU_local(:,2))+50]);
    hold off;
    
    % 输出路线信息
    disp('=== RSU 网络可视化 ===');
    for r = 1:length(Routes)
        disp(['路线 ', num2str(r), ': ', num2str(Routes{r})]);
    end
end

%% ==================== 车辆请求瓦片生成函数 ====================
function Requested_Tiles = GetVehicleRequest(Start_RSU, End_RSU, Direction)
    % GETVEHICLEREQUEST - 生成车辆请求的瓦片序列
    % 输入:
    %   Start_RSU: 起点RSU编号 (1-33)
    %   End_RSU: 终点RSU编号 (1-33)
    %   Direction: 行驶方向 (1:左拐, 2:直行, 3:右拐)
    % 输出:
    %   Requested_Tiles: 请求的瓦片编号序列
    
    % RSU坐标数据
    P_RSU_local = [41.890843, 12.498359; 41.89158578343158, 12.499088433064271; ...
                   41.89200108780592, 12.49949612882326; 41.89353830222886, 12.501073143825243; ...
                   41.894063493475194, 12.501619366973616; 41.89478633026997, 12.502332491650654; ...
                   41.89061296453875, 12.499517925125907; 41.89094616613163, 12.499806209565199; ...
                   41.891623858924184, 12.500526920663429; 41.89266297391715, 12.50155108906951; ...
                   41.89301310670516, 12.50193041071574; 41.89360606910373, 12.502484220296488; ...
                   41.89431761671564, 12.503182172096881; 41.890324941423444, 12.500989693057814; ...
                   41.89109300018128, 12.501702817723436; 41.8915673848072, 12.502203522284217; ...
                   41.89239190207172, 12.503015270573806; 41.89298487023722, 12.50358425301978; ...
                   41.89373595536069, 12.504304964127888; 41.89023458096101, 12.50294699269303; ...
                   41.8905226044869, 12.50409254401735; 41.890940518665765, 12.505351891833481; ...
                   41.89123418645127, 12.506254677314423; 41.89118900687983, 12.502393183114423; ...
                   41.891527852886654, 12.50353114800637; 41.891934465722194, 12.504782909387508; ...
                   41.892262013068446, 12.505769145627195; 41.893227703227005, 12.50670227683859; ...
                   41.89208694486819, 12.50322769070185; 41.89245402280084, 12.504426347054698; ...
                   41.89321076142455, 12.505200163181224; 41.893747249806594, 12.505776732071821; ...
                   41.894323263877986, 12.506269850191664];
    
    connect_pairs = [1,2; 1,7; 2,3; 2,8; 3,4; 3,9; 4,5; 4,10; 5,6; 5,12; 6,13; ...
                     7,8; 7,14; 8,9; 9,10; 9,15; 10,11; 10,16; 11,12; 11,17; 12,13; 12,18; 13,19; ...
                     14,15; 14,20; 15,16; 16,17; 16,24; 17,18; 17,29; 18,19; 18,30; 19,31; ...
                     20,21; 20,24; 21,22; 21,25; 22,23; 22,26; 23,27; 24,25; 25,29; 26,27; 26,30; 27,28; 27,31; 28,32; ...
                     29,30; 30,31; 31,32; 32,33];
    
    % 计算道路长度
    R = 6371000;  % 地球半径（米）
    Road_Database = zeros(size(connect_pairs,1), 3);
    
    for i = 1:size(connect_pairs,1)
        idx_u = connect_pairs(i, 1);
        idx_v = connect_pairs(i, 2);
        
        lat1 = P_RSU_local(idx_u, 1); lon1 = P_RSU_local(idx_u, 2);
        lat2 = P_RSU_local(idx_v, 1); lon2 = P_RSU_local(idx_v, 2);
        
        phi1 = lat1 * pi/180; phi2 = lat2 * pi/180;
        delta_phi = (lat2 - lat1) * pi/180;
        delta_lambda = (lon2 - lon1) * pi/180;
        
        a = sin(delta_phi/2)^2 + cos(phi1) * cos(phi2) * sin(delta_lambda/2)^2;
        c = 2 * atan2(sqrt(a), sqrt(1-a));
        dist_meters = R * c;
        
        Road_Database(i, :) = [idx_u, idx_v, round(dist_meters)];
    end
    
    % 检索当前行驶路段
    idx = find(Road_Database(:,1) == Start_RSU & Road_Database(:,2) == End_RSU);
    if isempty(idx)
        error('未找到该RSU连通路径，请检查拓扑定义。');
    end
    
    Road_Length = Road_Database(idx, 3);
    
    % 根据行驶方向调整请求策略
    switch Direction
        case 1  % 左拐
            Request_Range = 1 : Road_Length;
        case 2  % 直行
            Request_Range = 1 : Road_Length;
        case 3  % 右拐
            Request_Range = 1 : Road_Length;
        otherwise
            error('无效的方向指令');
    end
    
    % 生成瓦片编号
    Requested_Tiles = Start_RSU * 10000 + Request_Range;
end

%% ==================== 南京鼓楼区 UTM 坐标转换函数 ====================
function [X, Y] = latlon2utm_nanjing(lat, lon)
    % LATLON2UTM_NANJING - 南京地区经纬度到UTM坐标转换
    % 输入:
    %   lat: 纬度向量（度），南京鼓楼区中心约32.059000°N
    %   lon: 经度向量（度），南京鼓楼区中心约118.769000°E
    % 输出:
    %   X, Y: UTM坐标（米），基于UTM Zone 50N
    %
    % UTM Zone 50N 覆盖东经114°-120°，南京(118.769000°E)在此范围内

    K_lat = 110940;           % 1°纬度 ≈ 110940米
    K_lon = 94563;            % 1°经度 ≈ 94563米 (cos(32.059000°)×111320)

    X = (lon - lon(1)) * K_lon;
    Y = (lat - lat(1)) * K_lat;
end

%% ==================== 南京鼓楼区 RSU 网络可视化函数（综合部署版） ====================
function PlotRSUNetwork_Nanjing(RSU_positions, RSU_regions, extra_roads_flag)
    % PLOTRSUNETWORK_NANJING - 绘制南京鼓楼区道路网络和RSU综合部署图
    % 输入:
    %   RSU_positions: N×2 矩阵 [纬度, 经度]
    %   RSU_regions: 可选的N×1区域向量 (1=北区, 2=中区, 3=南区)
    %   extra_roads_flag: 是否绘制扩展道路（默认true）
    %
    % 部署方案包含：
    %   1. 鼓楼站方圆2.5km内全部8座地铁站
    %   2. 沿9条主要道路每隔~350m部署的RSU

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

    % 绘制区域边界虚线
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

    % 标注地铁站
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

    disp('=== 南京鼓楼区 RSU 网络可视化 ===');
    disp(['共 9 条道路, ', num2str(num_rsu), ' 个 RSU 节点（含8个地铁站）']);
end

function [length_meters] = CalculateRoadLength(lat1, lon1, lat2, lon2)
    % CALCULATEROADLENGTH - 使用Haversine公式计算两点间球面距离
    % 输入:
    %   lat1, lon1: 起点经纬度（度）
    %   lat2, lon2: 终点经纬度（度）
    % 输出:
    %   length_meters: 距离（米）
    
    R = 6371000;  % 地球半径（米）
    
    phi1 = lat1 * pi/180;
    phi2 = lat2 * pi/180;
    delta_phi = (lat2 - lat1) * pi/180;
    delta_lambda = (lon2 - lon1) * pi/180;
    
    a = sin(delta_phi/2)^2 + cos(phi1) * cos(phi2) * sin(delta_lambda/2)^2;
    c = 2 * atan2(sqrt(a), sqrt(1-a));
    
    length_meters = R * c;
end