function [B_MWC, MaxUtility] = HM_MWC_Solver(W_net, dependency_matrix)
% HM_MWC_Solver - 求解最大权值闭合子图 (MWC) 缓存问题。
% 基于最小割/最大流理论。
% 
% 输入:
%   W_net (1xn): 瓦片的净预期收益向量。
%   dependency_matrix (nxn): 依赖关系矩阵，dependency_matrix(i, j)=1 表示瓦片 i 依赖瓦片 j (即 i -> j)。
%
% 输出:
%   B_MWC (1xn logical): 缓存决策，true 表示缓存。
%   MaxUtility (标量): 最大净效用值。

num_tiles = length(W_net);
S_node = num_tiles + 1; % 源点 S 的节点 ID 
T_node = num_tiles + 2; % 汇点 T 的节点 ID 

u = []; 
v = []; 
weights = []; 
TotalPositiveWeight = 0; 

% 2. 构造 MWC 网络流图的边列表 (基于净收益 W(b))
for b = 1:num_tiles 
    Wb = W_net(b);
    
    if Wb > 0
        % 收益边: S -> b, 容量 = W(b)
        u = [u, S_node]; 
        v = [v, b];
        weights = [weights, Wb];
        TotalPositiveWeight = TotalPositiveWeight + Wb;
    else
        % 成本边: b -> T, 容量 = |W(b)|
        u = [u, b];
        v = [v, T_node];
        weights = [weights, abs(Wb)];
    end
end

% 3. 依赖约束边的添加 (无穷容量边)
INF = sum(abs(W_net)) + 1; % 确保 INF 大于所有正权值之和
[row, col] = find(dependency_matrix == 1);

for k = 1:length(row)
    b_dependent = row(k);   % 依赖方 A 
    b_prerequisite = col(k); % 被依赖方 B 
    
    % **关键修正：MWC 依赖边方向必须是 依赖方 A -> 被依赖方 B**
    u = [u, b_dependent];     % 起点 (u) 为依赖方 A
    v = [v, b_prerequisite];  % 终点 (v) 为被依赖方 B
    weights = [weights, INF];
end

% 4. 构建图对象 (Digraph Object)
all_nodes_ids = 1:T_node;
NodeNames = cellstr(num2str(all_nodes_ids')); 
G = digraph(u, v, weights, NodeNames);

% 5. 求解 MinCut/MaxFlow
try
    % 使用内置 maxflow
    [MaxFlowValue, ~, cs_ids, ~] = maxflow(G, S_node, T_node); 
catch ME
    error('HM_MWC_Solver:MaxFlowCallFailed', ...
          ['MaxFlow 函数调用失败。错误信息: %s'], ME.message);
end

% 6. 确定最大权值闭合子图 (MWC)
B_MWC = false(1, num_tiles); 
selected_tile_ids = cs_ids(cs_ids <= num_tiles);
B_MWC(selected_tile_ids) = true; 

% 7. 计算最大净效用
MaxUtility = TotalPositiveWeight - MaxFlowValue; 
end