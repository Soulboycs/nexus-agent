import { describe, expect, it } from 'vitest'
import { gapAccumulator } from '../../src/renderer/src/components/word/pagination-lines'

const rect = (top: number, height: number) => ({ top, height } as DOMRect)

function naive(gaps: DOMRect[]) {
  return (top: number) => gaps.reduce((s, g) => (g.top <= top ? s + g.height : s), 0)
}

describe('gapAccumulator (layout measurement hot path, O(log G) vs O(G))', () => {
  it('matches the naive per-query scan exactly, including equal tops and boundaries', () => {
    const gaps = [
      rect(100, 20),
      rect(100, 5), // duplicate top must accumulate both
      rect(300, 40),
      rect(1000, 12),
    ]
    const fast = gapAccumulator(gaps)
    const slow = naive(gaps)
    for (const q of [-5, 0, 99.9, 100, 101, 299, 300, 340, 999, 1000, 1e9]) {
      expect(fast(q)).toBe(slow(q))
    }
    expect(fast(100)).toBe(25)
    expect(fast(299)).toBe(25)
    expect(fast(1000)).toBe(77)
  })

  it('empty gap sets short-circuit to zero', () => {
    expect(gapAccumulator([])(12345)).toBe(0)
  })

  it('synthetic benchmark: 200 gaps × 20k queries beats the naive scan (indicative, not a frame-rate claim)', () => {
    const gaps: DOMRect[] = Array.from({ length: 200 }, (_, i) =>
      rect((i + 1) * 800, 24),
    )
    const queries = Array.from({ length: 20000 }, (_, i) => (i * 7919) % 200000)
    const fast = gapAccumulator(gaps)
    const slow = naive(gaps)
    for (const q of queries) expect(fast(q)).toBe(slow(q))

    const t0 = performance.now()
    for (const q of queries) slow(q)
    const naiveMs = performance.now() - t0
    const t1 = performance.now()
    for (const q of queries) fast(q)
    const fastMs = performance.now() - t1
    // happy-dom timings are machine-load sensitive: assert the structural win
    // (better on every run we measured) with a loose floor, and record both
    expect(fastMs).toBeLessThan(Math.max(naiveMs, 1))
  })
})
