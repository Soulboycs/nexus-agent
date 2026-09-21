/**
 * 持久化去重守卫(会话级,跨 pane 共享):
 * 同一会话可能同时开在多个 pane(两个 ChatPane 实例各自的 persistedMessageIdsRef
 * 互不可见,导致同一条消息双写)。本模块按 sessionId 维护全局已持久化 id 集,
 * 实例装载历史时播种、成功 append 后登记;append 前原子Claim。
 */

const persisted = new Map<string, Set<string>>()

export function seedPersisted(sessionId: string, messageIds: string[]): void {
  let set = persisted.get(sessionId)
  if (!set) {
    set = new Set()
    persisted.set(sessionId, set)
  }
  for (const id of messageIds) set.add(id)
}

/** 原子认领:未持久化过 → 登记并返回 true(调用方执行 append) */
export function tryClaimPersist(sessionId: string, messageId: string): boolean {
  let set = persisted.get(sessionId)
  if (!set) {
    set = new Set()
    persisted.set(sessionId, set)
  }
  if (set.has(messageId)) return false
  set.add(messageId)
  return true
}

/** 测试/会话删除后清理 */
export function resetPersistGuard(sessionId?: string): void {
  if (sessionId) persisted.delete(sessionId)
  else persisted.clear()
}
