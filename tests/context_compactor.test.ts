import { describe, it, expect } from 'bun:test'
import {
  ContextCompactor,
  estimateTokens,
  estimateConversationTokens
} from '../src/main/agent/memory/ContextCompactor'
import type { LLMMessage } from '../src/main/agent/providers/LLMProvider'

describe('ContextCompactor Token Estimation', () => {
  it('should estimate token counts proportionally for text, code, and symbols', () => {
    const text = 'Hello world, this is a test prompt for token estimation.'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(5)
    expect(tokens).toBeLessThan(30)

    // Chinese text has higher token density
    const cnText = '这是一段中文文本，用于测试中文字符的token估算准确性。'
    const cnTokens = estimateTokens(cnText)
    expect(cnTokens).toBeGreaterThan(10)
  })

  it('should calculate conversation total tokens across all roles and tool calls', () => {
    const history: LLMMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Read file foo.ts' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'view_file', arguments: '{"path":"foo.ts"}' }
          }
        ]
      },
      {
        role: 'tool',
        name: 'view_file',
        tool_call_id: 'call_1',
        content: 'export const x = 42;'
      }
    ]

    const total = estimateConversationTokens(history)
    expect(total).toBeGreaterThan(20)
  })
})

describe('ContextCompactor History Compaction', () => {
  const compactor = new ContextCompactor({
    thresholdTokens: 200, // Small threshold for test
    preserveRecentRounds: 1
  })

  it('should not compact if tokens are below threshold', async () => {
    const history: LLMMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Short prompt' },
      { role: 'assistant', content: 'Short answer' }
    ]

    const result = await compactor.compactHistory(history)
    expect(result.compacted).toBe(false)
    expect(result.messages.length).toBe(history.length)
  })

  it('should compact older messages into a summary block with compact_boundary when above threshold', async () => {
    // Generate long conversation
    const history: LLMMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Round 1: ' + 'A'.repeat(300) },
      { role: 'assistant', content: 'Answer 1: ' + 'B'.repeat(300) },
      { role: 'user', content: 'Round 2: ' + 'C'.repeat(300) },
      { role: 'assistant', content: 'Answer 2: ' + 'D'.repeat(300) },
      { role: 'user', content: 'Recent prompt: ' + 'E'.repeat(50) },
      { role: 'assistant', content: 'Recent answer: ' + 'F'.repeat(50) }
    ]

    const result = await compactor.compactHistory(history)
    expect(result.compacted).toBe(true)
    expect(result.savedTokens).toBeGreaterThan(100)

    // Verify boundary and structure
    const compacted = result.messages
    expect(compacted[0].role).toBe('system')
    
    // Boundary message should contain summary
    const boundaryMsg = compacted.find(m => m.content.includes('[compact_boundary]'))
    expect(boundaryMsg).toBeDefined()
    expect(boundaryMsg?.content).toContain('Conversation Summary up to this point')

    // Recent round should be intact
    const lastUser = compacted[compacted.length - 2]
    expect(lastUser.role).toBe('user')
    expect(lastUser.content).toContain('Recent prompt')
  })

  it('should maintain tool_use and tool_result pairing integrity during compaction', async () => {
    const history: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Long request 1 ' + 'X'.repeat(400) },
      {
        role: 'assistant',
        content: 'Running tool...',
        tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'run_cmd', arguments: '{}' } }]
      },
      { role: 'tool', name: 'run_cmd', tool_call_id: 'call_old', content: 'Old tool output ' + 'Y'.repeat(400) },
      { role: 'assistant', content: 'Old completed ' + 'Z'.repeat(400) },
      // Recent round with active tool
      { role: 'user', content: 'Recent request' },
      {
        role: 'assistant',
        content: 'Executing recent...',
        tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'run_cmd', arguments: '{}' } }]
      },
      { role: 'tool', name: 'run_cmd', tool_call_id: 'call_new', content: 'Recent tool output' },
      { role: 'assistant', content: 'Recent finished' }
    ]

    const result = await compactor.compactHistory(history)
    expect(result.compacted).toBe(true)

    // Check pair safety: Every tool call in result has its tool result, and vice-versa
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of result.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }

    for (const id of toolCallIds) {
      expect(toolResultIds.has(id)).toBe(true)
    }
    for (const id of toolResultIds) {
      expect(toolCallIds.has(id)).toBe(true)
    }
  })
})
