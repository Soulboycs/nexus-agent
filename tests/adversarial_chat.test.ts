/**
 * Adversarial Test Suite & Boundary Verification (Zero-Trust)
 *
 * Covers:
 * 1. Out-of-order & Stray Events (No active turn, orphan protection)
 * 2. Ghost Completions & Status Flapping (Irreversible terminal states, no duplicated cards)
 * 3. High-Frequency Event Flooding & Burst Stress (1000 thinking + 1000 message deltas, string integrity)
 * 4. Adversarial Tool Lifecycles (Concurrency, interleaved completions, unknown toolCallId, duplicate tool starts)
 * 5. Rapid Interruption & Turn Takeover (Abort/idle, immediate new turn, previous turn auto-sealed)
 * 6. Non-intrusive Workspace Contract (Zero dialog, idempotent, valid absolute path)
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  createInitialChatState,
  chatReducer,
  ChatState,
  startUserTurn
} from '../src/renderer/src/utils/chatReducer'
import {
  AgentEvent,
  ToolCallPayload,
  ToolResultPayload
} from '../src/shared/types'

describe('Adversarial Boundary Tests: 1. 乱序与游离事件 (Out-of-order & Stray Events)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
  })

  it('safely drops stray thinking_delta when activeTurnId is null without crashing or creating orphan messages', () => {
    const originalState = { ...state }
    const nextState = chatReducer(state, {
      type: 'thinking_delta',
      delta: 'stray thinking chunk'
    })

    expect(nextState.messages.length).toBe(0)
    expect(nextState.activeTurnId).toBeNull()
    expect(nextState).toEqual(originalState)
  })

  it('safely drops stray message_delta when activeTurnId is null without state corruption', () => {
    const nextState = chatReducer(state, {
      type: 'message_delta',
      delta: 'ghost message arriving before turn starts'
    })

    expect(nextState.messages.length).toBe(0)
    expect(nextState.activeTurnId).toBeNull()
  })

  it('safely drops stray tool_call_start and tool_call_complete when activeTurnId is null', () => {
    const toolCall: ToolCallPayload = {
      id: 'stray_call_999',
      name: 'run_command',
      arguments: { command: 'dir' }
    }
    const nextState1 = chatReducer(state, {
      type: 'tool_call_start',
      toolCall
    })
    expect(nextState1.messages.length).toBe(0)

    const toolResult: ToolResultPayload = {
      toolCallId: 'stray_call_999',
      name: 'run_command',
      output: 'test output',
      isError: false
    }
    const nextState2 = chatReducer(nextState1, {
      type: 'tool_call_complete',
      result: toolResult
    })
    expect(nextState2.messages.length).toBe(0)
  })

  it('safely ignores stray error and status_change when no turn is active', () => {
    const nextState1 = chatReducer(state, {
      type: 'error',
      message: 'Uncorrelated network error'
    })
    expect(nextState1.messages.length).toBe(0)

    const nextState2 = chatReducer(nextState1, {
      type: 'status_change',
      status: 'completed'
    })
    expect(nextState2.messages.length).toBe(0)
    expect(nextState2.activeTurnId).toBeNull()
  })

  it('safely ignores non-existent activeTurnId reference without throwing exceptions', () => {
    const rogueState: ChatState = {
      messages: [
        {
          id: 'turn_real',
          role: 'assistant',
          content: 'I am legitimate',
          timestamp: Date.now()
        }
      ],
      activeTurnId: 'turn_ghost_not_in_messages'
    }

    const nextState = chatReducer(rogueState, {
      type: 'message_delta',
      delta: 'Targeting non-existent message'
    })

    // Should not crash, and real message remains untouched
    expect(nextState.messages.length).toBe(1)
    expect(nextState.messages[0].content).toBe('I am legitimate')
  })
})

describe('Adversarial Boundary Tests: 2. 重复完成与幽灵事件 (Ghost Completions & Flapping)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
    state = startUserTurn(state, 'Initial question', 'turn_ghost_1')
    state = chatReducer(state, {
      type: 'message_delta',
      delta: 'Valid assistant answer.'
    })
  })

  it('terminal status transition is strictly irreversible under status flapping', () => {
    // First completion
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()

    // Flapping status changes: completed -> error -> idle -> completed
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    state = chatReducer(state, { type: 'status_change', status: 'error' })
    state = chatReducer(state, { type: 'status_change', status: 'idle' })
    state = chatReducer(state, { type: 'status_change', status: 'completed' })

    expect(state.messages.length).toBe(2)
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.messages[1].content).toBe('Valid assistant answer.')
    expect(state.activeTurnId).toBeNull()
  })

  it('disallows late message_delta and late thinking_delta after completion from mutating finished messages', () => {
    // Turn is finalized
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    expect(state.activeTurnId).toBeNull()

    // Late arriving packets
    state = chatReducer(state, {
      type: 'message_delta',
      delta: ' LATE POISON PILL'
    })
    state = chatReducer(state, {
      type: 'thinking_delta',
      delta: ' LATE POISON THOUGHT'
    })

    expect(state.messages[1].content).toBe('Valid assistant answer.')
    expect(state.messages[1].thinking).toBe('')
    expect(state.messages.length).toBe(2)
  })

})

describe('Adversarial Boundary Tests: 3. 高频事件洪峰 (Event Flooding & Burst Stress)', () => {
  it('handles 1000 thinking_delta + 1000 message_delta bursts with zero truncation or packet drop', () => {
    let state = createInitialChatState()
    state = startUserTurn(state, 'Stress test prompt', 'turn_stress_1')

    const burstCount = 1000
    let expectedThinking = ''
    let expectedContent = ''

    const startTime = performance.now()

    // 1. Rapid fire thinking deltas
    for (let i = 0; i < burstCount; i++) {
      const chunk = `T${i}_`
      expectedThinking += chunk
      state = chatReducer(state, { type: 'thinking_delta', delta: chunk })
    }

    // 2. Rapid fire message deltas
    for (let i = 0; i < burstCount; i++) {
      const chunk = `M${i}_`
      expectedContent += chunk
      state = chatReducer(state, { type: 'message_delta', delta: chunk })
    }

    // 3. Finalize
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    const elapsedMs = performance.now() - startTime

    const asstMessage = state.messages.find((m) => m.id === 'turn_stress_1')!
    expect(asstMessage).toBeDefined()
    expect(asstMessage.thinking).toBe(expectedThinking)
    expect(asstMessage.content).toBe(expectedContent)
    expect(asstMessage.thinking?.length).toBe(expectedThinking.length)
    expect(asstMessage.content.length).toBe(expectedContent.length)
    expect(asstMessage.isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()

    // 2000 state transitions must be fast and bounded (< 500ms in Bun)
    expect(elapsedMs).toBeLessThan(500)
  })
})

describe('Adversarial Boundary Tests: 4. 工具生命周期对抗 (Adversarial Tool Lifecycles)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
    state = startUserTurn(state, 'Execute concurrent tools', 'turn_tool_1')
  })

  it('supports multiple concurrent tools starting in same turn and completing in arbitrary interleaved order', () => {
    const toolA: ToolCallPayload = { id: 'call_A', name: 'read_file', arguments: { path: 'a.txt' } }
    const toolB: ToolCallPayload = { id: 'call_B', name: 'read_file', arguments: { path: 'b.txt' } }
    const toolC: ToolCallPayload = { id: 'call_C', name: 'view_file', arguments: { path: 'c.txt' } }

    // Start A, B, C
    state = chatReducer(state, { type: 'tool_call_start', toolCall: toolA })
    state = chatReducer(state, { type: 'tool_call_start', toolCall: toolB })
    state = chatReducer(state, { type: 'tool_call_start', toolCall: toolC })

    const asstMsg = state.messages.find((m) => m.id === 'turn_tool_1')!
    expect(asstMsg.toolCalls?.length).toBe(3)
    expect(asstMsg.toolCalls?.map((t) => t.id)).toEqual(['call_A', 'call_B', 'call_C'])

    // Complete in reversed/interleaved order: B, then C, then A
    const resB: ToolResultPayload = { toolCallId: 'call_B', name: 'read_file', output: 'content B', isError: false }
    const resC: ToolResultPayload = { toolCallId: 'call_C', name: 'view_file', output: 'content C', isError: false }
    const resA: ToolResultPayload = { toolCallId: 'call_A', name: 'read_file', output: 'content A', isError: false }

    state = chatReducer(state, { type: 'tool_call_complete', result: resB })
    state = chatReducer(state, { type: 'tool_call_complete', result: resC })
    state = chatReducer(state, { type: 'tool_call_complete', result: resA })

    const updatedAsst = state.messages.find((m) => m.id === 'turn_tool_1')!
    expect(updatedAsst.toolResults?.length).toBe(3)
    expect(updatedAsst.toolResults?.find((r) => r.toolCallId === 'call_A')?.output).toBe('content A')
    expect(updatedAsst.toolResults?.find((r) => r.toolCallId === 'call_B')?.output).toBe('content B')
    expect(updatedAsst.toolResults?.find((r) => r.toolCallId === 'call_C')?.output).toBe('content C')
  })


  it('updates tool_call_complete in-place when duplicate completion events arrive for the same tool', () => {
    const tool: ToolCallPayload = { id: 'call_dup_res', name: 'view_file', arguments: { path: 'file.ts' } }
    state = chatReducer(state, { type: 'tool_call_start', toolCall: tool })

    const res1: ToolResultPayload = { toolCallId: 'call_dup_res', name: 'view_file', output: 'initial output', isError: false }
    const res2: ToolResultPayload = { toolCallId: 'call_dup_res', name: 'view_file', output: 'corrected output', isError: false }

    state = chatReducer(state, { type: 'tool_call_complete', result: res1 })
    let asst = state.messages.find((m) => m.id === 'turn_tool_1')!
    expect(asst.toolResults?.length).toBe(1)
    expect(asst.toolResults?.[0].output).toBe('initial output')

    // Second completion for same tool updates in place
    state = chatReducer(state, { type: 'tool_call_complete', result: res2 })
    asst = state.messages.find((m) => m.id === 'turn_tool_1')!
    expect(asst.toolResults?.length).toBe(1)
    expect(asst.toolResults?.[0].output).toBe('corrected output')
  })

  it('handles unknown toolCallId in tool_call_complete without corrupting toolCalls array', () => {
    const unkResult: ToolResultPayload = {
      toolCallId: 'call_alien_unknown',
      name: 'unregistered_tool',
      output: 'unexpected output',
      isError: true
    }

    state = chatReducer(state, { type: 'tool_call_complete', result: unkResult })
    const asst = state.messages.find((m) => m.id === 'turn_tool_1')!
    expect(asst.toolResults?.length).toBe(1)
    expect(asst.toolResults?.[0].toolCallId).toBe('call_alien_unknown')
    // toolCalls array remains empty and valid
    expect(asst.toolCalls?.length).toBe(0)
  })
})

describe('Adversarial Boundary Tests: 5. 用户快速打断与重试 (Rapid Interruption & Cancellation)', () => {
  it('user interrupts streaming via abort/idle, then immediately launches a new turn: old turn is sealed, new turn takes over', () => {
    let state = createInitialChatState()

    // 1. Turn 1 starts streaming
    state = startUserTurn(state, 'Prompt 1', 'turn_cancel_1')
    state = chatReducer(state, { type: 'thinking_delta', delta: 'Pondering...' })
    state = chatReducer(state, { type: 'message_delta', delta: 'Partial output...' })
    expect(state.messages[1].isStreaming).toBe(true)

    // 2. User hits Abort -> status_change: idle
    state = chatReducer(state, { type: 'status_change', status: 'idle' })
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()

    // 3. User immediately launches Turn 2
    state = startUserTurn(state, 'Prompt 2 (after abort)', 'turn_cancel_2')
    expect(state.messages.length).toBe(4) // user1, asst1, user2, asst2
    expect(state.messages[1].id).toBe('turn_cancel_1')
    expect(state.messages[1].isStreaming).toBe(false) // permanently frozen
    expect(state.messages[1].content).toBe('Partial output...')

    expect(state.messages[3].id).toBe('turn_cancel_2')
    expect(state.messages[3].isStreaming).toBe(true)
    expect(state.activeTurnId).toBe('turn_cancel_2')

    // 4. Stream into Turn 2
    state = chatReducer(state, { type: 'message_delta', delta: 'Fresh answer for prompt 2' })
    expect(state.messages[1].content).toBe('Partial output...') // Unaffected!
    expect(state.messages[3].content).toBe('Fresh answer for prompt 2')
  })

  it('defensively seals prior turn even if abort/idle event was dropped before new turn starts', () => {
    let state = createInitialChatState()

    // 1. Turn 1 starts streaming
    state = startUserTurn(state, 'Prompt 1', 'turn_unsealed_1')
    state = chatReducer(state, { type: 'message_delta', delta: 'Unfinished work' })
    expect(state.messages[1].isStreaming).toBe(true)

    // 2. New turn starts directly WITHOUT status_change: idle (e.g. dropped event)
    state = startUserTurn(state, 'Prompt 2', 'turn_unsealed_2')

    // Prior assistant message MUST have isStreaming defensively set to false
    expect(state.messages[1].isStreaming).toBe(false)
    // New assistant message MUST have isStreaming set to true
    expect(state.messages[3].isStreaming).toBe(true)
    expect(state.activeTurnId).toBe('turn_unsealed_2')
  })

  it('handles error action mid-stream: seals active turn and embeds error message', () => {
    let state = createInitialChatState()
    state = startUserTurn(state, 'Failing prompt', 'turn_err_1')
    state = chatReducer(state, { type: 'message_delta', delta: 'Working until crash...' })

    state = chatReducer(state, { type: 'error', message: 'API connection refused' })

    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.messages[1].content).toContain('Working until crash...')
    expect(state.messages[1].content).toContain('[Error: API connection refused]')
    expect(state.activeTurnId).toBeNull()
  })
})


describe('Adversarial Boundary Tests: 7. 极限边界注入与超大代码块洪峰 (Extreme Boundary Injections & Shock Burst)', () => {
  it('safely handles empty strings and dirty delta injections without corrupting message state', () => {
    let state = createInitialChatState()
    state = startUserTurn(state, 'Dirty input prompt', 'turn_dirty_1')

    // Empty delta injection
    state = chatReducer(state, { type: 'message_delta', delta: '' })
    state = chatReducer(state, { type: 'thinking_delta', delta: '' })

    let asst = state.messages.find(m => m.id === 'turn_dirty_1')!
    expect(asst.content).toBe('')
    expect(asst.thinking).toBe('')

    // Whitespace and escape characters
    state = chatReducer(state, { type: 'message_delta', delta: '   \n\t\r\0   ' })
    asst = state.messages.find(m => m.id === 'turn_dirty_1')!
    expect(asst.content).toBe('   \n\t\r\0   ')

    // Valid continuation
    state = chatReducer(state, { type: 'message_delta', delta: 'Valid Text' })
    asst = state.messages.find(m => m.id === 'turn_dirty_1')!
    expect(asst.content).toBe('   \n\t\r\0   Valid Text')
  })

  it('handles 10,000-character colossal code block shock burst in StreamPacer with bounded frames and zero corruption', () => {
    const { StreamPacer } = require('../src/renderer/src/utils/streamPacer')
    const pacer = new StreamPacer()

    // Generate 10,000 chars of code
    const line = 'function processStreamBlock(index: number): boolean { return index > 0; }\n'
    const colossalCode = line.repeat(140) // ~10,360 chars
    expect(colossalCode.length).toBeGreaterThanOrEqual(10000)

    pacer.setTarget(colossalCode)

    // First frame consumes large chunk under emergency backpressure
    const frame1 = pacer.step(16)
    expect(frame1.length).toBeGreaterThanOrEqual(20)

    // Drain under adaptive backpressure
    let frames = 1
    while (!pacer.isDone() && frames < 80) {
      pacer.step(16)
      frames++
    }

    // Must catch up within <= 50 frames (~800ms) for 10,000 characters
    expect(frames).toBeLessThan(50)
    expect(pacer.getDisplayed()).toBe(colossalCode)
    expect(pacer.getDisplayed().length).toBe(colossalCode.length)
  })

  it('prevents race conditions and state corruption under extreme concurrent startUserTurn spamming', () => {
    let state = createInitialChatState()

    // Simulate 50 rapid concurrent turn dispatches
    for (let i = 0; i < 50; i++) {
      state = startUserTurn(state, `Prompt ${i}`, `turn_race_${i}`)
    }

    // Total messages = 50 user + 50 assistant = 100 messages
    expect(state.messages.length).toBe(100)
    // Only the very last turn should be active and streaming
    expect(state.activeTurnId).toBe('turn_race_49')

    const lastAsst = state.messages.find(m => m.id === 'turn_race_49')!
    expect(lastAsst.isStreaming).toBe(true)

    // All prior assistant messages must be defensively sealed (isStreaming === false)
    const priorAssts = state.messages.filter(m => m.role === 'assistant' && m.id !== 'turn_race_49')
    expect(priorAssts.length).toBe(49)
    for (const pa of priorAssts) {
      expect(pa.isStreaming).toBe(false)
    }
  })
})

