---
name: probabilitydistribution-batch-processing
description: ProbabilityDistribution.m 修改为每 3 个 RSU 批次重置概率基数
metadata:
  type: feedback
---

**变更**: ProbabilityDistribution.m 的卷积循环中，每 3 个 RSU (BATCH_SIZE=3) 作为一个独立计算批次，批次内部从 1-hop → 2-hop → 3-hop 逐跳卷积，批次之间重新从 1-hop 开始。

**原因**: 用户要求 ProbabilityDistribution 的输入 E 根据车辆将要经过的 RSU 节点数计算——若超过 3 则 E=3，不足则用剩余数。即每 3 个 RSU 进行一次独立计算，避免长路径下概率过度扩散。

**如何应用**: 修改位于 ProbabilityDistribution.m 第 72-95 行——循环前段判断 `mod(r-1, BATCH_SIZE)==0` 时跳过卷积，直接使用 psi1（新批次起点）。调用方代码无需修改。

**相关**: 涉及 HM_Main_Complete.m、HM_Export_CacheDecision.m、HM_Sim_Main_Nanjing.m 等调用 ProbabilityDistribution 的入口文件。这些文件中的 E 参数含义不变，批次逻辑完全封装在函数内部。
