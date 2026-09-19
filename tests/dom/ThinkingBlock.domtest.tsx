// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ChatTimeline } from '../../src/renderer/src/components/ChatTimeline'
import { ChatMessage } from '../../src/shared/types'

describe('ChatGPT-style Thinking Component in ChatTimeline', () => {
  it('renders "思考中..." and expands while actively streaming thinking', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        thinking: 'Let me break down the solution step by step...',
        isStreaming: true,
        timestamp: Date.now()
      }
    ]

    const { getByText, queryByText } = render(<ChatTimeline messages={messages} />)

    // Should display "思考中"
    expect(getByText(/思考中/)).toBeDefined()
    // Should NOT display legacy "思考过程 (Thought Process)"
    expect(queryByText(/Thought Process/)).toBeNull()
    // Should display the streaming thinking content
    expect(getByText(/Let me break down the solution/)).toBeDefined()
  })

  it('switches to "已深度思考" and can be collapsed/expanded when thinking finishes', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'This is the final answer.',
        thinking: 'Finished planning reasoning steps.',
        isStreaming: false,
        timestamp: Date.now()
      }
    ]

    const { getByText, queryByText } = render(<ChatTimeline messages={messages} />)

    // Finished state should display "已深度思考"
    expect(getByText(/已深度思考/)).toBeDefined()
    // By default, finished thinking is collapsed like ChatGPT
    expect(queryByText(/Finished planning reasoning steps/)).toBeNull()

    // Clicking header expands the thinking trace
    fireEvent.click(getByText(/已深度思考/))
    expect(getByText(/Finished planning reasoning steps/)).toBeDefined()

    // Clicking again collapses it
    fireEvent.click(getByText(/已深度思考/))
    expect(queryByText(/Finished planning reasoning steps/)).toBeNull()
  })
})
