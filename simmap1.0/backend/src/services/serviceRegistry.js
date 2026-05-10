/**
 * 服务注册表 - 跨模块共享服务实例
 */
let _cachingService = null

export function getCachingService() {
  return _cachingService
}

export function setCachingService(cs) {
  _cachingService = cs
}
