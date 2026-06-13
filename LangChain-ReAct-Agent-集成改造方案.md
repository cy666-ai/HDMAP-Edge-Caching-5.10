# LangChain ReAct Agent 聊天机器人集成改造方案

> **目标：** 将 LangChain-ReAct-Agent-main 改造并嵌入 HDMAP 边缘缓存可视化系统，在前端页面添加一个可通过浮动按钮唤起的聊天机器人小窗。

## Context

将 LangChain-ReAct-Agent-main 项目改造并嵌入 HDMAP 边缘缓存可视化系统，在前端页面添加一个可通过浮动按钮唤起的聊天机器人小窗。用户可通过该聊天机器人询问系统状态、缓存策略、RSU 部署、算法原理等问题，Agent 通过 ReAct（推理+行动）循环自主调用工具获取信息后回答。

**核心挑战：**
- LangChain Agent 是 Python Streamlit 独立应用，需解耦 UI 层并改造为后端服务
- Agent 的知识领域需从"扫地机器人客服"迁移到"HDMAP 边缘缓存系统助手"
- 需与现有的 Node.js + Socket.IO + Vue 3 架构无缝集成
- 需保持 Agent 的 7 工具 + 3 中间件 + RAG 核心架构不变

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (Vue 3 :5173)                │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Dashboard.vue                                       │ │
│  │  ┌──────────────────────┐  ┌──────────────────────┐ │ │
│  │  │   Map + Panels        │  │  ChatWidget.vue (新)  │ │ │
│  │  │   (existing)          │  │  ┌────────────────┐  │ │ │
│  │  │                       │  │  │ FAB 触发按钮    │  │ │ │
│  │  │                       │  │  │ el-drawer 抽屉  │  │ │ │
│  │  │                       │  │  │ 消息列表+输入框 │  │ │ │
│  │  │                       │  │  └────────────────┘  │ │ │
│  │  └──────────────────────┘  └──────────────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
│         │  Socket.IO (existing)                          │
│         │  + chat:send / chat:chunk / chat:stop          │
└─────────┼──────────────────────────────────────────────┘
          │
┌─────────┼──────────────────────────────────────────────┐
│         ▼           Backend (Node.js :3000)             │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  socket/index.js (modified)                          │ │
│  │  + chat:send → chatService.sendMessage()             │ │
│  │  + chat:stop  → chatService.stopGeneration()         │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                  │
│  ┌────────────────────▼────────────────────────────────┐ │
│  │  services/chatService.js (新)                        │ │
│  │  - HTTP 连接到 Python Agent (localhost:8000)         │ │
│  │  - SSE 流式读取 Agent 响应                          │ │
│  │  - 逐 chunk 通过 Socket.IO emit 到前端              │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │ HTTP POST /chat (SSE stream)      │
│  services/serviceRegistry.js (modified)                  │
│  + getChatService() / setChatService()                   │
└───────────────────────┼────────────────────────────────┘
                        │
┌───────────────────────┼────────────────────────────────┐
│                       ▼   Python Agent (:8000)           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  agent_server.py (新) — FastAPI 包装                 │ │
│  │  POST /chat  → SSE 流式响应                         │ │
│  │  GET  /health → 健康检查                            │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                  │
│  ┌────────────────────▼────────────────────────────────┐ │
│  │  agent/react_agent.py (改造)                         │ │
│  │  - 保留 create_agent() 核心                         │ │
│  │  - execute_stream() 不变                             │ │
│  │  - 改为可传入自定义 system_prompt                    │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                  │
│  ┌────────────────────▼────────────────────────────────┐ │
│  │  agent/tools/ (改造)                                 │ │
│  │  7 个工具全部重写，领域改为 HDMAP                     │ │
│  │  + RAG 知识库更换                                    │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**架构决策说明：**

选择 **Python Agent 作为持久化 FastAPI 微服务（选项 A）**，理由：
- 保留全部 7 个工具、3 个中间件、Chroma RAG、LangGraph ReAct 循环，约 80 行新代码（FastAPI 包装层） vs 数千行的 Node.js 重写
- SSE 流式传输原生支持 token-by-token 输出，前端体验好
- 进程独立，崩溃不拖垮 Node.js 后端
- 可独立开发、调试、扩展

