/**
 * Chat-related Socket.IO event handlers.
 *
 * Events:
 *   chat:send  — user sends a message, agent streams reply via chat:chunk
 *   chat:stop  — user cancels an in-progress generation
 */

export function setupChatHandlers(io, socket, chatService) {
  socket.on('chat:send', async (data) => {
    const { message, history } = data || {}
    if (!message || !message.trim()) {
      socket.emit('chat:error', { message: '消息不能为空' })
      return
    }
    console.log(`[Chat] 收到消息 from ${socket.id}: ${message.slice(0, 80)}...`)
    await chatService.sendMessage(socket.id, message, history || [])
  })

  socket.on('chat:stop', () => {
    console.log(`[Chat] 停止生成 from ${socket.id}`)
    chatService.stopGeneration(socket.id)
  })
}
