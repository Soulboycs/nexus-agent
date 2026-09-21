import type { AgentEvent } from '../../shared/types'

export interface OutboundAgentEvent {
  sessionId: string
  seq: number
  event: AgentEvent
}

export interface DeltaCoalescerOptions {
  onBatch: (batch: OutboundAgentEvent[]) => void
  /** 主进程合帧周期,默认 33ms(约 30 批/s) */
  flushIntervalMs?: number
}

/** 可拼接合并的通道白名单;白名单外一切事件按结构化事件(fail-closed)处理。
 * 谓词形式(而非 Set)让 TS 把 event 整体窄化为可合并事件。 */
type Channel = 'thinking_delta' | 'message_delta' | 'terminal_output'
type CoalescableEvent = Extract<AgentEvent, { type: Channel }>

function isCoalescableEvent(ev: AgentEvent): ev is CoalescableEvent {
  return ev.type === 'thinking_delta' || ev.type === 'message_delta' || ev.type === 'terminal_output'
}

interface PendingDelta {
  channel: Channel
  text: string
  lastSourceSeq: number
}

interface SessionBucket {
  seq: number
  pending: PendingDelta[]
}

/**
 * 主进程 delta 合帧器(计划 §7.3)。
 *
 * - 合并键 = (sessionId, 通道):相邻同通道文本拼接为一个增量 delta,
 *   chatReducer 的增量追加语义保持零改动。
 * - 结构化事件是顺序屏障:透传前必须先 flush 该会话的积压文本,
 *   否则 thinking→text 相位切换会造出错序 block(reducer 永远追加到最后一个同型 block)。
 * - seq 挂信封层,按源事件分配;合并包 seq = 最后一个被合并源事件的 seq。
 * - 全局单定时器批量出站;屏障触发的即时出站与定时出站共用同一条 batch 通道。
 */
export class DeltaCoalescer {
  private readonly onBatch: DeltaCoalescerOptions['onBatch']
  private readonly flushIntervalMs: number
  private readonly buckets = new Map<string, SessionBucket>()
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(options: DeltaCoalescerOptions) {
    this.onBatch = options.onBatch
    this.flushIntervalMs = options.flushIntervalMs ?? 33
  }

  ingest(sessionId: string, event: AgentEvent): void {
    if (isCoalescableEvent(event)) {
      const text = event.type === 'terminal_output' ? event.chunk : event.delta
      if (!text) return // 空文本丢弃(A8)
      const bucket = this.bucketFor(sessionId)
      const last = bucket.pending[bucket.pending.length - 1]
      const sourceSeq = ++bucket.seq
      if (last && last.channel === event.type) {
        last.text += text
        last.lastSourceSeq = sourceSeq
      } else {
        bucket.pending.push({ channel: event.type, text, lastSourceSeq: sourceSeq })
      }
      this.ensureTimer()
      return
    }
    // 顺序屏障:先 flush 本会话积压,再透传结构化事件
    const flushed = this.takePending(sessionId)
    const out: OutboundAgentEvent[] = flushed
    const bucket = this.bucketFor(sessionId)
    out.push({ sessionId, seq: ++bucket.seq, event })
    this.onBatch(out)
  }

  /** 同步清空所有会话的积压桶,一次性批量出站;空批不调用 onBatch */
  flushAll(): void {
    const batch: OutboundAgentEvent[] = []
    for (const sessionId of [...this.buckets.keys()]) {
      batch.push(...this.takePending(sessionId))
    }
    if (batch.length) this.onBatch(batch)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureTimer(): void {
    // dispose 后禁止复活定时器:引擎监听器在 dispose 后仍可能 ingest
    if (this.timer === null && !this.disposed) {
      this.timer = setInterval(() => this.flushAll(), this.flushIntervalMs)
    }
  }

  private bucketFor(sessionId: string): SessionBucket {
    let b = this.buckets.get(sessionId)
    if (!b) {
      b = { seq: 0, pending: [] }
      this.buckets.set(sessionId, b)
    }
    return b
  }

  /** 取出并清空一个会话的积压文本,转为出站事件 */
  private takePending(sessionId: string): OutboundAgentEvent[] {
    const bucket = this.buckets.get(sessionId)
    if (!bucket || bucket.pending.length === 0) return []
    const out: OutboundAgentEvent[] = bucket.pending.map((p) => ({
      sessionId,
      seq: p.lastSourceSeq,
      event:
        p.channel === 'terminal_output'
          ? { type: 'terminal_output', chunk: p.text }
          : p.channel === 'thinking_delta'
            ? { type: 'thinking_delta', delta: p.text }
            : { type: 'message_delta', delta: p.text }
    }))
    bucket.pending = []
    return out
  }
}