弃用：
- 选项 B（每查询 spawn 子进程）：冷启动延迟 3-10 秒（加载模型连接+向量库），对话无状态
- 选项 C（LangChain.js 重写）：失去所有 Python 工具和中间件，LangChain.js 生态不如 Python

---

## 2. Backend (Node.js) 改动

### 2.1 新增文件

#### `simmap1.0/backend/src/services/chatService.js`

核心职责：桥接 Node.js Socket.IO ↔ Python FastAPI Agent。

```js
// 伪代码骨架
export class ChatService {
  constructor(io) {
    this.io = io
    this.agentUrl = process.env.AGENT_URL || 'http://localhost:8000'
    this.activeStreams = new Map() // socketId → AbortController
  }

  async sendMessage(socketId, message, conversationHistory) {
    // 1. 创建 AbortController 用于取消
    // 2. POST { message, history } 到 Python /chat (SSE)
    // 3. 逐行读取 SSE (data: {...})
    // 4. 每收到 chunk → io.to(socketId).emit('chat:chunk', { content, done })
    // 5. 完成后 emit chat:chunk { done: true }
  }

  stopGeneration(socketId) {
    // abort 对应的请求
  }

  async healthCheck() {
    // GET /health → boolean
  }
}
```

**关键实现细节：**
- 使用 Node.js 内置 `fetch`（Node 18+）进行 SSE 流式读取
- 通过 `AbortController` 支持用户中途取消生成
- 每次 `chat:chunk` 事件带 `{ content: string, done: boolean, messageId: string }`
- 错误时 emit `chat:error` 事件

#### `simmap1.0/backend/src/socket/chatHandlers.js`

将聊天相关的 Socket.IO 事件处理抽离为独立模块：

```js
export function setupChatHandlers(io, socket, chatService) {
  socket.on('chat:send', async (data) => {
    const { message, history } = data
    await chatService.sendMessage(socket.id, message, history)
  })

  socket.on('chat:stop', () => {
    chatService.stopGeneration(socket.id)
  })
}
```

### 2.2 修改文件

#### `simmap1.0/backend/src/socket/index.js`

**改动点：**
1. 导入 `ChatService` 和 `setupChatHandlers`
2. 在 `setupSocketHandlers()` 中实例化 `ChatService(io)`
3. 注册到 `serviceRegistry`
4. 在 `io.on('connection', ...)` 内调用 `setupChatHandlers(io, socket, chatService)`

```diff
+ import { ChatService } from '../services/chatService.js'
+ import { setChatService } from '../services/serviceRegistry.js'
+ import { setupChatHandlers } from './chatHandlers.js'

  export async function setupSocketHandlers(io) {
    ...
    cachingService = new CachingService(io, routeConfig)
    setCachingService(cachingService)

+   const chatService = new ChatService(io)
+   setChatService(chatService)

    io.on('connection', (socket) => {
      ...
+     setupChatHandlers(io, socket, chatService)
    })
  }
```

#### `simmap1.0/backend/src/services/serviceRegistry.js`

添加 ChatService 的 getter/setter：

```diff
  let _cachingService = null
+ let _chatService = null

  export function getCachingService() { return _cachingService }
  export function setCachingService(cs) { _cachingService = cs }

+ export function getChatService() { return _chatService }
+ export function setChatService(cs) { _chatService = cs }
```

#### `simmap1.0/backend/src/routes/api.js`

新增健康检查代理端点（可选）：

```js
// GET /api/chat/status — 检查 Python Agent 是否在线
router.get('/chat/status', async (req, res) => {
  try {
    const chatService = getChatService()
    const online = await chatService.healthCheck()
    res.json({ success: true, data: { online } })
  } catch (err) {
    res.json({ success: true, data: { online: false } })
  }
})
```

### 2.3 后端改动汇总

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/services/chatService.js` | **新增** | 核心桥接服务，HTTP SSE 流式读取 |
| `src/socket/chatHandlers.js` | **新增** | 聊天 Socket 事件处理 |
| `src/socket/index.js` | 修改 | 实例化 ChatService + 注册事件（约 +8 行） |
| `src/services/serviceRegistry.js` | 修改 | 添加 chatService getter/setter（约 +5 行） |
| `src/routes/api.js` | 修改 | 添加 `/api/chat/status`（可选，约 +12 行） |
| `package.json` | 无改动 | 无需新增 npm 依赖（使用内置 fetch） |

---

## 3. Python Agent 改动

### 3.1 新增文件

#### `LangChain-ReAct-Agent-main/agent_server.py`

FastAPI 包装层，替代原 Streamlit UI：

```python
# 伪代码骨架
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json

