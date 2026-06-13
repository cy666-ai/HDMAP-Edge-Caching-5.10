<template>
  <!-- FAB 浮动触发按钮 -->
  <el-button
    v-if="!drawerVisible"
    class="chat-fab"
    type="primary"
    :icon="ChatDotRound"
    size="large"
    round
    @click="openChat"
  >
    HLR-Cache助手
  </el-button>

  <!-- Element Plus Drawer -->
  <el-drawer
    v-model="drawerVisible"
    title="HLR-Cache助手"
    direction="ltr"
    size="420px"
    :close-on-click-modal="false"
    :append-to-body="true"
    @open="onDrawerOpen"
    @closed="onDrawerClose"
  >
    <div class="chat-container">
      <!-- 消息列表 -->
      <div class="chat-messages" ref="messagesRef">
        <div v-if="messages.length === 0 && !streaming" class="chat-placeholder">
          <el-icon :size="48" color="#c0c4cc"><Service /></el-icon>
          <p>您好！我是 HLR-Cache助手</p>
          <p class="hint">可以问我关于系统架构、MWC 算法、RSU 部署、缓存策略等问题</p>
        </div>

        <div
          v-for="(msg, idx) in messages"
          :key="idx"
          :class="['chat-msg', msg.role]"
        >
          <div class="msg-avatar">
            <el-icon v-if="msg.role === 'assistant'" :size="20" color="#409EFF">
              <Service />
            </el-icon>
            <el-icon v-else :size="20" color="#67c23a">
              <User />
            </el-icon>
          </div>
          <div class="msg-bubble">{{ msg.content }}</div>
        </div>

        <!-- 流式输出 / 思考中 -->
        <div v-if="streaming" class="chat-msg assistant">
          <div class="msg-avatar">
            <el-icon :size="20" color="#409EFF"><Service /></el-icon>
          </div>
          <div class="msg-bubble streaming" :class="{ thinking: !streamingContent }">
            <template v-if="streamingContent">
              {{ streamingContent }}<span class="cursor-blink">|</span>
            </template>
            <template v-else>
              思考中<span class="dot-anim">...</span>
            </template>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="chat-input-area">
        <div class="chat-input-row">
          <el-input
            v-model="inputText"
            placeholder="输入问题，按 Enter 发送..."
            :disabled="streaming"
            @keyup.enter="sendMessage"
            clearable
          />
          <el-button
            v-if="!streaming"
            type="primary"
            :disabled="!inputText.trim()"
            @click="sendMessage"
          >
            <el-icon><Promotion /></el-icon>
          </el-button>
          <el-button v-else type="danger" @click="stopGeneration">
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
        <p class="agent-status">
          <el-icon :size="12" :color="agentOnline === null ? '#e6a23c' : (agentOnline ? '#67c23a' : '#f56c6c')">
            <CircleCheck v-if="agentOnline === true" />
            <WarningFilled v-else-if="agentOnline === false" />
            <Loading v-else />
          </el-icon>
          AI 助手{{ agentOnline === null ? '检测中...' : (agentOnline ? '已连接' : '离线') }}
        </p>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import {
  ChatDotRound, Service, User, Promotion, Close, CircleCheck, WarningFilled, Loading,
} from '@element-plus/icons-vue'
import socketService from '../services/socket'

// ---- State ----
const drawerVisible = ref(false)
const inputText = ref('')
const messages = ref([])
const streamingContent = ref('')
const streaming = ref(false)
const messagesRef = ref(null)
const agentOnline = ref(null)  // null = checking, true = online, false = offline

let currentMessageId = null
let healthCheckTimer = null

// ---- Socket bindings ----
const socket = socketService.getSocket()

function bindSocket() {
  socket.off('chat:chunk')
  socket.off('chat:error')

  socket.on('chat:chunk', (payload) => {
    const { content, done, error } = payload

    if (error) {
      streaming.value = false
      messages.value.push({ role: 'assistant', content })
      return
    }

    if (done) {
      streaming.value = false
      if (streamingContent.value.trim()) {
        messages.value.push({ role: 'assistant', content: streamingContent.value })
      }
      streamingContent.value = ''
      currentMessageId = null
      return
    }

    streaming.value = true
    streamingContent.value += content
  })

  socket.on('chat:error', (payload) => {
    streaming.value = false
    streamingContent.value = ''
    currentMessageId = null
    messages.value.push({
      role: 'assistant',
      content: `⚠️ ${payload.message || '连接 AI 助手失败'}`,
    })
  })
}

