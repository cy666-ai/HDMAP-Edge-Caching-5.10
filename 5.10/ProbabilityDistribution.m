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
%
% ==================== 版本说明 ====================
% 修改日期: 2024-xx (v5.10)
% 修改内容:
%   - 使用幂律分布使热门瓦片概率更集中
%   - 每 BATCH_SIZE 个 RSU 重置概率基数，避免长路径下概率过度扩散
%
% =================================================

    % ========== 批处理参数 ==========
    % 每 BATCH_SIZE 个 RSU 作为一个计算批次
    % 如果车辆将要经过的 RSU 数量 > BATCH_SIZE，则每批使用 BATCH_SIZE；
    % 如果剩余 RSU 数量不足 BATCH_SIZE，则使用剩余数量。
    %
    % 例如 E = 8, BATCH_SIZE = 3:
    %   批次1: RSUs 1-3, 批次2: RSUs 4-6, 批次3: RSUs 7-8
    % 每个批次独立从基础的 1-RSU 概率分布开始计算。
    BATCH_SIZE = 3;

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
    psi1_full = psi1_full / max(psi1_full);  % 用MAX归一化，与后续多跳行保持一致
    psi1_full = psi1_full * 0.95 + 0.05 / K;  % 增加最小值，避免零概率（同第52行逻辑）

    % 确保 psi1_full 长度为 K
    psi1 = psi1_full(1:K);
    psi_rows{1} = psi1;

    % 公共归一化因子: 以 psi1 的峰值为基准
    % 后续各行的卷积结果都除以这个值，保留 1-hop > 2-hop > 3-hop 的自然衰减
    norm_factor = max(psi1);

    % 3. 循环计算后续 RSU 的卷积概率分布 (2跳, 3跳, ..., E跳)
    %
    % 修改说明 (v5.10 批次计算):
    %   原逻辑: 从 r=2 到 E 持续卷积，路径越长概率越扩散。
    %   新逻辑: 每 BATCH_SIZE 个 RSU 重置一次概率基数，
    %           使每个计算批次内部的 RSU 共享一个更集中的概率分布，
    %           避免长路径下概率过度扩散导致热门瓦片区分度下降。
    %
    %   具体规则:
    %     - 每 BATCH_SIZE 个 RSU 作为一个计算批次
    %     - 批次内部: 第1个RSU=1-hop, 第2个=2-hop, 第3个=3-hop（即 min(pos, BATCH_SIZE) 跳）
    %     - 批次之间: 重新从 1-hop 开始计算，相互独立
    %
    previous_psi = psi1; % 从 psi1 开始卷积

    for r = 2:E
        % 判断当前 RSU 是否为新批次的起点
        % 批次划分: RSUs 1~BATCH_SIZE 为批次1, RSUs BATCH_SIZE+1~2*BATCH_SIZE 为批次2, ...
        % 一个新批次开始时 ((r-1) 能被 BATCH_SIZE 整除)，跳过卷积，直接用 psi1
        if mod(r - 1, BATCH_SIZE) == 0
            % 新批次的起点: 直接使用 1-hop 分布（不进行卷积）
            current_psi = psi1;
        else
            % 批次内部: 对上一 RSU 的分布进行卷积，得到下一跳分布
            current_psi_full = conv(px, previous_psi);

            % 截断或填充以确保长度为 K
            current_psi = zeros(1, K);
            len = min(K, length(current_psi_full));
            current_psi(1:len) = current_psi_full(1:len);

            % 归一化处理：使用公共基准 norm_factor，保留 1-hop > 2-hop > 3-hop 的衰减
            current_psi = current_psi / norm_factor;
            current_psi = current_psi * 0.95 + 0.05 / K;  % 增加最小值，避免零概率
        end

        psi_rows{r} = current_psi;
        previous_psi = current_psi; % 更新前一个分布
    end

    % 4. 堆叠成最终输出矩阵
    psi = cell2mat(psi_rows'); % Transpose the cell array for proper stacking
    % 不再进行全局 .^0.8 压缩和 /max 归一化，保留各行内部的自然递减结构

end