from agent.react_agent import ReactAgent

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)

agent = ReactAgent()

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []  # [{role, content}]

@app.post("/chat")
async def chat(req: ChatRequest):
    async def generate():
        for chunk in agent.execute_stream(req.message):
            yield f"data: {json.dumps({'content': chunk, 'done': False})}\n\n"
        yield f"data: {json.dumps({'content': '', 'done': True})}\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

### 3.2 需要改造的文件

#### `agent/react_agent.py`

改动：构造函数改为可注入 system_prompt（用于未来多场景切换）。

```diff
  class ReactAgent:
-     def __init__(self):
+     def __init__(self, system_prompt: str = None):
+         prompt = system_prompt or load_system_prompts()
          self.agent = create_agent(
              model=chat_model,
-             system_prompt=load_system_prompts(),
+             system_prompt=prompt,
              tools=[...],
              middleware=[...],
          )
```

#### `agent/tools/agent_tools.py`

**全部 7 个工具重写**，领域从扫地机器人 → HDMAP 边缘缓存系统。详见第 6 节。

#### `prompts/main_prompt.txt`

**完全重写**，系统提示词从"扫地机器人客服"→"HDMAP 边缘缓存系统助手"。详见第 6 节。

#### `prompts/report_prompt.txt`

**完全重写**，报告生成提示词从"扫地机器人使用报告"→"HDMAP 缓存系统分析报告"。详见第 6 节。

#### `prompts/rag_summarize.txt`

修改 RAG 汇总提示词，适配新知识库领域。

#### `data/` 目录

**删除** 扫地机器人相关文档：
- `扫地机器人100问.pdf`
- `扫地机器人100问2.txt`
- `扫拖一体机器人100问.txt`
- `故障排除.txt`
- `维护保养.txt`
- `选购指南.txt`
- `data/external/records.csv`

**新增** HDMAP 系统知识文档（需编写）：
- `HDMAP-系统概述.txt` — 系统架构、组件说明、数据流
- `HDMAP-缓存策略.txt` — MWC 算法原理、RSU 缓存机制、命中率计算
- `HDMAP-RSU部署.txt` — RSU 部署规则（500m 间距、250m 去重半径）、通信范围 300m
- `HDMAP-路由与车辆.txt` — 6 条固定路线、30 辆车、路线配置说明
- `HDMAP-算法详解.txt` — MWC 算法 7 阶段流水线、概率分布、容量优化
- `HDMAP-常见问题.txt` — 常见操作问题、参数说明、故障排查

#### `config/rag.yml`

```diff
- chat_model_name: qwen3-max
+ chat_model_name: qwen3-max  # 或改为 qwen-plus 节省成本
  embedding_model_name: text-embedding-v4
```

#### `config/agent.yml`

```diff
- external_data_path: data/external/records.csv
+ external_data_path: data/external/hdmap_stats.csv  # 新外部数据文件
```

### 3.3 不需要改动的文件

| 文件 | 原因 |
|---|---|
| `agent/tools/middleware.py` | 3 个中间件（monitor/log/prompt_switch）逻辑通用，域名无关 |
| `model/factory.py` | LLM 模型工厂保持不变（仍使用 DashScope Qwen） |
| `rag/rag_service.py` | RAG 汇总服务通用，更换知识库即可 |
| `rag/vector_store.py` | Chroma 向量存储通用，重新索引即可 |
| `utils/` 全部 5 个文件 | 工具函数（配置、文件、日志、路径、提示词加载）全部通用 |
| `config/chroma.yml` | 需修改知识库路径指向新文档（或保持不变，删除旧文档放入新文档） |
| `config/prompts.yml` | 提示词路径映射不变，替换文件内容即可 |
| `app.py` | Streamlit UI — **可保留**用于独立测试 Agent，或直接删除 |

### 3.4 Python 新增依赖

添加至 `requirements.txt`：

```
fastapi>=0.109.0
uvicorn[standard]>=0.27.0
sse-starlette>=1.8.0
httpx>=0.27.0          # Node.js 端若用 fetch 则不需要
```

### 3.5 Python 改动汇总

