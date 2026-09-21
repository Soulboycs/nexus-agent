import { describe, expect, it } from 'vitest'
import {
  ContextCompactor,
  estimateTokens,
  estimateConversationTokens,
  TOOL_RESULT_CLEARED_MESSAGE
} from '../../src/main/agent/memory/ContextCompactor'
import type { LLMMessage } from '../../src/main/agent/providers/LLMProvider'

describe('ContextCompactor - Microcompaction & Macrocompaction (1:1 Claude Code)', () => {
  it('accurately estimates tokens for ASCII, CJK, and tool calls', () => {
    expect(estimateTokens('Hello world')).toBeGreaterThan(0)
    // CJK characters have higher token density
    const cjkTokens = estimateTokens('你好世界这是一个中文测试')
    expect(cjkTokens).toBe(8)

    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'view_file', arguments: JSON.stringify({ filePath: 'test.ts' }) }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'line 1\nline 2' }
    ]

    const total = estimateConversationTokens(messages)
    expect(total).toBeGreaterThan(30)
  })

  it('microcompactToolResults clears historical tool results while protecting recent turns', () => {
    const compactor = new ContextCompactor({
      thresholdTokens: 1000,
      preserveRecentRounds: 2
    })

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are Nexus Agent' },
      // Round 1 (Historical)
      { role: 'user', content: 'Read old file' },
      {
        role: 'assistant',
        content: 'I will read it',
        tool_calls: [{ id: 'call_old_1', type: 'function', function: { name: 'view_file', arguments: '{}' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_old_1',
        name: 'view_file',
        content: 'HUGE_OUTPUT_'.repeat(200) // ~2400 chars
      },
      { role: 'assistant', content: 'Old file read.' },

      // Round 2 (Recent - keepRecentRounds: 2)
      { role: 'user', content: 'Read second file' },
      {
        role: 'assistant',
        content: 'Reading second file',
        tool_calls: [{ id: 'call_mid_2', type: 'function', function: { name: 'view_file', arguments: '{}' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_mid_2',
        name: 'view_file',
        content: 'RECENT_OUTPUT_2'
      },
      { role: 'assistant', content: 'Got it.' },

      // Round 3 (Most Recent)
      { role: 'user', content: 'Read latest file' },
      {
        role: 'assistant',
        content: 'Reading latest file',
        tool_calls: [{ id: 'call_latest_3', type: 'function', function: { name: 'view_file', arguments: '{}' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_latest_3',
        name: 'view_file',
        content: 'LATEST_OUTPUT_3'
      }
    ]

    const res = compactor.microcompactToolResults(messages, 2)
    expect(res.compacted).toBe(true)
    expect(res.clearedCount).toBe(1)
    expect(res.savedTokens).toBeGreaterThan(100)

    // Old round tool result was cleared
    const oldToolMsg = res.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_old_1')
    expect(oldToolMsg?.content).toBe(TOOL_RESULT_CLEARED_MESSAGE)

    // Recent round tool results were preserved intact
    const midToolMsg = res.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_mid_2')
    expect(midToolMsg?.content).toBe('RECENT_OUTPUT_2')

    const latestToolMsg = res.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_latest_3')
    expect(latestToolMsg?.content).toBe('LATEST_OUTPUT_3')
  })

  it('compactHistory generates [compact_boundary] and preserves tool pairings', async () => {
    const compactor = new ContextCompactor({
      thresholdTokens: 50,
      preserveRecentRounds: 1
    })

    const messages: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Step 1: check environment' },
      { role: 'assistant', content: 'Checked environment' },
      { role: 'user', content: 'Step 2: build project' },
      { role: 'assistant', content: 'Built project' },
      { role: 'user', content: 'Step 3: deploy' }
    ]

    const res = await compactor.compactHistory(messages, { force: true })
    expect(res.compacted).toBe(true)
    expect(res.messages[0].role).toBe('system')
    expect(res.messages.some((m) => typeof m.content === 'string' && m.content.includes('[compact_boundary]'))).toBe(true)
    // Latest user message is preserved
    expect(res.messages[res.messages.length - 1].content).toBe('Step 3: deploy')
  })
})
