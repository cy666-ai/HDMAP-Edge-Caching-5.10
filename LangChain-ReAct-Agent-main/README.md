# 🤖 HDMAP ReAct Agent — HLR-Cache 智能助手

## 项目概述

面向自动驾驶的高精地图边缘缓存可视化系统（HDMAP Edge Caching System）的 **ReAct 智能助手**。基于 LangGraph ReAct Agent 框架，集成 Chroma 向量知识库检索、7 个 HDMAP 领域工具调用和动态提示词切换，支持对系统架构、MWC 算法、RSU 部署、缓存策略等问题的智能问答，以及缓存分析报告自动生成。

Agent 通过 FastAPI SSE 流式端点对外服务，经 Node.js Socket.IO 桥接层推送至 Vue 3 前端聊天组件。

## 核心特性

#### 1. ReAct Agent 多工具调用
- 集成 RAG 检索、RSU 状态查询、活跃路线、模拟状态、缓存详情等 7 个 HDMAP 领域工具
- Agent 自主遵循"思考→行动→观察→再思考"的 ReAct 循环调用工具完成推理

#### 2. RAG 检索增强问答
- 基于 Chroma 向量数据库 + text-embedding-v4 构建 HDMAP 知识库
- 6 个 TXT 知识文档覆盖系统概述、缓存策略、RSU 部署、路由与车辆、算法详解、常见问题

#### 3. 动态提示词切换
- 普通问答模式与报告生成模式之间自动切换
- 报告模式下按固定流程：获取状态→获取路线→触发上下文→获取缓存详情→生成报告

#### 4. SSE 流式输出
- FastAPI `/chat` 端点提供 token 级 SSE 流式响应
- 经 Node.js `chatService` 桥接 → Socket.IO → Vue 前端逐字显示
- 异步线程池隔离，LLM 阻塞调用不影响健康检查

#### 5. 模块化工程结构
- 项目按 Agent、RAG、模型层、配置层、工具层等模块拆分，便于维护和扩展

---

## 项目结构

```bash
.
├── agent/                       # Agent 核心逻辑
│   ├── react_agent.py           # ReAct 智能体主逻辑（流式输出、异步桥接）
│   └── tools/
│       ├── agent_tools.py       # 7 个 HDMAP 领域工具
│       └── middleware.py        # 中间件：工具日志、提示词动态切换
├── config/                      # YAML 配置文件
│   ├── agent.yml                # Agent 行为与外部数据路径
│   ├── chroma.yml               # 向量库配置（分块大小、检索 top_k）
│   ├── prompts.yml              # 提示词路径映射
│   └── rag.yml                  # 模型配置（chat_model / embedding_model）
├── data/                        # 知识库文档与外部数据
│   ├── HDMAP-系统概述.txt
│   ├── HDMAP-缓存策略.txt
│   ├── HDMAP-RSU部署.txt
│   ├── HDMAP-路由与车辆.txt
│   ├── HDMAP-算法详解.txt
│   ├── HDMAP-常见问题.txt
│   ├── HDMAP-前端界面.txt
│   └── external/
│       └── hdmap_stats.csv
├── model/                       # 模型工厂
│   └── factory.py               # DashScope Qwen 模型初始化
├── prompts/                     # 提示词模板
│   ├── main_prompt.txt          # 系统提示词（HLR-Cache 助手角色定义）
│   ├── report_prompt.txt        # 报告生成专属提示词
│   └── rag_summarize.txt        # RAG 汇总提示词
├── rag/                         # 检索增强模块
│   ├── rag_service.py           # RAG 总结服务链
│   └── vector_store.py          # Chroma 向量存储（文档加载、MD5 去重）
├── utils/                       # 通用工具
│   ├── config_handler.py        # YAML 配置加载
│   ├── file_handler.py          # PDF/TXT 文件读取
│   ├── logger_handler.py        # 日志管理
│   ├── path_tool.py             # 路径工具
│   └── prompt_loader.py         # 提示词加载
├── agent_server.py              # FastAPI 服务入口（SSE 端点 + 健康检查）
├── requirements.txt
└── README.md
```

---

## 架构与集成

```
Vue 3 前端 (:5173)               Node.js 后端 (:3000)            Python Agent (:8000)
┌──────────────────┐    Socket.IO    ┌───────────────────┐   HTTP/SSE   ┌─────────────────┐
│  ChatWidget.vue  │ ←─────────────→ │  chatService.js    │ ←──────────→ │ agent_server.py │
│  "HLR-Cache助手" │   chat:send     │  SSE 流式读取      │  POST /chat  │ react_agent.py  │
│                  │   chat:chunk    │  AbortController   │  GET /health │ 7 tools + RAG  │
└──────────────────┘                 └───────────────────┘              └─────────────────┘
```

---

## 快速开始

### 环境要求
- Python 3.10+
- Node.js 18+
- 阿里云百炼 API Key（DashScope）
- 已启动的 HDMAP Node.js 后端（可选，Agent 可独立运行）

### 安装

```bash
cd LangChain-ReAct-Agent-main
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 配置环境变量

```bash
export DASHSCOPE_API_KEY="your-api-key"
# 可选：连接到 HDMAP 后端获取实时数据
export AGENT_BACKEND_URL="http://localhost:3000"
# 可选：自定义端口
export AGENT_PORT=8000
```

### 启动 Agent 服务

```bash
python agent_server.py
# → FastAPI 服务运行在 http://0.0.0.0:8000
# → POST /chat — SSE 流式聊天
# → GET /health — 健康检查
```

### 验证

```bash
# 健康检查
curl http://localhost:8000/health

# 聊天测试
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "介绍一下MWC算法", "history": []}'
```

---

## 支持的任务类型

- **知识库问答**：检索 HDMAP 文档回答系统架构、算法原理、配置参数等问题
- **实时数据查询**：通过工具获取 RSU 状态、路线信息、模拟运行状态
- **缓存分析报告**：自动按流程生成包含命中率、缓存利用率、负载均衡的完整报告
- **前端界面解答**：回答页面布局、按钮功能、图表含义等 UI 相关问题

---

## 工具清单

| # | 工具名 | 功能 |
|---|--------|------|
| 1 | `rag_summarize` | 从 HDMAP 知识库检索相关资料 |
| 2 | `get_rsu_status` | 获取指定 RSU 的缓存状态和命中率 |
| 3 | `get_active_routes` | 获取当前活跃路线列表 |
| 4 | `get_simulation_status` | 获取模拟运行状态 |
| 5 | `get_current_tick` | 获取当前 tick 计数 |
| 6 | `fetch_rsu_cache_detail` | 获取 RSU 详细缓存决策数据 |
| 7 | `fill_context_for_report` | 触发报告模式上下文切换 |

---

## 配置说明

首次运行时检查以下配置文件：

- `config/rag.yml` — 模型选择（默认 `qwen-turbo`，embedding `text-embedding-v4`）
- `config/chroma.yml` — 向量库参数（collection、chunk_size、top_k）
- `config/agent.yml` — 外部数据路径
- `config/prompts.yml` — 提示词路径映射

---

## 新增知识库文档

在 `data/` 目录放入 `.txt` 或 `.pdf` 文件，重启 Agent 后自动加载并索引到 Chroma。
MD5 去重机制确保同一文件不会重复索引。

---

### ⭐ 鸣谢

本项目基于 [LangChain-ReAct-Agent](https://github.com/lhh737/LangChain-ReAct-Agent) 改造，将原扫地机器人客服场景迁移为 HDMAP 边缘缓存系统智能助手。
