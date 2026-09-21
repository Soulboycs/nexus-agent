// @vitest-environment happy-dom
/**
 * StreamingText 组件测试 — 2026-09-17 审计整改的组件层保护
 *
 * 覆盖：逐字节奏组件级下界、完成态平滑收尾接线（原死路径）、历史消息直出、
 * 禁止合成反引号伪影（closeUnclosedCodeBlocks 已移除）、S2 心跳 [Receiving...]。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { StreamingText } from '../../src/renderer/src/components/StreamingText'

describe('StreamingText — 流式渲染组件', () => {
  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    // 统一伪造时间轴：rAF / setInterval / performance.now 全部由 fake timers 驱动，
    // 帧推进 = advanceTimersByTime(16ms)，彻底消除真实时钟的非确定性。
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame'
      ]
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 推进 n 帧（每帧 16ms），rAF 回调由伪造时间轴触发 */
  const pumpFrames = (n: number, dt = 16) => {
    act(() => {
      vi.advanceTimersByTime(dt * n)
    })
  }

  /**
   * StreamingText 现经 MarkdownRenderer 渲染（marked 会包裹 <p> 并输出尾随 \n），
   * 文本断言统一剥离尾随换行后与原始输入比较（2026-09-18 适配并行会话的 markdown 集成）。
   */
  const renderedText = (c: HTMLElement) => (c.textContent || '').replace(/\n+$/, '')

  it('renders text incrementally (typewriter) instead of one big jump — component-level lower bound', () => {
    const long = 'A'.repeat(200)
    const { container, rerender } = render(<StreamingText content="A" isStreaming />)
    rerender(<StreamingText content={long} isStreaming />)

    pumpFrames(2)
    const shownAfter2Frames = renderedText(container).length
    expect(shownAfter2Frames).toBeGreaterThan(0)
    expect(shownAfter2Frames).toBeLessThan(long.length) // 2 帧后仍在打字，直出/瞬刷被禁止

    pumpFrames(40)
    expect(renderedText(container)).toBe(long) // 但背压机制保证最终完全追上
  })

  it('smoothly seals remaining buffer within bounded frames on completion (isFinished path now wired)', () => {
    const text = 'B'.repeat(60)
    const onComplete = vi.fn()
    const { container, rerender } = render(<StreamingText content="B" isStreaming />)
    rerender(<StreamingText content={text} isStreaming onComplete={onComplete} />)

    pumpFrames(1)
    expect(renderedText(container).length).toBeLessThan(text.length) // 仍有积压

    rerender(<StreamingText content={text} isStreaming={false} onComplete={onComplete} />)
    expect(renderedText(container)).not.toBe(text) // 完成瞬间不瞬跳 — 平滑收尾启动

    pumpFrames(12) // ≤ ~12 帧（约 190ms）内收敛
    expect(renderedText(container)).toBe(text)
    expect(onComplete).toHaveBeenCalled()
  })

  it('renders finalized history content instantly without any seal animation', () => {
    const text = 'H'.repeat(300)
    const { container } = render(<StreamingText content={text} isStreaming={false} />)
    expect(renderedText(container)).toBe(text) // 历史消息直接全量呈现，无逐字动画
  })

  it('renders odd-backtick streaming prefixes safely — no synthetic artifacts, final code span parsed', () => {
    // 2026-09-18 重设计：渲染层接入 markdown 后“展示=原始前缀”不再成立（code span
    // 会剥离反引号）。新不变量：① 任意奇数反引号前缀渲染不崩溃且无合成伪影
    // （旧 closeUnclosedCodeBlocks 的 '\n`' 签名）；② 终态 code span 被正确解析。
    const target = 'Use `npm install` now' // 流式中必然出现奇数个反引号的瞬间
    const { container, rerender } = render(<StreamingText content="" isStreaming />)

    for (let i = 1; i <= target.length; i++) {
      rerender(<StreamingText content={target.slice(0, i)} isStreaming />)
      pumpFrames(2)
      const shown = container.textContent || ''
      expect(shown.includes('\n`')).toBe(false) // 严禁补齐启发式合成可见伪影
    }

    pumpFrames(10)
    const final = renderedText(container)
    expect(final).toContain('Use')
    expect(final).toContain('npm install') // 成对反引号被 markdown 正确解析为 code span
    expect(final).toContain('now')
  })

  it('S2 heartbeat: shows [Receiving...] after 5s stall and clears on new content', () => {
    const { container, rerender } = render(<StreamingText content="Stalled" isStreaming />)
    pumpFrames(1)

    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(container.textContent).not.toContain('Receiving')

    act(() => {
      vi.advanceTimersByTime(1000) // 累计 5.5s 无新数据
    })
    expect(container.textContent).toContain('[Receiving...]')

    rerender(<StreamingText content="Stalled and recovered" isStreaming />)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(container.textContent).not.toContain('Receiving') // 新数据到达即熄灭
  })
})
