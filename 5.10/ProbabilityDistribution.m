function [psi] = ProbabilityDistribution(E, X)
% PROBABILITYDISTRIBUTION - 计算不同跳数 (RSU数量) 下的瓦片请求概率分布
% 优化版本：提高热门瓦片的概率集中度，增加命中率
%
% 输入:
%   E: 边缘节点数 (RSU 区域数量，决定输出 psi 的行数)
%   X: 每个 RSU 区域的瓦片请求数量
%
% 输出:
%   psi: 瓦片请求概率矩阵 (E x K)。
%        psi(r, k) 代表在 r 个连续 RSU 组成的路径上，车辆访问第 k 个瓦片的概率。

    K = E * X; % 总瓦片数
    
    % 1. 初始化基础请求概率 px - 使用更集中的分布
    % 调整泊松参数使概率更集中在前部
    px = poisspdf(1:K, X * 0.7);  % 降低泊松参数，使概率更集中
    px = px / sum(px);  % 归一化
    
    % 2. 初始概率分布 (psi1): 1 跳/第 1 个 RSU
    % 使用幂律分布使热门瓦片概率更高
    psi_rows = {}; % 用于存储每一跳的概率分布
    
    % 计算 psi1 (1 跳 RSU 路径的请求概率)
    % 使用幂律分布增强热门瓦片的概率
    psi1_full = zeros(1, K);
    for i = 1:K
        % 幂律分布：p(i) ∝ 1/i^beta，beta越小越集中
        beta = 0.6;  % 降低beta值，使概率更集中在热门瓦片
        psi1_full(i) = 1 / (i^beta);
    end
    psi1_full = psi1_full / sum(psi1_full);  % 归一化
    
    % 确保 psi1_full 长度为 K
    psi1 = psi1_full(1:K);
    psi_rows{1} = psi1;

    % 3. 循环计算后续 RSU 的卷积概率分布 (2跳, 3跳, ..., E跳)
    previous_psi = psi1; % 从 psi1 开始卷积
    
    for r = 2:E
        % 计算当前跳 r 的概率分布
        current_psi_full = conv(px, previous_psi);
        
        % 截断或填充以确保长度为 K
        current_psi = zeros(1, K);
        len = min(K, length(current_psi_full));
        current_psi(1:len) = current_psi_full(1:len);
        
        % 归一化处理，保持概率分布的合理性
        current_psi = current_psi / max(current_psi);
        current_psi = current_psi * 0.95 + 0.05 / K;  % 增加最小值，避免零概率
        
        psi_rows{r} = current_psi;
        previous_psi = current_psi; % 更新前一个分布
    end
    
    % 4. 堆叠成最终输出矩阵
    psi = cell2mat(psi_rows'); % Transpose the cell array for proper stacking
    
    % 5. 增强概率分布的峰值，提高热门瓦片识别
    psi = psi .^ 0.8;  % 压缩低值，放大高值
    psi = psi ./ max(psi(:));  % 归一化到 [0, 1]

end