/**
 * 服务注册表 - 跨模块共享服务实例
 */
let _cachingService = null
let _chatService = null

export function getCachingService() {
  return _cachingService
}

export function setCachingService(cs) {
  _cachingService = cs
}

export function getChatService() {
  return _chatService
}

export function setChatService(cs) {
  _chatService = cs
}