| 文件 | 操作 | 说明 |
|---|---|---|
| `agent_server.py` | **新增** | FastAPI 包装，SSE 流式端点 |
| `agent/react_agent.py` | 微调 | 构造函数支持自定义 prompt |
| `agent/tools/agent_tools.py` | **重写** | 7 个工具全部改为 HDMAP 领域 |
| `prompts/main_prompt.txt` | **重写** | 系统提示词改为 HDMAP 助手 |
| `prompts/report_prompt.txt` | **重写** | 报告提示词改为缓存分析报告 |
| `prompts/rag_summarize.txt` | 微调 | 适配新领域 |
| `data/` 目录 | 替换 | 删 6 旧文档 + 1 CSV，加 6 新文档 + 1 CSV |
| `config/agent.yml` | 微调 | 改外部数据路径 |
| `requirements.txt` | 修改 | 添加 fastapi、uvicorn、sse-starlette |

---

## 4. Frontend (Vue 3) 改动

### 4.1 新增文件

#### `simmap1.0/frontend/src/components/ChatWidget.vue`

核心聊天组件，采用 **FAB（浮动操作按钮）+ el-drawer 抽屉** 模式。

**组件结构：**

```vue
<template>
  <!-- FAB 浮动触发按钮 — 固定在右下角 -->
  <el-button
    class="chat-fab"
    type="primary"
    :icon="ChatDotRound"
    circle
    size="large"
    @click="openChat"
    v-if="!drawerVisible"
  />

  <!-- Element Plus Drawer 抽屉 — 从右侧滑出 -->
  <el-drawer
    v-model="drawerVisible"
    title="HDMAP 智能助手"
    direction="rtl"
    size="420px"
    :close-on-click-modal="false"
    :append-to-body="true"
  >
    <!-- 消息列表 -->
    <div class="chat-messages" ref="messagesContainer">
      <div v-for="(msg, idx) in messages" :key="idx"
           :class="['chat-msg', msg.role]">
        <div class="msg-avatar">
          <el-icon v-if="msg.role === 'assistant'" :size="20"><Service /></el-icon>
          <el-icon v-else :size="20"><User /></el-icon>
        </div>
        <div class="msg-content" v-text="msg.content" />
      </div>
      <!-- 流式输出中的消息 -->
      <div v-if="streaming" class="chat-msg assistant">
        <div class="msg-content">{{ streamingContent }}<span class="cursor-blink">|</span></div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="chat-input">
      <el-input v-model="inputText" placeholder="输入问题..."
                :disabled="streaming"
                @keyup.enter="sendMessage" />
      <el-button v-if="!streaming" type="primary"
                 :disabled="!inputText.trim()" @click="sendMessage">
        发送
      </el-button>
      <el-button v-else type="danger" @click="stopGeneration">
        停止
      </el-button>
    </div>
  </el-drawer>
</template>
```

**关键实现细节：**

1. **Socket 事件监听：**
   - `chat:chunk` — 收到流式文本片段，追加到 `streamingContent`，`done: true` 时固化到 `messages`
   - `chat:error` — 显示错误提示

2. **消息发送：**
   - `socket.emit('chat:send', { message, history })` — history 为最近 N 轮对话

3. **自动滚动：**
   - `watch` streamingContent 变化 → `nextTick` → 滚动到底部

4. **样式匹配：**
   - 使用 Element Plus 变量保持配色一致
   - FAB 位置：`position: fixed; bottom: 24px; right: 24px; z-index: 2000`
   - Drawer 内消息区 `flex: 1; overflow-y: auto`
   - 消息气泡使用与 `DataDisplay.vue` 相同的 card shadow 样式

### 4.2 修改文件

#### `simmap1.0/frontend/src/views/Dashboard.vue`

```diff
  <template>
    <div class="dashboard">
      ...
+     <!-- 聊天机器人 FAB + Drawer -->
+     <ChatWidget />
    </div>
  </template>

  <script setup>
  ...
+ import ChatWidget from '../components/ChatWidget.vue'
  </script>
```

**为什么放在 Dashboard 而非 App.vue：**
- Dashboard 已持有 Socket.IO 连接和监听器
- ChatWidget 需要与 socket 实例通信，Dashboard 是现有连接管理中心
- 符合现有组件组织模式

