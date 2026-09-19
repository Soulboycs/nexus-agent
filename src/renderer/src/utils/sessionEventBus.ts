import type { AgentEvent } from '@shared/types'

export interface OutboundAgentEvent {
  sessionId: string
  seq: number
  event: AgentEvent
}

type Listener = (event: AgentEvent) => void

/**
 * 渲染进程按会话分发事件总线(计划 §8.1,S6)。
 *
 * 多 pane 流式隔离的核心机制:主进程批量通道(单订阅)→ 本总线按 sessionId
 * 精确投递到各 pane 自己的 useReducer。A 会话的 delta 永远不触发 B 的渲染。
 *
 * seq 语义(§7.3 v1):主进程合帧器保证同会话 seq 单调无洞;
 * 这里只做廉价保险——重复 seq(乱序旧包)丢弃、断档 console.warn 告警,投递不中断。
 */
export class SessionEventBus {
  private listeners = new Map<string, Set<Listener>>()
  private lastSeqBySession = new Map<string, number>()

  /** 摄入主进程批量通道;单监听者抛错不影响同批其他投递 */
  ingestBatch(batch: OutboundAgentEvent[]): void {
    for (const { sessionId, seq, event } of batch) {
      const set = this.listeners.get(sessionId)
      if (!set || set.size === 0) continue
      const last = this.lastSeqBySession.get(sessionId) ?? 0
      if (seq <= last) continue // 乱序旧包/重复,丢弃
      if (seq > last + 1) {
        console.warn(
          `[SessionEventBus] seq gap for session ${sessionId}: expected ${last + 1}, got ${seq} (stream may be degraded)`
        )
      }
      this.lastSeqBySession.set(sessionId, seq)
      for (const fn of [...set]) {
        try {
          fn(event)
        } catch (err) {
          console.error(`[SessionEventBus] listener error for session ${sessionId}:`, err)
        }
      }
    }
  }

  /** 订阅某会话的事件流;返回退订函数(最后一个退订清理会话条目) */
  subscribe(sessionId: string, fn: Listener): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(fn)
    return () => {
      const s = this.listeners.get(sessionId)
      if (!s) return
      s.delete(fn)
      if (s.size === 0) this.listeners.delete(sessionId)
    }
  }

  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
  }

  sessionCount(): number {
    return this.listeners.size
  }
}

/** App 单例:挂载一次 onAgentEventBatch → ingestBatch,各 pane 经 useSessionChat 使用 */
export const sessionEventBus = new SessionEventBus()
