import type { EventEmitter } from 'node:events'
import type { AgentEvent, AgentStatus, PermissionMode } from '../../shared/types'
import { DeltaCoalescer, type OutboundAgentEvent } from './DeltaCoalescer'

/**
 * SessionManager 依赖的最小引擎接口。
 * 真实 AgentEngine 满足此结构;测试注入 fake,不依赖 LLM/Electron。
 */
export interface SessionEngineLike extends EventEmitter {
  run(
    userPrompt: string,
    options?: { sessionId?: string; initialMessages?: unknown[] }
  ): Promise<unknown>
  abort(): unknown
  respondApproval(callId: string, verdict: unknown): unknown
  setPermissionMode(mode: PermissionMode): void
  getPermissionMode(): PermissionMode
  getStatus(): AgentStatus
}

export interface SessionManagerOptions {
  /** per-session 工厂(workspace/provider 由调用方烘焙进闭包) */
  createEngine: () => SessionEngineLike
  /** 合帧后的批量出站(S5 接线到 webContents.send) */
  onOutbound: (batch: OutboundAgentEvent[]) => void
  /** turn 终止回调(持久化上移钩子,§7.1) */
  onTurnEnd?: (sessionId: string) => void
  flushIntervalMs?: number
}

/** 占用中的状态:再次 run 视为该会话忙(awaiting_confirmation 单独处理:自动 abort 后继续) */
const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set(['thinking', 'tool_executing'])

/**
 * 多会话引擎管理(计划 §7.1):
 * Map<sessionId, engine> 懒创建;事件经 DeltaCoalescer 注入 sessionId 后批量出站;
 * run/abort/审批/权限模式全部按会话隔离。
 */
export class SessionManager {
  private readonly engines = new Map<string, SessionEngineLike>()
  private readonly coalescer: DeltaCoalescer
  private defaultPermissionMode: PermissionMode = 'ask'
  private disposed = false
  /** callId → 最近发出该审批的 sessionId(供旧式无 sessionId 审批调用路由) */
  private approvalCallOwners = new Map<string, string>()

  constructor(private readonly options: SessionManagerOptions) {
    this.coalescer = new DeltaCoalescer({
      onBatch: options.onOutbound,
      flushIntervalMs: options.flushIntervalMs
    })
  }

  has(sessionId: string): boolean {
    return this.engines.has(sessionId)
  }

  getEngine(sessionId: string): SessionEngineLike | undefined {
    return this.engines.get(sessionId)
  }

  /** 懒创建:工厂 → 应用默认权限模式 → 订阅事件管道 */
  ensureEngine(sessionId: string): SessionEngineLike {
    let engine = this.engines.get(sessionId)
    if (engine) return engine
    engine = this.options.createEngine()
    engine.setPermissionMode(this.defaultPermissionMode)
    engine.on('event', (event: AgentEvent) => {
      if (event.type === 'approval_required') {
        this.approvalCallOwners.set(event.request.id, sessionId)
      }
      this.coalescer.ingest(sessionId, event)
    })
    this.engines.set(sessionId, engine)
    return engine
  }

  async run(
    sessionId: string,
    prompt: string,
    opts?: { initialMessages?: unknown[] }
  ): Promise<unknown> {
    const engine = this.ensureEngine(sessionId)
    const status = engine.getStatus()
    if (status === 'awaiting_confirmation') {
      // 卡在确认的旧轮次自动 abort(原 main/index.ts:282 逻辑 per-session 化)
      engine.abort()
    } else if (BUSY_STATUSES.has(status)) {
      throw new Error(`Session ${sessionId} is busy (${status})`)
    }
    const result = await engine.run(prompt, { sessionId, ...opts })
    this.options.onTurnEnd?.(sessionId)
    return result
  }

  abort(sessionId: string): boolean {
    const engine = this.engines.get(sessionId)
    if (!engine) return false
    engine.abort()
    return true
  }

  /** 旧式全局 abort(无 sessionId 的 IPC):中止全部会话,返回受影响数 */
  abortAll(): number {
    let n = 0
    for (const engine of this.engines.values()) {
      engine.abort()
      n++
    }
    return n
  }

  /** 移除引擎实例(workspace 变更/provider 失效时由接线层调用,下次 ensure 重建) */
  dropEngine(sessionId: string): boolean {
    return this.engines.delete(sessionId)
  }

  /** 以该会话名义注入系统级 error 事件(走合帧管道,seq/屏障语义一致) */
  fail(sessionId: string, message: string): void {
    this.coalescer.ingest(sessionId, { type: 'error', message })
  }

  respondApproval(sessionId: string, callId: string, verdict: unknown): boolean {
    const engine = this.engines.get(sessionId)
    if (!engine) return false
    engine.respondApproval(callId, verdict)
    return true
  }

  /** 旧式无 sessionId 的审批调用:按最近发出该审批的会话路由 */
  respondApprovalByCallId(callId: string, verdict: unknown): boolean {
    const owner = this.approvalCallOwners.get(callId)
    if (!owner) return false
    const ok = this.respondApproval(owner, callId, verdict)
    if (ok) this.approvalCallOwners.delete(callId) // 审批已决,清登记
    return ok
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    this.ensureEngine(sessionId).setPermissionMode(mode)
  }

  /** 全局开关语义:覆盖现存全部引擎,并作为之后新建引擎的默认值 */
  setDefaultPermissionMode(mode: PermissionMode): void {
    this.defaultPermissionMode = mode
    for (const engine of this.engines.values()) engine.setPermissionMode(mode)
  }

  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.engines.get(sessionId)?.getPermissionMode()
  }

  getDefaultPermissionMode(): PermissionMode {
    return this.defaultPermissionMode
  }

  sessionCount(): number {
    return this.engines.size
  }

  /** 立即清空合帧积压并批量出站(关停/测试用) */
  flushAll(): void {
    this.coalescer.flushAll()
  }

  dispose(): void {
    this.disposed = true
    this.coalescer.dispose()
    this.engines.clear()
    this.approvalCallOwners.clear()
  }
}