### 4.3 前端改动汇总

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/components/ChatWidget.vue` | **新增** | 聊天组件（~200 行） |
| `src/views/Dashboard.vue` | 修改 | 引入 ChatWidget（约 +2 行） |
| `package.json` | 无改动 | 无需新增 npm 依赖（Element Plus 已有 el-drawer） |

---

## 5. 配置与环境变量

### 5.1 环境变量（新增）

| 变量 | 位置 | 说明 | 默认值 |
|---|---|---|---|
| `DASHSCOPE_API_KEY` | Python Agent 环境 | 阿里 DashScope API 密钥（已有） | 必填 |
| `AGENT_URL` | Node.js 后端环境 | Python Agent 地址 | `http://localhost:8000` |
| `AGENT_PORT` | Python Agent 环境 | FastAPI 监听端口 | `8000` |

### 5.2 启动流程（改造后）

```bash
# 1. 启动 Python Agent
cd LangChain-ReAct-Agent-main
pip install -r requirements.txt
export DASHSCOPE_API_KEY="sk-xxx"
python agent_server.py          # → http://localhost:8000

# 2. 启动 Node.js 后端
cd simmap1.0/backend
npm run dev                     # → http://localhost:3000

# 3. 启动 Vue 前端
cd simmap1.0/frontend
npm run dev                     # → http://localhost:5173
```

---

## 6. Agent 文本修改清单（领域迁移）

这是改造工作中代码量最大、最需专业知识的环节。以下是每个工具和提示词的详细改造指南。

### 6.1 工具重写对照表

| # | 原工具 | 新工具 | 新 description | 入参 | 出参 |
|---|---|---|---|---|---|
| 1 | `rag_summarize` | `rag_summarize` | 从 HDMAP 知识库检索边缘缓存相关资料 | `query: str` | 字符串 |
| 2 | `get_weather` | `get_rsu_status` | 获取指定 RSU 的当前缓存状态和命中率 | `rsu_id: str` | JSON 字符串 |
| 3 | `get_user_location` | `get_active_routes` | 获取当前活跃路线列表及基本信息 | 无 | JSON 字符串 |
| 4 | `get_user_id` | `get_simulation_status` | 获取当前模拟运行状态（运行/暂停/停止） | 无 | 字符串 |
| 5 | `get_current_month` | `get_current_tick` | 获取当前模拟 tick 计数和时间戳 | 无 | 字符串 |
| 6 | `fetch_external_data` | `fetch_rsu_cache_detail` | 获取指定路线 RSU 的详细缓存决策和命中数据 | `route_id: str, rsu_index: str` | JSON 字符串 |
| 7 | `fill_context_for_report` | `fill_context_for_report` | 触发报告模式，注入缓存分析上下文 | 无 | 确认字符串 |

### 6.2 工具实现（改造后伪代码）

```python
# ============ 工具 1: RAG 检索 ============
@tool(description="从 HDMAP 知识库中检索边缘缓存、MWC算法、RSU部署等相关资料")
def rag_summarize(query: str) -> str:
    return rag.rag_summarize(query)

# ============ 工具 2: RSU 状态查询 ============
@tool(description="获取指定RSU的当前缓存状态、命中率、存储使用率，返回JSON格式字符串")
def get_rsu_status(rsu_id: str) -> str:
    # 通过 HTTP 调用 Node.js 后端 /api/rsu 获取实时数据
    return json.dumps({...})

# ============ 工具 3: 活跃路线 ============
@tool(description="获取当前模拟系统中的所有活跃路线列表及其基本信息，返回JSON格式")
def get_active_routes() -> str:
    # 调用 Node.js /api/roads
    return json.dumps({...})

# ============ 工具 4: 模拟状态 ============
@tool(description="获取当前模拟系统的运行状态：运行中/已暂停/已停止，以及运行时长")
def get_simulation_status() -> str:
    # 调用 Node.js /api/status
    return "运行中, 已运行 15 分钟, tick=120"

# ============ 工具 5: 当前 Tick ============
@tool(description="获取当前模拟tick计数和系统时间戳")
def get_current_tick() -> str:
    return f"当前tick: 120, 时间戳: {datetime.now().isoformat()}"

# ============ 工具 6: RSU 缓存详情 ============
@tool(description="获取指定路线指定RSU的详细缓存决策、命中率、net utility等完整数据")
def fetch_rsu_cache_detail(route_id: str, rsu_index: str) -> str:
    # 调用 Node.js /api/rsu 解析具体数据
    return json.dumps({...})

# ============ 工具 7: 报告上下文触发器（保持原有逻辑）============
@tool(description="触发中间件自动为缓存分析报告场景注入上下文，为后续提示词切换提供支撑")
def fill_context_for_report():
    return "fill_context_for_report已调用"
```

