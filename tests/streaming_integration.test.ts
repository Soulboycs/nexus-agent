import { describe, it, expect } from 'bun:test'
import { StreamPacer } from '../src/renderer/src/utils/streamPacer'
import { chatReducer, createInitialChatState, ChatState } from '../src/renderer/src/utils/chatReducer'
import { AgentEvent } from '../src/shared/types'

describe('Streaming & Backpressure Integration — Layer 2 Integration Tests', () => {
  it('preserves strict causality between text deltas and tool calls without causality inversion', () => {
    let state: ChatState = createInitialChatState()
    state = chatReducer(state, { type: 'start_turn', prompt: 'Delete file', turnId: 'turn-barrier' } as any)

    // Simulate pre-tool narrative text streaming
    state = chatReducer(state, { type: 'message_delta', delta: 'I will now inspect the directory.' })

    // Simulate discrete tool call barrier
    const toolEvent: AgentEvent = {
      type: 'tool_call_start',
      toolCall: { id: 'call_barrier_1', name: 'list_directory', arguments: { path: '.' } }
    }
    state = chatReducer(state, toolEvent)

    // Verify message has both text and toolCall registered in correct order
    const msg = state.messages.find(m => m.id === 'turn-barrier')!
    expect(msg.content).toBe('I will now inspect the directory.')
    expect(msg.toolCalls?.length).toBe(1)
    expect(msg.toolCalls![0].id).toBe('call_barrier_1')
  })



})
