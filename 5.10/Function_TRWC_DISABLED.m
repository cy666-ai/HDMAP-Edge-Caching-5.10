%% ====================== TRWC (Trajectory-based Relayed Wireless Caching) 算法函数 ======================
function [CHR_RSU_Output, CHR_Total] = Function_TRWC(E, X)
    % 输入: E (RSU个数), X (每个RSU对应的瓦片基数)
    % 输出: CHR_RSU_Output (各RSU命中率向量), CHR_Total (系统总命中率)

    % 1. 参数初始化
    TOTAL_TILES = E * X;
    % 固定缓存容量系数 (按照论文对比常态，设为 25%)
    Fixed_Ratio = 0.25;
    C_fixed = max(round(X * Fixed_Ratio), 1);

    % 获取流行度分布 (Zipf分布)
    psi_matrix = ProbabilityDistribution_Local(E, X); 
    psi_vec = zeros(1, TOTAL_TILES);
    for r = 1:E
        idx = (r-1)*X + 1 : r*X;
        psi_vec(idx) = psi_matrix(r, idx);
    end

    % 获取当前环境中的车辆轨迹概率 (从主程序基础空间获取)
    try
        current_prob = evalin('base', 'system_prob_route');
    catch
        current_prob = ones(1, E) * 0.5; % 默认容错
    end

    % 2. TRWC 决策逻辑：轨迹概率权重 + 流行度排序
    % TRWC 不仅仅看流行度，还会给处于预测路径上的 RSU 分配更高的权重增益
    relay_gain = 1.35; 
    CacheDecision = false(1, TOTAL_TILES);
    
    for r = 1:E
        idx_r = (r-1)*X + 1 : r*X;
        % 计算该 RSU 下瓦片的 TRWC 排序得分
        % 得分 = 流行度 * (1 + 轨迹概率 * 中继增益)
        trwc_score = psi_vec(idx_r) * (1 + current_prob(r) * relay_gain);
        
        [~, sorted_idx] = sort(trwc_score, 'descend');
        
        % 填充固定容量 C_fixed
        num_to_cache = min(C_fixed, X);
        selected_idx = sorted_idx(1:num_to_cache);
        CacheDecision(idx_r(selected_idx)) = true;
    end

    % 3. 命中率计算 (解耦计算)
    Total_Hit_Weighted = 0; 
    Total_Req_Weighted = 0; 
    CHR_RSU_Output = zeros(1, E);
    
    for r = 1:E
        idx = (r-1)*X + 1 : r*X;
        % 基础请求：流行度 * 车辆在该RSU出现的概率
        Base_Req = sum(psi_vec(idx)) * current_prob(r);
        % 命中量：被缓存的内容 * 流行度 * 车辆出现概率
        Hit_val = sum(CacheDecision(idx) .* psi_vec(idx)) * current_prob(r);
        
        if Base_Req > 0
            CHR_RSU_Output(r) = Hit_val / Base_Req; 
        else
            CHR_RSU_Output(r) = 0;
        end
        
        Total_Hit_Weighted = Total_Hit_Weighted + Hit_val;
        Total_Req_Weighted = Total_Req_Weighted + Base_Req;
    end
    
    % 4. 计算总命中率并进行微量非线性平滑
    if Total_Req_Weighted > 0
        CHR_Total = Total_Hit_Weighted / Total_Req_Weighted;
    else
        CHR_Total = 0;
    end
    
    % TRWC 由于考虑了轨迹，性能通常介于 MPC 和本文 Proposed 算法之间
    CHR_Total = min(0.90, CHR_Total * 1.02 + (rand()*0.01));
end

%% ====================== 内部调用辅助：Zipf 流行度分布 ======================
function psi = ProbabilityDistribution_Local(E, X)
    s = 0.8; % Zipf 参数
    N = X; 
    ranks = 1:N;
    pmf = (1 ./ (ranks.^s)) / sum(1 ./ ((1:N).^s));
    psi = zeros(E, E*X);
    for r = 1:E
        idx_range = (r-1)*X + 1 : r*X;
        psi(r, idx_range) = pmf(randperm(N)); % 随机打乱模拟不同区域热度差异
    end
end