### 6.3 系统提示词（`main_prompt.txt`）改造

**原文本核心结构（保留）：**
1. 角色定义 — 扫地机器人客服
2. 核心思考准则（4 条 ReAct 规则）
3. 工具详细说明（7 个）
4. 输出规则

**改造后结构（保持，内容重写）：**

```
你是 HDMAP 分层高精地图边缘缓存可视化系统的专业智能助手，具备自主的ReAct思考与工具调用能力，
严格遵循「思考→行动→观察→再思考」的流程回答用户问题。

### 核心思考准则
1. 先判断用户的核心需求，分析当前已有信息是否足够直接回答...
2. 调用工具获取结果后，再次判断信息是否完整...
3. 工具调用入参必须与工具定义完全一致...
4. 【报告生成强约束】若用户需求为生成缓存分析报告，需严格遵循：
   获取模拟状态→获取活跃路线→调用fill_context_for_report→调用fetch_rsu_cache_detail 的固定流程...

### 可使用工具及能力边界
1. rag_summarize：从向量库检索 HDMAP 边缘缓存、MWC 算法、RSU 部署等相关专业资料...
2. get_rsu_status：获取指定 RSU 的当前缓存状态...
3. get_active_routes：获取当前活跃路线列表...
4. get_simulation_status：获取模拟运行状态...
5. get_current_tick：获取当前 tick 计数...
6. fetch_rsu_cache_detail：获取指定路线 RSU 的详细缓存数据...
7. fill_context_for_report：触发报告模式...

### 输出规则
1. 每次调用工具前输出自然语言思考过程...
2. 仅当信息足够时才生成最终回答，回答需贴合 HDMAP 边缘缓存场景...
```

### 6.4 报告提示词（`report_prompt.txt`）改造

从"扫地机器人月度使用报告"模板改为"HDMAP 缓存系统分析报告"模板。

### 6.5 知识库文档内容规划

需编写 6 个 TXT 文档 + 1 个外部数据 CSV：

| 文件名 | 内容要点 | 字数建议 |
|---|---|---|
| `HDMAP-系统概述.txt` | 系统架构、前后端技术栈、数据流、Socket.IO 事件 | 800-1200 |
| `HDMAP-缓存策略.txt` | MWC 算法原理、RSU 缓存容量(100 tiles)、命中率计算 | 1000-1500 |
| `HDMAP-RSU部署.txt` | RSU 500m 间距、250m 去重、300m 通信范围、Haversine 计算 | 600-1000 |
| `HDMAP-路由与车辆.txt` | 6 条南京鼓楼路线详情、30 辆车配置、速度等级 | 800-1000 |
| `HDMAP-算法详解.txt` | 7 阶段流水线、Poisson+Power-law 概率、BATCH_SIZE=3 | 1200-1800 |
| `HDMAP-常见问题.txt` | 启动失败、算法超时、RSU 不响应、前端白屏等 | 600-1000 |
| `data/external/hdmap_stats.csv` | 模拟统计数据（替代原 records.csv） | 50-100 行 |

---

## 7. 实施步骤（推荐顺序）

| 步骤 | 内容 | 预计时间 | 验证方式 |
|---|---|---|---|
| 1 | **Python Agent FastAPI 包装** — 创建 `agent_server.py`，验证 HTTP 调用 | 30 min | `curl -X POST localhost:8000/chat` |
| 2 | **工具 + 提示词重写** — 修改 7 个工具、3 个提示词文件，更换知识库 | 2-3 hr | 独立测试 Agent 回答质量 |
| 3 | **知识库构建** — 编写 6 个 TXT 文档，重新索引 Chroma | 1-2 hr | `rag_summarize` 返回相关内容 |
| 4 | **Node.js chatService** — 创建桥接服务，SSE 流式读取 | 1 hr | 单测：发送消息、接收流 |
| 5 | **Socket.IO 事件接入** — 修改 `socket/index.js` + `serviceRegistry` | 20 min | Socket 事件日志确认 |
| 6 | **ChatWidget.vue 组件** — 开发聊天 UI，接入 Socket 事件 | 1-2 hr | 前端聊天功能完整可用 |
| 7 | **集成测试** — 全链路联调 FAB 点击→Agent 响应→流式显示 | 30 min | 端到端聊天正常 |
| 8 | **样式调优** — 确保与现有 UI 风格一致 | 30 min | 视觉走查 |

