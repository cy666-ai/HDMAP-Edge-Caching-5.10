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

  <!-- Element Plus Drawer （可拖拽调整宽度） -->
  <el-drawer
    v-model="drawerVisible"
    direction="ltr"
    :size="drawerWidth + 'px'"
    :close-on-click-modal="false"
    :append-to-body="true"
    @open="onDrawerOpen"
    @closed="onDrawerClose"
  >
    <template #title>
      <div class="drawer-title-bar">
        <span v-if="showHistory">📋 历史记录</span>
        <span v-else>HLR-Cache助手</span>
        <div class="title-actions">
          <el-button
            v-if="!showHistory"
            size="small"
            text
            :icon="Plus"
            @click="newConversation"
          >新对话</el-button>
          <el-button
            size="small"
            text
            @click="toggleHistory"
          >
            {{ showHistory ? '← 返回' : '历史' }}
          </el-button>
        </div>
      </div>
    </template>

    <!-- 历史记录面板 -->
    <div v-if="showHistory" class="history-panel">
      <div v-if="conversations.length === 0" class="history-empty">
        <el-icon :size="40" color="#c0c4cc"><ChatLineSquare /></el-icon>
        <p>暂无历史对话</p>
      </div>
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="history-item"
        :class="{ active: conv.id === activeConversationId }"
        @click="switchConversation(conv.id)"
      >
        <div class="history-item-main">
          <div class="history-title">{{ conv.title }}</div>
          <div class="history-meta">
            <span>{{ conv.messageCount }} 条消息</span>
            <span>·</span>
            <span>{{ formatConvTime(conv.updatedAt) }}</span>
          </div>
        </div>
        <el-button
          size="small"
          text
          type="danger"
          :icon="Delete"
          @click.stop="deleteConversation(conv.id)"
        />
      </div>
    </div>

    <!-- 聊天面板 -->
    <div v-else class="chat-container">
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

    <!-- 拖拽调整宽度的手柄（右边缘） -->
    <div
      class="resize-handle"
      @mousedown="onResizeStart"
    ></div>
  </el-drawer>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import {
  ChatDotRound, Service, User, Promotion, Close, CircleCheck, WarningFilled, Loading,
  Plus, ChatLineSquare, Delete,
} from '@element-plus/icons-vue'
import socketService from '../services/socket'

// ==================== 常量 ====================
const DRAWER_WIDTH_KEY = 'hlr_cache_drawer_width'
const CONVERSATIONS_KEY = 'hlr_cache_conversations'
const ACTIVE_CONV_KEY = 'hlr_cache_active_conv'
const MIN_WIDTH = 320
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 420

// ==================== 状态 ====================
const drawerVisible = ref(false)
const inputText = ref('')
const messages = ref([])
const streamingContent = ref('')
const streaming = ref(false)
const messagesRef = ref(null)
const agentOnline = ref(null)
const showHistory = ref(false)

// 拖拽相关
const drawerWidth = ref(Number(localStorage.getItem(DRAWER_WIDTH_KEY)) || DEFAULT_WIDTH)
let isResizing = false

// 对话历史
const conversations = ref([])
const activeConversationId = ref(null)

let currentMessageId = null
let healthCheckTimer = null
let saveTimer = null

// ==================== 对话持久化 ====================
function generateId() {
  return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function loadConversations() {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY)
    conversations.value = raw ? JSON.parse(raw) : []
  } catch {
    conversations.value = []
  }
}

function persistConversations() {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations.value))
  } catch (e) {
    // localStorage 满或不可用
    console.warn('[ChatWidget] Failed to persist conversations:', e)
  }
}

function saveCurrentConversation() {
  if (!activeConversationId.value || messages.value.length === 0) return
  const idx = conversations.value.findIndex(c => c.id === activeConversationId.value)
  if (idx === -1) return

  const conv = conversations.value[idx]
  conv.messages = messages.value.map(m => ({ role: m.role, content: m.content }))
  conv.messageCount = messages.value.length
  conv.updatedAt = Date.now()

  // 用第一条用户消息作为标题
  if (conv.title === '新对话') {
    const firstUser = messages.value.find(m => m.role === 'user')
    if (firstUser) {
      const text = firstUser.content.trim()
      conv.title = text.length > 30 ? text.slice(0, 30) + '…' : text
    }
  }

  persistConversations()
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveCurrentConversation()
  }, 500)
}

