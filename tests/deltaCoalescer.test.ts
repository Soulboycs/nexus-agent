/**
 * TDD Test Suite: P1-S1 DeltaCoalescer (主进程 delta 合帧器)
 * Contract: docs/CONTRACT-P1-S1-delta-coalescer.md (A1–A10)
 *
 * 高价值门禁测试:每条对应一个可观察边界。测试直接驱动真实被测对象,
 * 不 mock 定时器以外的任何东西;被测类坏掉时这些测试必须失败。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  DeltaCoalescer,
  type OutboundAgentEvent
} from '../src/main/agent/DeltaCoalescer'
import type { AgentEvent } from '../src/shared/types'

function makeToolCallStart(name = 'read_file'): AgentEvent {
  return {
    type: 'tool_call_start',
    toolCall: { id: 'tc1', name, arguments: {} } as AgentEvent extends never
      ? never
      : Extract<AgentEvent, { type: 'tool_call_start' }>['toolCall']
  }
}

function batches(events: OutboundAgentEvent[]) {
  return events.map((e) => e.event)
}

describe('DeltaCoalescer — A1/A2/A3 通道拼接', () => {
  let out: OutboundAgentEvent[]
  let c: DeltaCoalescer

  beforeEach(() => {
    out = []
    c = new DeltaCoalescer({ onBatch: (b) => out.push(...b) })
  })
  afterEach(() => c.dispose())

  it('A1: 同通道相邻 delta 拼接为单事件', () => {
    c.ingest('s1', { type: 'thinking_delta', delta: 'a' })
    c.ingest('s1', { type: 'thinking_delta', delta: 'b' })
    c.ingest('s1', { type: 'thinking_delta', delta: 'c' })
    c.flushAll()
    const deltas = batches(out).filter((e) => e.type === 'thinking_delta')
    expect(deltas.length).toBe(1)
    expect((deltas[0] as { delta: string }).delta).toBe('abc')
  })

  it('A2: 不同通道不互相拼接且保持顺序', () => {
    c.ingest('s1', { type: 'thinking_delta', delta: 'a' })
    c.ingest('s1', { type: 'message_delta', delta: 'b' })
    c.flushAll()
    expect(batches(out).map((e) => e.type)).toEqual(['thinking_delta', 'message_delta'])
  })

  it('A3: terminal_output 按 chunk 拼接', () => {
    c.ingest('s1', { type: 'terminal_output', chunk: 'x' })
    c.ingest('s1', { type: 'terminal_output', chunk: 'y' })
    c.flushAll()
    const t = batches(out).filter((e) => e.type === 'terminal_output')
    expect(t.length).toBe(1)
    expect((t[0] as { chunk: string }).chunk).toBe('xy')
  })

  it('A8: 空文本不产生任何出站事件', () => {
    c.ingest('s1', { type: 'message_delta', delta: '' })
    c.ingest('s1', { type: 'terminal_output', chunk: '' })
    c.flushAll()
    expect(out.length).toBe(0)
  })
})

describe('DeltaCoalescer — A4 FIFO 屏障', () => {
  let out: OutboundAgentEvent[]
  let c: DeltaCoalescer

  beforeEach(() => {
    out = []
    c = new DeltaCoalescer({ onBatch: (b) => out.push(...b) })
  })
  afterEach(() => c.dispose())

  it('A4: 结构化事件透传前先 flush 本会话积压文本', () => {
    c.ingest('s1', { type: 'thinking_delta', delta: 'a' })
    c.ingest('s1', makeToolCallStart())
    c.ingest('s1', { type: 'thinking_delta', delta: 'b' })
    c.flushAll()

    // 屏障点:a 已随 tool_call_start 同批出站,顺序在前
    const firstTwo = batches(out).slice(0, 2).map((e) => e.type)
    expect(firstTwo).toEqual(['thinking_delta', 'tool_call_start'])
    // 屏障后进入桶的 b 下次才出站(flushAll 即下次)
    expect(batches(out).filter((e) => e.type === 'thinking_delta').length).toBe(2)
    expect(out.length).toBe(3)
  })

  it('A4b: 屏障 flush 的 delta 与结构化事件在同一批(batch)里', () => {
    let batchCount = 0
    const c2 = new DeltaCoalescer({
      onBatch: () => {
        batchCount++
      }
    })
    c2.ingest('s1', { type: 'thinking_delta', delta: 'a' })
    c2.ingest('s1', makeToolCallStart('write_file'))
    expect(batchCount).toBe(1) // 屏障触发即时批量出站
    c2.flushAll()
    expect(batchCount).toBe(1) // 桶空,无新批
    c2.dispose()
  })

  it.each([
    ['status_change', { type: 'status_change', status: 'idle' } as AgentEvent],
    ['error', { type: 'error', message: 'x' } as AgentEvent],
    [
      'tool_call_complete',
      {
        type: 'tool_call_complete',
        result: { toolCallId: 't', name: 'n', isError: false }
      } as AgentEvent
    ],
    [
      'tool_call_output',
      { type: 'tool_call_output', toolCallId: 't', chunk: 'k' } as AgentEvent
    ]
  ])('A9: %s 是屏障事件,先 flush 再自占出站位', (_name, barrier) => {
    c.ingest('s1', { type: 'message_delta', delta: 'pre' })
    c.ingest('s1', barrier)
    const seq = out.map((e) => e.seq)
    expect(batches(out)[0].type).toBe('message_delta')
    expect(batches(out)[1].type).toBe(barrier.type)
    expect(seq).toEqual([1, 2])
  })
})

describe('DeltaCoalescer — A5/A6/A7 seq 与会话隔离', () => {
  let out: OutboundAgentEvent[]
  let c: DeltaCoalescer

  beforeEach(() => {
    out = []
    c = new DeltaCoalescer({ onBatch: (b) => out.push(...b) })
  })
  afterEach(() => c.dispose())

  it('A5: 合并包 seq = 最后一个源事件;结构化事件各占一 seq', () => {
    // 3 个 source delta -> 合并包 seq=3;barrier 占 seq=4
    c.ingest('s1', { type: 'thinking_delta', delta: 'a' })
    c.ingest('s1', { type: 'thinking_delta', delta: 'b' })
    c.ingest('s1', { type: 'thinking_delta', delta: 'c' })
    c.ingest('s1', makeToolCallStart())
    expect(out.map((e) => e.seq)).toEqual([3, 4])
  })

  it('A5b: seq 按会话独立计数', () => {
    c.ingest('s1', { type: 'message_delta', delta: 'x' })
    c.ingest('s2', { type: 'message_delta', delta: 'y' })
    c.flushAll()
    const s1 = out.find((e) => e.sessionId === 's1')
    const s2 = out.find((e) => e.sessionId === 's2')
    expect(s1?.seq).toBe(1)
    expect(s2?.seq).toBe(1)
  })

  it('A6: 会话 A 的屏障只 flush A 的桶', () => {
    c.ingest('sA', { type: 'thinking_delta', delta: 'a' })
    c.ingest('sB', { type: 'thinking_delta', delta: 'b' })
    c.ingest('sA', makeToolCallStart())
    // A 出站:a + tool_call_start;B 仍在桶中
    expect(out.filter((e) => e.sessionId === 'sA').length).toBe(2)
    expect(out.filter((e) => e.sessionId === 'sB').length).toBe(0)
    c.flushAll()
    expect(out.filter((e) => e.sessionId === 'sB').length).toBe(1)
  })

  it('A7: flushAll 后再次触发不重复交付;空批不调用 onBatch', () => {
    let calls = 0
    const c2 = new DeltaCoalescer({
      onBatch: () => {
        calls++
      }
    })
    c2.ingest('s1', { type: 'message_delta', delta: 'a' })
    c2.flushAll()
    c2.flushAll()
    expect(calls).toBe(1)
    c2.dispose()
  })

  it('A7b: 多会话同批交付', () => {
    c.ingest('s1', { type: 'message_delta', delta: 'a' })
    c.ingest('s2', { type: 'message_delta', delta: 'b' })
    c.ingest('s3', { type: 'terminal_output', chunk: 'c' })
    let lastBatchSize = 0
    const c3 = new DeltaCoalescer({
      onBatch: (b) => {
        lastBatchSize = b.length
      }
    })
    c3.ingest('s1', { type: 'message_delta', delta: 'a' })
    c3.ingest('s2', { type: 'message_delta', delta: 'b' })
    c3.ingest('s3', { type: 'terminal_output', chunk: 'c' })
    c3.flushAll()
    expect(lastBatchSize).toBe(3)
    c3.dispose()
  })
})

describe('DeltaCoalescer — A10 定时器', () => {
  it('A10: 定时器路径触发 onBatch;dispose 后不再触发', async () => {
    let timerBatches = 0
    const c = new DeltaCoalescer({
      onBatch: (b) => {
        if (b.length) timerBatches++
      },
      flushIntervalMs: 5
    })
    c.ingest('s1', { type: 'message_delta', delta: 'tick' })
    await new Promise((r) => setTimeout(r, 40))
    expect(timerBatches).toBeGreaterThanOrEqual(1)
    c.dispose()
    const after = timerBatches
    await new Promise((r) => setTimeout(r, 30))
    expect(timerBatches).toBe(after)
  })
})