**总计预估：** 6-10 小时

---

## 8. 验证方案

### 8.1 Python Agent 独立验证

```bash
cd LangChain-ReAct-Agent-main
python agent_server.py &
# 测试健康检查
curl http://localhost:8000/health
# 测试聊天
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "介绍一下MWC算法", "history": []}'
# 预期：SSE 流式返回 ReAct 思考过程 + 最终回答
```

### 8.2 Node.js 桥接验证

```bash
cd simmap1.0/backend
npm run dev
# 使用 Socket.IO 测试客户端发送 chat:send 事件
# 预期：chat:chunk 事件逐条返回
```

### 8.3 前端集成验证

```bash
cd simmap1.0/frontend
npm run dev
# 浏览器打开 http://localhost:5173
# 1. 检查右下角 FAB 按钮
# 2. 点击打开聊天抽屉
# 3. 输入问题发送
# 4. 验证流式回答逐字显示
# 5. 验证 "停止" 按钮中断生成
# 6. 验证错误处理（关掉 Python Agent 后发送消息）
```

### 8.4 回归验证

- 现有模拟系统功能不受影响（Start/Pause/Reset/Route CRUD）
- Socket.IO 事件无冲突（新增 `chat:*` 事件不干扰现有 `vehicle:*` / `rsu:*` / `simulation:*`）
- REST API 正常响应
- 前端布局不错乱（ChatWidget 为独立浮层，不影响现有布局）

---

## 附录 A：可选增强项

以下功能不在本次改造范围内，但架构已为此预留扩展空间：

1. **LLM 提供商切换** — `model/factory.py` 已使用工厂模式，切换 OpenAI/Claude 只需新增工厂类
2. **多用户会话隔离** — ChatWidget 传入 `socket.id` 作为会话标识，chatService 已按 socketId 管理流
3. **对话历史持久化** — 可在 chatService 中添加 SQLite 存储（复用现有 Sequelize）
4. **Agent 工具访问实时数据** — 工具函数可通过 HTTP 调用 Node.js `/api/*` 端点获取系统实时状态
5. **工具权限控制** — 可为不同用户角色提供不同工具集

---

## 附录 B：文件改动速查表

```
新增文件（6个）:
├── simmap1.0/backend/src/services/chatService.js      # 核心桥接
├── simmap1.0/backend/src/socket/chatHandlers.js        # 聊天事件
├── simmap1.0/frontend/src/components/ChatWidget.vue    # 聊天UI
├── LangChain-ReAct-Agent-main/agent_server.py          # FastAPI包装
├── LangChain-ReAct-Agent-main/data/HDMAP-*.txt (×6)    # 新知识库
└── LangChain-ReAct-Agent-main/data/external/hdmap_stats.csv

修改文件（10个）:
├── simmap1.0/backend/src/socket/index.js               # +8行
├── simmap1.0/backend/src/services/serviceRegistry.js   # +5行
├── simmap1.0/backend/src/routes/api.js                 # +12行（可选）
├── simmap1.0/frontend/src/views/Dashboard.vue          # +2行
├── LangChain-ReAct-Agent-main/agent/react_agent.py     # 微调
├── LangChain-ReAct-Agent-main/agent/tools/agent_tools.py  # 重写
├── LangChain-ReAct-Agent-main/prompts/main_prompt.txt  # 重写
├── LangChain-ReAct-Agent-main/prompts/report_prompt.txt # 重写
├── LangChain-ReAct-Agent-main/config/agent.yml         # 微调
└── LangChain-ReAct-Agent-main/requirements.txt         # 加依赖

删除文件（7个）:
├── LangChain-ReAct-Agent-main/data/扫地机器人100问.pdf
├── LangChain-ReAct-Agent-main/data/扫地机器人100问2.txt
├── LangChain-ReAct-Agent-main/data/扫拖一体机器人100问.txt
├── LangChain-ReAct-Agent-main/data/故障排除.txt
├── LangChain-ReAct-Agent-main/data/维护保养.txt
├── LangChain-ReAct-Agent-main/data/选购指南.txt
└── LangChain-ReAct-Agent-main/data/external/records.csv
```
