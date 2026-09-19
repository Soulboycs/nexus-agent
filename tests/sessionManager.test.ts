/**
 * TDD Test Suite: P1-S3 SessionManager(多会话并发引擎管理)
 * Contract: docs/CONTRACT-P1-S3-S4.md(C1–C8)
 *
 * 用 fake 引擎驱动真实 SessionManager:不依赖 LLM/Electron,
 * 锁定懒创建、事件路由(sessionId 注入)、busy 拒绝、审批/abort 定向、权限模式分层。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  SessionManager,
  type SessionEngineLike
} from '../src/main/agent/SessionManager'
import type { OutboundAgentEvent } from '../src/main/agent/DeltaCoalescer'
import type { AgentEvent, AgentStatus, PermissionMode } from '../src/shared/types'

class FakeEngine extends EventEmitter implements SessionEngineLike {
  status: AgentStatus = 'idle'
  mode: PermissionMode = 'ask'
  abortCalls = 0
  approvals: Array<{ callId: string; verdict: unknown }> = []
  runCount = 0
  private releaseRun?: () => void

  async run(_prompt: string, _opts?: { sessionId?: string }): Promise<unknown> {
    this.runCount++
    this.status = 'thinking'
    await new Promise<void>((r) => {
      this.releaseRun = () => {
        this.status = 'completed'
        r(null)
      }
    })
    return null
  }

  finish(): void {
    this.releaseRun?.()
  }

  abort(): void {
    this.abortCalls++
  }

  respondApproval(callId: string, verdict: unknown): void {
    this.approvals.push({ callId, verdict })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode
  }

  getPermissionMode(): PermissionMode {
    return this.mode
  }

  getStatus(): AgentStatus {
    return this.status
  }
}

describe('SessionManager — C1 懒创建', () => {
  it('同 sessionId 复用同一引擎;工厂每会话只调一次;未 run 过 has=false', async () => {
    const factories: FakeEngine[] = []
    const sm = new SessionManager({
      createEngine: () => {
        const e = new FakeEngine()
        factories.push(e)
        return e
      },
      onOutbound: () => {}
    })
    expect(sm.has('s1')).toBe(false)
    const p = sm.run('s1', 'hello')
    expect(sm.has('s1')).toBe(true)
    expect(factories.length).toBe(1)
    sm.getEngine('s1')!.finish()
    await p

    const p2 = sm.run('s1', 'again')
    expect(factories.length).toBe(1) // 复用
    expect(sm.getEngine('s1')).toBe(factories[0])
    sm.getEngine('s1')!.finish()
    await p2
  })
})

describe('SessionManager — C2/C3 事件路由', () => {
  let out: OutboundAgentEvent[]
  let engines: FakeEngine[]
  let sm: SessionManager

  beforeEach(() => {
    out = []
    engines = []
    sm = new SessionManager({
      createEngine: () => {
        const e = new FakeEngine()
        engines.push(e)
        return e
      },
      onOutbound: (b) => out.push(...b)
    })
  })
  afterEach(() => sm.dispose())

  it('C2: 引擎事件经合帧器出站,sessionId 注入正确', async () => {
    const p = sm.run('s1', 'hi')
    engines[0].emit('event', { type: 'thinking_delta', delta: 'x' } as AgentEvent)
    engines[0].emit('event', { type: 'thinking_delta', delta: 'y' } as AgentEvent)
    sm.flushAll()
    expect(out.length).toBe(1)
    expect(out[0].sessionId).toBe('s1')
    expect(out[0].seq).toBe(2) // 合并包 = 最后一个源事件 seq
    expect((out[0].event as { delta: string }).delta).toBe('xy')
    engines[0].finish()
    await p
  })

  it('C3: 两会话交错事件互不串', async () => {
    const p1 = sm.run('sA', 'a')
    const p2 = sm.run('sB', 'b')
    engines[0].emit('event', { type: 'message_delta', delta: '1' } as AgentEvent)
    engines[1].emit('event', { type: 'message_delta', delta: '2' } as AgentEvent)
    sm.flushAll()
    const a = out.find((e) => e.sessionId === 'sA')
    const b = out.find((e) => e.sessionId === 'sB')
    expect(a && (a.event as { delta: string }).delta).toBe('1')
    expect(b && (b.event as { delta: string }).delta).toBe('2')
    expect(a?.seq).toBe(1)
    expect(b?.seq).toBe(1)
    engines[0].finish()
    engines[1].finish()
    await Promise.all([p1, p2])
  })
})

describe('SessionManager — C4/C5/C6/C7 并发与路由', () => {
  let engines: FakeEngine[]
  let sm: SessionManager

  beforeEach(() => {
    engines = []
    sm = new SessionManager({
      createEngine: () => {
        const e = new FakeEngine()
        engines.push(e)
        return e
      },
      onOutbound: () => {}
    })
  })
  afterEach(() => sm.dispose())

  it('C4: 忙会话再次 run → reject 带 sessionId;空闲后可再 run', async () => {
    const p1 = sm.run('s1', 'first')
    await expect(sm.run('s1', 'second')).rejects.toThrow(/Session s1 is busy/)
    engines[0].finish()
    await p1
    const p3 = sm.run('s1', 'third')
    engines[0].finish()
    await p3
    expect(engines[0].runCount).toBe(2)
  })

  it('C5: abort 只路由到目标引擎', async () => {
    const p1 = sm.run('sA', 'a')
    sm.run('sB', 'b')
    expect(sm.abort('sA')).toBe(true)
    expect(engines[0].abortCalls).toBe(1)
    expect(engines[1].abortCalls).toBe(0)
    engines[0].finish()
    engines[1].finish()
    await Promise.all([p1, sm.getEngine('sB') && Promise.resolve()])
  })

  it('C6: respondApproval 路由到正确引擎', () => {
    sm.ensureEngine('sA')
    sm.ensureEngine('sB')
    expect(sm.respondApproval('sB', 'call1', { approved: true })).toBe(true)
    expect(sm.respondApproval('sZ', 'call1', { approved: true })).toBe(false)
    expect(engines[0].approvals.length).toBe(0)
    expect(engines[1].approvals.length).toBe(1)
  })

  it('C6b: respondApprovalByCallId 按最近发出该审批的会话路由(旧调用无 sessionId)', () => {
    sm.ensureEngine('sA')
    sm.ensureEngine('sB')
    engines[1].emit('event', {
      type: 'approval_required',
      request: { id: 'call-1', toolCallId: 't', toolName: 'n', arguments: {}, promptMessage: 'p', timestamp: 1 }
    } as AgentEvent)
    expect(sm.respondApprovalByCallId('call-1', { approved: false })).toBe(true)
    expect(engines[1].approvals.length).toBe(1)
    expect(sm.respondApprovalByCallId('never-seen', { approved: true })).toBe(false)
    expect(engines[0].approvals.length).toBe(0)
  })

  it('C7: per-session 权限模式与默认模式分层', async () => {
    const p = sm.run('sA', 'a')
    sm.ensureEngine('sB')
    sm.setPermissionMode('sA', 'bypass')
    expect(sm.getPermissionMode('sA')).toBe('bypass')
    expect(sm.getPermissionMode('sB')).toBe('ask')

    sm.setDefaultPermissionMode('plan')
    // 全局开关语义(兼容现有单开关 UI):默认值覆盖一切现存引擎(含显式设置过的)
    expect(sm.getPermissionMode('sA')).toBe('plan')
    expect(sm.getPermissionMode('sB')).toBe('plan')

    const p2 = sm.run('sC', 'c') // 之后新建的引擎
    expect(sm.getPermissionMode('sC')).toBe('plan')
    engines[0].finish()
    engines[2]?.finish()
    await Promise.all([p, p2])
  })
})

describe('SessionManager — C8 dispose', () => {
  it('dispose 后定时器不再触发 onOutbound', async () => {
    let timerBatches = 0
    const sm = new SessionManager({
      createEngine: () => new FakeEngine(),
      onOutbound: (b) => {
        if (b.length) timerBatches++
      },
      flushIntervalMs: 5
    })
    const e = sm.ensureEngine('s1')
    e.emit('event', { type: 'message_delta', delta: 'x' } as AgentEvent)
    await new Promise((r) => setTimeout(r, 40))
    expect(timerBatches).toBeGreaterThanOrEqual(1)
    sm.dispose()
    const after = timerBatches
    e.emit('event', { type: 'message_delta', delta: 'y' } as AgentEvent)
    await new Promise((r) => setTimeout(r, 30))
    expect(timerBatches).toBe(after)
  })
})

describe('SessionManager — C9–C12 接线所需补充语义', () => {
  let engines: FakeEngine[]
  let sm: SessionManager

  beforeEach(() => {
    engines = []
    sm = new SessionManager({
      createEngine: () => {
        const e = new FakeEngine()
        engines.push(e)
        return e
      },
      onOutbound: () => {}
    })
  })
  afterEach(() => sm.dispose())

  it('C9: dropEngine 移除实例;下次 ensure 重新走工厂;abortAll 覆盖全部忙会话', async () => {
    const p1 = sm.run('sA', 'a')
    sm.run('sB', 'b')
    expect(sm.sessionCount()).toBe(2)
    sm.dropEngine('sA')
    expect(sm.has('sA')).toBe(false)
    const p2 = sm.run('sA', 'a2')
    expect(engines.length).toBe(3) // sA 重建,sB 复用
    expect(sm.abortAll()).toBeGreaterThanOrEqual(1)
    engines.forEach((e) => e.finish())
    await Promise.all([p1, p2])
  })

  it('C10: awaiting_confirmation 不是 busy——run 前自动 abort 该引擎再继续', async () => {
    sm.ensureEngine('s1')
    engines[0].status = 'awaiting_confirmation'
    const p = sm.run('s1', 'next')
    expect(engines[0].abortCalls).toBe(1)
    engines[0].finish()
    await p
    expect(engines[0].runCount).toBe(1)
  })

  it('C11: fail(sessionId, msg) 以 error 事件入管道(seq 正确、屏障语义)', () => {
    const out: OutboundAgentEvent[] = []
    const sm2 = new SessionManager({
      createEngine: () => new FakeEngine(),
      onOutbound: (b) => out.push(...b)
    })
    sm2.fail('sX', 'boom')
    expect(out.length).toBe(1)
    expect(out[0].sessionId).toBe('sX')
    expect(out[0].seq).toBe(1)
    expect((out[0].event as { type: string }).type).toBe('error')
    sm2.dispose()
  })

  it('C12: getDefaultPermissionMode 反映当前默认值', () => {
    expect(sm.getDefaultPermissionMode()).toBe('ask')
    sm.setDefaultPermissionMode('bypass')
    expect(sm.getDefaultPermissionMode()).toBe('bypass')
  })
})
