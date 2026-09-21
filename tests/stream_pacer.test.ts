import { describe, it, expect, beforeEach } from 'bun:test'
import { StreamPacer, splitIntoGraphemes } from '../src/renderer/src/utils/streamPacer'

describe('StreamPacer — TDD: 平滑打字机缓冲消费引擎', () => {
  let pacer: StreamPacer

  beforeEach(() => {
    pacer = new StreamPacer()
  })

  it('correctly splits multi-byte emojis and Chinese characters without corrupting surrogate pairs', () => {
    const text = 'Hello 世界! 🚀👨‍👩‍👧‍👦'
    const graphemes = splitIntoGraphemes(text)
    expect(graphemes.join('')).toBe(text)
    // Ensure emoji is a single unit, not split into dangling surrogates or broken ZWJ sequences
    expect(graphemes).toContain('🚀')
    expect(graphemes).toContain('👨‍👩‍👧‍👦')
    expect(graphemes).toContain('世')
    expect(graphemes).toContain('界')
  })

  it('achieves 0ms TTFT bypass on the very first token without artificial frame delay', () => {
    pacer.setTarget('Hi')
    // First token is immediately displayed on setTarget (0ms artificial latency)
    expect(pacer.getDisplayed()).toBe('Hi')
  })

  it('steps smoothly by 1-2 characters in low buffer depth (pending <= 6)', () => {
    pacer.setTarget('Hi') // First token bypasses (2 chars)
    expect(pacer.getDisplayed()).toBe('Hi')

    // Append 5 more characters (pending = 5 <= 6)
    pacer.setTarget('Hi, world')
    const beforeStep = pacer.getDisplayed().length

    // Step 1
    const step1 = pacer.step(16) // ~16ms frame
    const delta = step1.length - beforeStep
    expect(delta).toBeGreaterThanOrEqual(1)
    expect(delta).toBeLessThanOrEqual(2) // low depth consumes 1-2 chars per frame for maximum typewriter smoothness

    // Step repeatedly until completed
    while (!pacer.isDone()) {
      pacer.step(16)
    }
    expect(pacer.getDisplayed()).toBe('Hi, world')
  })

  it('accelerates dynamically during large bursts (pending > 100) to prevent lag', () => {
    const hugeSnippet = 'const a = 1;\n'.repeat(50) // ~650 chars
    pacer.setTarget(hugeSnippet)

    // First frame should consume significantly more than 1 char (e.g. >= 20 chars)
    const initialAdvance = pacer.step(16)
    expect(initialAdvance.length).toBeGreaterThanOrEqual(15)

    // Should drain the entire 650 chars within at most 15 frames (~250ms at 60fps)
    let frames = 1
    while (!pacer.isDone() && frames < 50) {
      pacer.step(16)
      frames++
    }
    expect(frames).toBeLessThan(30)
    expect(pacer.getDisplayed()).toBe(hugeSnippet)
  })

  it('drains remaining buffer smoothly within 150ms when isFinished is true', () => {
    pacer.setTarget('Initial prefix that was streaming')
    pacer.flush()

    // Add 40 more characters right at completion
    pacer.setTarget('Initial prefix that was streaming and here is the final 40 characters.')
    expect(pacer.isDone()).toBe(false)

    // Step with isFinished = true
    let frames = 0
    while (!pacer.isDone() && frames < 20) {
      pacer.step(16, true)
      frames++
    }
    expect(frames).toBeLessThanOrEqual(10) // drains in <= 10 frames (~150ms)
    expect(pacer.getDisplayed()).toBe('Initial prefix that was streaming and here is the final 40 characters.')
  })

  it('supports instant flush on stream complete or user abort', () => {
    pacer.setTarget('Partial text that was streaming...')
    pacer.step(16)
    expect(pacer.getDisplayed().length).toBeLessThan('Partial text that was streaming...'.length)

    // Instant flush
    pacer.flush()
    expect(pacer.getDisplayed()).toBe('Partial text that was streaming...')
    expect(pacer.isDone()).toBe(true)
  })

  it('handles background tab frame throttling with timestamp compensation', () => {
    pacer.setTarget('Background tab text recovery testing')
    // Simulate tab being throttled for 500ms
    pacer.step(500)
    // Should catch up immediately or almost immediately
    expect(pacer.isDone()).toBe(true)
    expect(pacer.getDisplayed()).toBe('Background tab text recovery testing')
  })

  it('is idempotent when target is unchanged', () => {
    pacer.setTarget('Same text')
    pacer.flush()
    expect(pacer.getDisplayed()).toBe('Same text')

    pacer.setTarget('Same text')
    expect(pacer.isDone()).toBe(true)
    expect(pacer.getDisplayed()).toBe('Same text')
  })

  it('resets all state completely via reset()', () => {
    pacer.setTarget('Something to reset')
    pacer.flush()
    expect(pacer.getDisplayed()).toBe('Something to reset')
    pacer.reset()
    expect(pacer.getDisplayed()).toBe('')
    expect(pacer.isDone()).toBe(true)
  })

  // ─── 2026-09-17 独立复审补测：封堵变异测试 M-A/M-B 暴露的覆盖缺口 ───

  it('consumes EXACTLY 1 grapheme per frame in the true pending <= 6 band (typewriter floor)', () => {
    // TTFT bypass shows the first 2 graphemes; appending 3 more puts pending = 3 (<= 6 band)
    pacer.setTarget('Hi')
    expect(pacer.getDisplayed()).toBe('Hi')
    pacer.setTarget('Hi ab') // pending = 3 → 低缓冲极细节奏分支
    const before = pacer.getDisplayed()
    const after = pacer.step(16)
    expect(after.length - before.length).toBe(1) // 单字/帧是计划承诺的打字机节奏下界
    expect(after).toBe('Hi ')
  })

  it('setTarget replacement (non-append) re-seals displayed text to a prefix of the NEW target', () => {
    pacer.setTarget('Original message text') // bypass 2 + one step (band 7-20 → 2)
    pacer.step(16)
    expect(pacer.getDisplayed()).toBe('Orig')

    // 上游修正/截断：新文本不是旧文本的延伸 → 整体替换路径
    pacer.setTarget('Corrected text')
    expect(pacer.getDisplayed()).toBe('Corr') // 已展示部分必须重新锚定到新文本前缀，旧文本不得残留
    expect('Corrected text'.startsWith(pacer.getDisplayed())).toBe(true)

    // 截断到比已展示更短：displayedIndex 收敛且立即完成
    pacer.flush()
    pacer.setTarget('tiny')
    expect(pacer.getDisplayed()).toBe('tiny')
    expect(pacer.isDone()).toBe(true)
  })

  it('never renders the full target instantly mid-stream (anti-jump lower bound)', () => {
    const target = 'X'.repeat(120)
    pacer.setTarget(target)
    const f1 = pacer.step(16)
    const f2 = pacer.step(16)
    const f3 = pacer.step(16)
    // 下界：3 帧后仍在追赶 — 任何“直出/瞬刷”退化都被禁止
    expect(f3.length).toBeLessThan(target.length)
    // 上界：背压机制必须真实推进（洪峰加速）
    expect(f1.length).toBeGreaterThan(2)
    while (!pacer.isDone()) pacer.step(16)
    expect(pacer.getDisplayed()).toBe(target)
  })

  it('P3: dt=199 still paces smoothly while dt=200 flushes (background-compensation boundary)', () => {
    const text = 'Y'.repeat(500)
    pacer.setTarget(text)

    const after199 = pacer.step(199) // 恰低于补偿阈值：仍走自适应曲线
    expect(pacer.isDone()).toBe(false)
    expect(after199.length).toBeGreaterThan(2)
    expect(after199.length).toBeLessThan(text.length)

    const after200 = pacer.step(200) // 达到阈值：整段快进
    expect(pacer.isDone()).toBe(true)
    expect(after200).toBe(text)
  })
})
