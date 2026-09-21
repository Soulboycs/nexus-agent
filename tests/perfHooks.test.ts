/**
 * TDD Test Suite: P1-S8b 性能钩子(SendRateMeter + PerfLoadProvider)
 * Contract: 计划 §8.3(四指标可测化)
 */
import { describe, it, expect } from 'bun:test'
import { SendRateMeter } from '../src/main/agent/utils/sendRateMeter'
import { createPerfLoadProvider } from '../src/main/agent/utils/perfLoad'

describe('SendRateMeter — K1/K2 send 速率口径(§8.3)', () => {
  it('K1: 滚动 1s 窗口峰值;peak 为各次轮询的历史最大(每秒 poll 模型)', () => {
    const m = new SendRateMeter()
    const t0 = 1_000_000
    // 第 1 秒 30 次(33ms 间隔),随后每秒 poll 一次——主进程真实用法
    for (let i = 0; i < 30; i++) m.record(t0 + i * 33)
    expect(m.peakRate(t0 + 1000)).toBe(29) // 窗口 (t0, t0+1000] 含 29 条
    // 第 2 秒稀疏 10 次 → 窗口回落,峰值保持历史最大
    for (let i = 0; i < 10; i++) m.record(t0 + 1000 + i * 50)
    expect(m.peakRate(t0 + 2000)).toBe(29)
    // 第 4 秒密集 60 次 → 新峰值
    for (let i = 0; i < 60; i++) m.record(t0 + 4000 + i * 10)
    expect(m.peakRate(t0 + 4700)).toBe(60)
  })

  it('K2: reset 清空;空表 peakRate=0', () => {
    const m = new SendRateMeter()
    expect(m.peakRate(1000)).toBe(0)
    m.record(1000)
    m.reset()
    expect(m.peakRate(1100)).toBe(0)
  })
})

describe('PerfLoadProvider — K3/K4 合成流式负载', () => {
  it('K3: 按 totalChars/rate 流式产出,总量精确、 thinking 先于 content', async () => {
    const p = createPerfLoadProvider({ totalChars: 100, chunkChars: 10, delayMs: 0 })
    const chunks: Array<{ thinking?: string; content?: string }> = []
    await p.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))
    const thinkingTotal = chunks.reduce((a, c) => a + (c.thinking?.length ?? 0), 0)
    const contentTotal = chunks.reduce((a, c) => a + (c.content?.length ?? 0), 0)
    expect(thinkingTotal + contentTotal).toBe(100)
    // thinking 段在 content 段之前(前 50% thinking)
    const firstContentIdx = chunks.findIndex((c) => c.content)
    const lastThinkingIdx = chunks.reduce((a, c, i) => (c.thinking ? i : a), -1)
    expect(lastThinkingIdx).toBeLessThan(firstContentIdx)
  })

  it('K4: burst 周期注入 ≥10KB 大块(洪峰模拟)', async () => {
    const p = createPerfLoadProvider({
      totalChars: 50_000,
      chunkChars: 100,
      delayMs: 0,
      burstEvery: 5,
      burstChars: 10_240
    })
    const chunks: Array<{ content?: string }> = []
    await p.chatStream([], [], (c) => chunks.push(c))
    const maxChunk = Math.max(...chunks.map((c) => c.content?.length ?? 0))
    expect(maxChunk).toBeGreaterThanOrEqual(10_240)
  })
})
