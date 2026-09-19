// @vitest-environment happy-dom
/**
 * P1-S8a 渲染降本 DOM 测试(H1–H4,计划 §8.2):
 * - H1 StreamingText instant 模式:同步直显全文(非聚焦 pane 跳过打字机)
 * - H2 instant 模式下无 rAF 循环残留(content 后续变化直接反映,无插值延迟)
 * - H3 ChatTimeline streamInstant 透传:流式消息即时渲染全文
 * - H4 消息行携带 content-visibility 类(长时间线窗口化)
 * - H5 回归:常规打字机模式仍逐步显影(instant=false 不受影响)
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StreamingText } from '../../src/renderer/src/components/StreamingText'
import { ChatTimeline } from '../../src/renderer/src/components/ChatTimeline'
import type { ChatMessage } from '../../../src/shared/types'

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...over
})

describe('StreamingText — H1/H2 instant 直显', () => {
  it('H1: instant + isStreaming 同步渲染完整内容(无打字机)', () => {
    const { container } = render(
      <StreamingText content="# Hello **world**" isStreaming instant />
    )
    expect(container.textContent).toContain('Hello')
    expect(container.textContent).toContain('world')
  })

  it('H2: instant 下 content 更新即时反映(不经过 pacer 插值)', async () => {
    const { container, rerender } = render(
      <StreamingText content="first" isStreaming instant />
    )
    expect(container.textContent).toContain('first')
    rerender(<StreamingText content="first-second" isStreaming instant />)
    expect(container.textContent).toContain('first-second')
  })
})

describe('ChatTimeline — H3/H4 streamInstant 与窗口化', () => {
  it('H3: streamInstant 时流式消息全文即时渲染', () => {
    const m = msg({
      id: 'a1',
      isStreaming: true,
      blocks: [{ type: 'text', id: 'b1', content: 'instant text payload' }]
    })
    const { container } = render(<ChatTimeline messages={[m]} streamInstant />)
    expect(container.textContent).toContain('instant text payload')
  })

  it('H4: 消息行携带 cv-auto 类(content-visibility 窗口化)', () => {
    const m = msg({ id: 'a2', role: 'user', content: 'q' })
    const { container } = render(<ChatTimeline messages={[m]} />)
    expect(container.querySelector('.cv-auto')).toBeTruthy()
  })

  it('H5 回归:常规模式(instant=false)流式行存在光标占位(打字机路径未破坏)', () => {
    const m = msg({
      id: 'a3',
      isStreaming: true,
      blocks: [{ type: 'text', id: 'b3', content: 'typed' }]
    })
    const { container } = render(<ChatTimeline messages={[m]} />)
    // 打字机路径: StreamingText 组件渲染(光标 span 存在),内容可能尚未显影完成
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })
})
