/**
 * ChatService — Bridges Node.js Socket.IO ↔ Python FastAPI ReAct Agent.
 *
 * Reads SSE (Server-Sent Events) from the Python agent and forwards each
 * text chunk to the frontend via Socket.IO.
 *
 * Environment:
 *   AGENT_URL — Python agent base URL (default: http://localhost:8000)
 */

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:8000'

export class ChatService {
  constructor(io) {
    this.io = io
    this.agentUrl = AGENT_URL
    /** Map<socketId, AbortController> — for cancelling in-flight requests */
    this.activeStreams = new Map()
  }

  /**
   * Send a user message to the Python agent and stream the response back
   * to the requesting socket via chat:chunk events.
   *
   * @param {string} socketId - requesting client's socket.id
   * @param {string} message - user's chat message
   * @param {Array<{role: string, content: string}>} [history=[]] - conversation history
   */
  async sendMessage(socketId, message, history = []) {
    // Abort any existing stream for this socket
    this.stopGeneration(socketId)

    const abortController = new AbortController()
    this.activeStreams.set(socketId, abortController)

    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    try {
      const response = await fetch(`${this.agentUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        this.io.to(socketId).emit('chat:error', {
          message: `Agent returned HTTP ${response.status}: ${errorText}`,
          messageId,
        })
        return
      }

      // Read SSE stream line-by-line
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last partial line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6) // remove "data: " prefix
          try {
            const payload = JSON.parse(jsonStr)
            this.io.to(socketId).emit('chat:chunk', {
              content: payload.content || '',
              done: payload.done || false,
              error: payload.error || false,
              messageId,
            })
          } catch (parseErr) {
            // Skip unparseable SSE lines (e.g. heartbeats)
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled — not an error
        console.log(`[ChatService] Stream aborted for socket ${socketId}`)
      } else {
        console.error(`[ChatService] Error for socket ${socketId}:`, err.message)
        this.io.to(socketId).emit('chat:error', {
          message: `连接 AI 助手失败: ${err.message}。请确保 Python Agent 已启动 (localhost:8000)。`,
          messageId,
        })
      }
    } finally {
      this.activeStreams.delete(socketId)
    }
  }

  /**
   * Cancel the active chat stream for a socket (e.g. user clicked "Stop").
   */
  stopGeneration(socketId) {
    const controller = this.activeStreams.get(socketId)
    if (controller) {
      controller.abort()
      this.activeStreams.delete(socketId)
    }
  }

  /**
   * Check if the Python agent is online.
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.agentUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