// ---- Methods ----
function openChat() {
  drawerVisible.value = true
}

function onDrawerOpen() {
  // Check agent status immediately, then poll every 30s
  checkAgentStatus()
  healthCheckTimer = setInterval(checkAgentStatus, 30000)
  // Bind socket events
  bindSocket()
}

function onDrawerClose() {
  // Stop periodic health checks
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
}

function sendMessage() {
  const text = inputText.value.trim()
  if (!text || streaming.value) return

  messages.value.push({ role: 'user', content: text })
  inputText.value = ''

  // Show thinking indicator immediately
  streaming.value = true
  streamingContent.value = ''

  // Build history (last 10 turns)
  const history = messages.value.slice(-20).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  socket.emit('chat:send', { message: text, history })
}

function stopGeneration() {
  socket.emit('chat:stop')
  if (streamingContent.value.trim()) {
    messages.value.push({ role: 'assistant', content: streamingContent.value + ' [已停止]' })
  }
  streaming.value = false
  streamingContent.value = ''
  currentMessageId = null
}

async function checkAgentStatus() {
  try {
    const { protocol, hostname } = window.location
    const apiBase = hostname === 'localhost' || hostname === '127.0.0.1'
      ? `${protocol}//${hostname}:3000`
      : window.location.origin

    // Retry once on transient failures
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(`${apiBase}/api/chat/status`, {
          signal: AbortSignal.timeout(10000),
        })
        const data = await resp.json()
        agentOnline.value = data?.data?.online || false
        return
      } catch {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000))  // wait 2s before retry
        }
      }
    }
    agentOnline.value = false
  } catch {
    agentOnline.value = false
  }
}

// ---- Auto-scroll ----
watch([streamingContent, messages], async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
})

// ---- Cleanup ----
onBeforeUnmount(() => {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
})
</script>

<style scoped>
/* FAB button */
.chat-fab {
  position: fixed;
  bottom: 24px;
  left: 24px;
  z-index: 2000;
  min-width: 120px;
  height: 44px;
  font-size: 15px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.5);
  transition: transform 0.2s, box-shadow 0.2s;
}
.chat-fab:hover {
  transform: scale(1.06);
  box-shadow: 0 6px 20px rgba(64, 158, 255, 0.7);
}

/* Chat layout */
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 8px;
}

.chat-placeholder {
  text-align: center;
  padding: 60px 20px;
  color: #909399;
}
.chat-placeholder p {
  margin-top: 12px;
  font-size: 15px;
}
.chat-placeholder .hint {
  font-size: 13px;
  color: #c0c4cc;
}

/* Message bubbles */
.chat-msg {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.chat-msg.user {
  flex-direction: row-reverse;
}
.msg-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #f0f2f5;
}
.msg-bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}
.chat-msg.user .msg-bubble {
  background: #409eff;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.chat-msg.assistant .msg-bubble {
  background: #f0f2f5;
  color: #303133;
  border-bottom-left-radius: 4px;
}
.chat-msg.assistant .msg-bubble.streaming {
  border: 1px dashed #dcdfe6;
}

.cursor-blink {
  animation: blink 0.8s infinite;
  color: #409eff;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.msg-bubble.thinking {
  color: #909399;
  font-style: italic;
}
.dot-anim {
  animation: dotPulse 1.2s infinite;
}
@keyframes dotPulse {
  0%, 25% { opacity: 0.2; }
  50% { opacity: 1; }
  75%, 100% { opacity: 0.2; }
}

/* Input area */
.chat-input-area {
  border-top: 1px solid #ebeef5;
  padding: 12px;
}
.chat-input-row {
  display: flex;
  gap: 8px;
}
.chat-input-row .el-input {
  flex: 1;
}
.agent-status {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
