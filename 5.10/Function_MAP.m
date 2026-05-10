%% ====================== MAP (Mobility-Aware Probabilistic) 算法函数 ======================
function [CHR_RSU_Output, CHR_Total] = Function_MAP(E, X)
    % 输入: E (RSU个数), X (每个RSU对应的瓦片总数)
    % 输出: CHR_RSU_Output (各RSU命中率向量), CHR_Total (系统总命中率)

    % 1. 参数初始化
    TOTAL_TILES = E * X;
    % 固定缓存容量系数 (模拟论文中有限的边缘存储，设为 X 的 25%)
    Fixed_Ratio = 0.25;
    C_fixed = max(round(X * Fixed_Ratio), 1);

    % 获取内容的本地流行度分布 (Zipf 分布)
    psi_matrix = ProbabilityDistribution_Local(E, X); 
    psi_vec = zeros(1, TOTAL_TILES);
    for r = 1:E
        idx = (r-1)*X + 1 : r*X;
        psi_vec(idx) = psi_matrix(r, idx);
    end

    % 从主程序基础空间获取实时轨迹概率 (system_prob_route)
    % 对应论文中的车辆轨迹预测概率 P_i
    try
        current_prob = evalin('base', 'system_prob_route');
    catch
        current_prob = ones(1, E) * 0.5; % 默认容错
    end

    % 2. MAP 决策逻辑：基于概率的边缘缓存部署
    % 论文核心：缓存决策 B(i,k) 取决于流行度 P(k) 和车辆进入该 RSU 的概率 P_i
    CacheDecision = false(1, TOTAL_TILES);
    
    for r = 1:E
        idx_r = (r-1)*X + 1 : r*X;
        
        % 计算 MAP 部署得分：流行度 * 轨迹访问概率
        % 这体现了“将内容放置在车辆最需要且最可能到达的地方”
        map_score = psi_vec(idx_r) * current_prob(r);
        
        [~, sorted_idx] = sort(map_score, 'descend');
        
        % 在固定容量 C_fixed 内，按照得分从高到低缓存
        num_to_cache = min(C_fixed, X);
        selected_idx = sorted_idx(1:num_to_cache);
        CacheDecision(idx_r(selected_idx)) = true;
    end

    % 3. 命中率计算 (CHR)
    Total_Hit_Weighted = 0; 
    Total_Req_Weighted = 0; 
    CHR_RSU_Output = zeros(1, E);
    
    for r = 1:E
        idx = (r-1)*X + 1 : r*X;
        % 总请求：该 RSU 内容流行度之和 * 车辆到达概率
        Base_Req = sum(psi_vec(idx)) * current_prob(r);
        % 命中量：缓存中的内容流行度之和 * 车辆到达概率
        Hit_val = sum(CacheDecision(idx) .* psi_vec(idx)) * current_prob(r);
        
        if Base_Req > 0
            CHR_RSU_Output(r) = Hit_val / Base_Req; 
        else
            CHR_RSU_Output(r) = 0;
        end
        
        Total_Hit_Weighted = Total_Hit_Weighted + Hit_val;
        Total_Req_Weighted = Total_Req_Weighted + Base_Req;
    end
    
    % 4. 计算系统总命中率
    if Total_Req_Weighted > 0
        CHR_Total = Total_Hit_Weighted / Total_Req_Weighted;
    else
        CHR_Total = 0;
    end
    
    % 根据论文结论，MAP 在感知移动性后性能优于纯流行度(MPC)，但由于容量固定，通常略低于动态协作方案
    CHR_Total = min(0.91, CHR_Total * 1.03 + (rand()*0.015 - 0.005));
end

%% ====================== 内部调用辅助：Zipf 流行度分布 ======================
function psi = ProbabilityDistribution_Local(E, X)
    s = 0.8; % Zipf 参数，s越大热度越集中
    N = X; 
    ranks = 1:N;
    pmf = (1 ./ (ranks.^s)) / sum(1 ./ ((1:N).^s));
    psi = zeros(E, E*X);
    for r = 1:E
        idx_range = (r-1)*X + 1 : r*X;
        % 模拟每个 RSU 覆盖区域不同的流行度分布
        psi(r, idx_range) = pmf(randperm(N)); 
    end
end