function newConversation() {
  // 保存当前对话
  saveCurrentConversation()
  showHistory.value = false

  // 创建新对话
  const id = generateId()
  activeConversationId.value = id
  messages.value = []
  streamingContent.value = ''
  streaming.value = false

  conversations.value.unshift({
    id,
    title: '新对话',
    messages: [],
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  persistConversations()
  localStorage.setItem(ACTIVE_CONV_KEY, id)
}

function switchConversation(id) {
  if (id === activeConversationId.value && !showHistory.value) return
  saveCurrentConversation()

  const conv = conversations.value.find(c => c.id === id)
  if (!conv) return

  activeConversationId.value = id
  messages.value = (conv.messages || []).map(m => ({ ...m }))
  streamingContent.value = ''
  streaming.value = false
  showHistory.value = false
  localStorage.setItem(ACTIVE_CONV_KEY, id)
}

function deleteConversation(id) {
  const idx = conversations.value.findIndex(c => c.id === id)
  if (idx === -1) return
  conversations.value.splice(idx, 1)
  persistConversations()

  // 如果删的是当前对话，切换到最新对话或新建
  if (id === activeConversationId.value) {
    if (conversations.value.length > 0) {
      switchConversation(conversations.value[0].id)
    } else {
      newConversation()
    }
  }
}

function toggleHistory() {
  if (showHistory.value) {
    showHistory.value = false
  } else {
    saveCurrentConversation()
    showHistory.value = true
  }
}

function formatConvTime(ts) {
  if (!ts) return ''
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ==================== 拖拽调整宽度 ====================
function onResizeStart(e) {
  isResizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'ew-resize'
  e.preventDefault()
}

function onResizeMove(e) {
  if (!isResizing) return
  const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX))
  drawerWidth.value = w
}

function onResizeEnd() {
  isResizing = false
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  localStorage.setItem(DRAWER_WIDTH_KEY, drawerWidth.value)
}

// ==================== Socket ====================
const socket = socketService.getSocket()

function bindSocket() {
  socket.off('chat:chunk')
  socket.off('chat:error')

  socket.on('chat:chunk', (payload) => {
    const { content, done, error } = payload

    if (error) {
      streaming.value = false
      messages.value.push({ role: 'assistant', content })
      scheduleSave()
      return
    }

    if (done) {
      streaming.value = false
      if (streamingContent.value.trim()) {
        messages.value.push({ role: 'assistant', content: streamingContent.value })
      }
      streamingContent.value = ''
      currentMessageId = null
      scheduleSave()
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
    scheduleSave()
  })
}

// ==================== 方法 ====================
function openChat() {
  drawerVisible.value = true
}

function onDrawerOpen() {
  checkAgentStatus()
  healthCheckTimer = setInterval(checkAgentStatus, 30000)
  bindSocket()
}

function onDrawerClose() {
  saveCurrentConversation()
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
  scheduleSave()

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
  scheduleSave()
}

async function checkAgentStatus() {
  try {
    const { protocol, hostname } = window.location
    const apiBase = hostname === 'localhost' || hostname === '127.0.0.1'
      ? `${protocol}//${hostname}:3000`
      : window.location.origin

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
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
    agentOnline.value = false
  } catch {
    agentOnline.value = false
  }
}

// ==================== 自动滚动 ====================
watch([streamingContent, messages], async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
})

// ==================== 初始化 ====================
loadConversations()
const savedActiveId = localStorage.getItem(ACTIVE_CONV_KEY)
if (savedActiveId && conversations.value.find(c => c.id === savedActiveId)) {
  activeConversationId.value = savedActiveId
  const conv = conversations.value.find(c => c.id === savedActiveId)
  messages.value = (conv.messages || []).map(m => ({ ...m }))
} else if (conversations.value.length > 0) {
  activeConversationId.value = conversations.value[0].id
  messages.value = (conversations.value[0].messages || []).map(m => ({ ...m }))
} else {
  // 创建首个对话
  const id = generateId()
  activeConversationId.value = id
  conversations.value.push({
    id,
    title: '新对话',
    messages: [],
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  persistConversations()
  localStorage.setItem(ACTIVE_CONV_KEY, id)
}

// ==================== 清理 ====================
onBeforeUnmount(() => {
  saveCurrentConversation()
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
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

/* 标题栏 */
.drawer-title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.title-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

/* 拖拽手柄 */
.resize-handle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 80px;
  cursor: ew-resize;
  z-index: 10;
  border-radius: 3px 0 0 3px;
  background: #dcdfe6;
  opacity: 0;
  transition: opacity 0.25s, background 0.2s;
}
:deep(.el-drawer:hover) .resize-handle,
:deep(.el-drawer__body:hover) .resize-handle,
.resize-handle:hover {
  opacity: 0.7;
}
.resize-handle:hover {
  opacity: 1 !important;
  background: #409eff;
}

/* 历史记录面板 */
.history-panel {
  height: 100%;
  overflow-y: auto;
  padding: 4px 0;
}
.history-empty {
  text-align: center;
  padding: 60px 20px;
  color: #c0c4cc;
}
.history-empty p {
  margin-top: 12px;
  font-size: 13px;
}
.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  margin: 2px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.history-item:hover {
  background: #f0f2f5;
}
.history-item.active {
  background: #ecf5ff;
}
.history-item-main {
  flex: 1;
  min-width: 0;
  margin-right: 8px;
}
.history-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-meta {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  display: flex;
  gap: 6px;
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
