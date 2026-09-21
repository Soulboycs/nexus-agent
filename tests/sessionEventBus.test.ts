/**
 * TDD Test Suite: P1-S6 sessionEventBus(渲染进程按会话分发事件总线)
 * Contract: docs/CONTRACT-P1-S6.md(E1–E6)
 *
 * 多 pane 渲染隔离的核心:A 会话的 delta 只投递给 A 的监听者;
 * 单监听者抛错不中断同批其他监听者;seq 去重 + 断档告警(§7.3)。
 */
import { describe, it, expect, spyOn } from 'bun:test'
import { SessionEventBus } from '../src/renderer/src/utils/sessionEventBus'
import type { AgentEvent } from '../src/shared/types'

const delta = (s: string): AgentEvent => ({ type: 'message_delta', delta: s })

describe('SessionEventBus — E1/E2 订阅与投递', () => {
  it('E1: 订阅后批次事件按 sessionId 投递', () => {
    const bus = new SessionEventBus()
    const got: string[] = []
    bus.subscribe('s1', (e) => got.push((e as { delta: string }).delta))
    bus.ingestBatch([{ sessionId: 's1', seq: 1, event: delta('x') }])
    expect(got).toEqual(['x'])
  })

  it('E2: 同会话多监听者都收到;退订者不再收到', () => {
    const bus = new SessionEventBus()
    const a: string[] = []
    const b: string[] = []
    const unA = bus.subscribe('s1', (e) => a.push((e as { delta: string }).delta))
    bus.subscribe('s1', (e) => b.push((e as { delta: string }).delta))
    bus.ingestBatch([{ sessionId: 's1', seq: 1, event: delta('1') }])
    unA()
    bus.ingestBatch([{ sessionId: 's1', seq: 2, event: delta('2') }])
    expect(a).toEqual(['1'])
    expect(b).toEqual(['1', '2'])
  })

  it('E3: 会话隔离——sB 的监听者收不到 sA 的事件', () => {
    const bus = new SessionEventBus()
    const bGot: AgentEvent[] = []
    bus.subscribe('sB', (e) => bGot.push(e))
    bus.ingestBatch([
      { sessionId: 'sA', seq: 1, event: delta('a') },
      { sessionId: 'sB', seq: 1, event: delta('b') }
    ])
    expect(bGot.length).toBe(1)
    expect((bGot[0] as { delta: string }).delta).toBe('b')
  })
})

describe('SessionEventBus — E4/E5 健壮性', () => {
  it('E4: 单监听者抛错不中断同批其他监听者', () => {
    const bus = new SessionEventBus()
    const bGot: string[] = []
    bus.subscribe('s1', () => {
      throw new Error('listener boom')
    })
    bus.subscribe('s1', (e) => bGot.push((e as { delta: string }).delta))
    expect(() =>
      bus.ingestBatch([{ sessionId: 's1', seq: 1, event: delta('x') }])
    ).not.toThrow()
    expect(bGot).toEqual(['x'])
  })

  it('E5: 最后一个退订清理会话条目', () => {
    const bus = new SessionEventBus()
    const un1 = bus.subscribe('s1', () => {})
    const un2 = bus.subscribe('s1', () => {})
    expect(bus.sessionCount()).toBe(1)
    un1()
    expect(bus.sessionCount()).toBe(1)
    un2()
    expect(bus.sessionCount()).toBe(0)
  })
})

describe('SessionEventBus — E6 seq 去重与断档', () => {
  it('重复 seq(乱序旧包)丢弃;新 seq 正常投递', () => {
    const bus = new SessionEventBus()
    const got: number[] = []
    bus.subscribe('s1', () => got.push(1))
    bus.ingestBatch([
      { sessionId: 's1', seq: 1, event: delta('a') },
      { sessionId: 's1', seq: 1, event: delta('dup') }, // 重复 → 丢
      { sessionId: 's1', seq: 2, event: delta('b') }
    ])
    expect(got.length).toBe(2)
  })

  it('断档(seq 跳号)告警但仍投递(§7.3 v1 语义)', () => {
    const bus = new SessionEventBus()
    const warns: unknown[][] = []
    const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args)
    })
    const got: number[] = []
    bus.subscribe('s1', () => got.push(1))
    bus.ingestBatch([
      { sessionId: 's1', seq: 1, event: delta('a') },
      { sessionId: 's1', seq: 5, event: delta('b') } // gap 1→5
    ])
    spy.mockRestore()
    expect(got.length).toBe(2)
    expect(warns.length).toBe(1)
    expect(String(warns[0][0])).toContain('gap')
  })
})
