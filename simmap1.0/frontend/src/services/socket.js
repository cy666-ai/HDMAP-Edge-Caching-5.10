import { io } from 'socket.io-client'

const SOCKET_URL = 'http://localhost:3000'

class SocketService {
  constructor() {
    this.socket = null
    this.listeners = {}
  }

  connect() {
    if (this.socket?.connected) return

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling']
    })

    this.socket.on('connect', () => {
      console.log('[Socket] 已连接:', this.socket.id)
    })

    this.socket.on('disconnect', () => {
      console.log('[Socket] 已断开')
    })

    this.socket.on('connect_error', (err) => {
      console.error('[Socket] 连接错误:', err.message)
    })

    // 重新绑定已有监听器
    Object.entries(this.listeners).forEach(([event, fn]) => {
      this.socket?.off(event)
      this.socket?.on(event, fn)
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  on(event, callback) {
    this.listeners[event] = callback
    this.socket?.off(event)
    this.socket?.on(event, callback)
  }

  off(event) {
    delete this.listeners[event]
    this.socket?.off(event)
  }

  emit(event, data) {
    this.socket?.emit(event, data)
  }

  /** Returns the raw socket instance for advanced use (e.g. multi-listener events) */
  getSocket() {
    if (!this.socket) {
      this.connect()
    }
    return this.socket
  }
}

export default new SocketService()
