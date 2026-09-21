/**
 * TDD Test Suite: Chat Reducer & Event Ordering Engine
 *
 * Requirements:
 * 1. Deduplication & Idempotency:
 *    - Strict single-message lifecycle per turn.
 *    - Duplicate events (e.g. repeated status_change, repeated tool_call_start with same id) must be idempotent.
 *    - No duplicate assistant messages or orphaned preview blocks.
 * 2. Streaming Output & Event Ordering:
 *    - Strict FIFO sequence: thinking_delta -> message_delta -> tool_call -> tool_result -> status_change.
 *    - In-place stream accumulation on the active turn message.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  createInitialChatState,
  chatReducer,
  ChatState,
  startUserTurn,
  normalizeMessageBlocks
} from '../src/renderer/src/utils/chatReducer'
import { AgentEvent, ToolCallPayload, ToolResultPayload } from '../src/shared/types'

describe('Chat State Machine — TDD: 去重与幂等性 (Deduplication & Idempotency)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
  })

  it('creates exactly 1 user message and 1 assistant placeholder on startUserTurn', () => {
    state = startUserTurn(state, 'Hello assistant', 'turn-001')

    expect(state.messages.length).toBe(2)
    expect(state.messages[0].role).toBe('user')
    expect(state.messages[0].content).toBe('Hello assistant')
    expect(state.messages[1].role).toBe('assistant')
    expect(state.messages[1].id).toBe('turn-001')
    expect(state.messages[1].isStreaming).toBe(true)
    expect(state.activeTurnId).toBe('turn-001')
  })

  it('calling startUserTurn with the same turnId twice is idempotent', () => {
    state = startUserTurn(state, 'Hello assistant', 'turn-001')
    state = startUserTurn(state, 'Hello assistant', 'turn-001') // duplicate call

    expect(state.messages.length).toBe(2)
  })

  it('repeated status_change (completed, then idle) does NOT duplicate assistant messages', () => {
    state = startUserTurn(state, 'Test prompt', 'turn-001')

    // Stream some content
    state = chatReducer(state, { type: 'message_delta', delta: 'Here is the answer.' })

    // First completion event
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    expect(state.messages.length).toBe(2)
    expect(state.messages[1].content).toBe('Here is the answer.')
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()

    // Second event (idle) — must be completely idempotent
    state = chatReducer(state, { type: 'status_change', status: 'idle' })
    expect(state.messages.length).toBe(2) // Still exactly 2 messages, no duplicates!
    expect(state.messages[1].content).toBe('Here is the answer.')
  })

  it('repeated tool_call_start with same id does not register duplicate tools', () => {
    state = startUserTurn(state, 'Read file', 'turn-001')

    const tc: ToolCallPayload = { id: 'call_123', name: 'view_file', arguments: { path: 'test.ts' } }

    state = chatReducer(state, { type: 'tool_call_start', toolCall: tc })
    state = chatReducer(state, { type: 'tool_call_start', toolCall: tc }) // duplicate event

    expect(state.messages[1].toolCalls?.length).toBe(1)
  })

  it('repeated tool_call_complete updates in-place idempotently', () => {
    state = startUserTurn(state, 'Read file', 'turn-001')
    const tc: ToolCallPayload = { id: 'call_123', name: 'view_file', arguments: { path: 'test.ts' } }
    state = chatReducer(state, { type: 'tool_call_start', toolCall: tc })

    const res: ToolResultPayload = { toolCallId: 'call_123', name: 'view_file', output: 'content', isError: false }
    state = chatReducer(state, { type: 'tool_call_complete', result: res })
    state = chatReducer(state, { type: 'tool_call_complete', result: res }) // duplicate result event

    expect(state.messages[1].toolResults?.length).toBe(1)
  })

  it('handles start_turn action idempotently via chatReducer dispatch', () => {
    state = chatReducer(state, { type: 'start_turn', prompt: 'Hello via dispatch', turnId: 'turn-dispatch-1' } as any)
    expect(state.messages.length).toBe(2)
    expect(state.messages[0].role).toBe('user')
    expect(state.messages[0].content).toBe('Hello via dispatch')
    expect(state.messages[1].role).toBe('assistant')
    expect(state.activeTurnId).toBe('turn-dispatch-1')

    // Calling it again with same turnId is idempotent
    state = chatReducer(state, { type: 'start_turn', prompt: 'Hello via dispatch', turnId: 'turn-dispatch-1' } as any)
    expect(state.messages.length).toBe(2)
  })
})

describe('Chat State Machine — TDD: 流式输出与事件顺序性 (Streaming & Event Ordering)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
  })

  it('accumulates thinking_delta and message_delta in strict order within the active turn', () => {
    state = startUserTurn(state, 'How does this work?', 'turn-002')

    // 1. Thinking phase
    state = chatReducer(state, { type: 'thinking_delta', delta: 'Let me ' })
    state = chatReducer(state, { type: 'thinking_delta', delta: 'think about it.' })

    const asstMsg = state.messages[1]
    expect(asstMsg.thinking).toBe('Let me think about it.')
    expect(asstMsg.content).toBe('')

    // 2. Message response phase
    state = chatReducer(state, { type: 'message_delta', delta: 'Here is ' })
    state = chatReducer(state, { type: 'message_delta', delta: 'the explanation.' })

    expect(state.messages[1].thinking).toBe('Let me think about it.')
    expect(state.messages[1].content).toBe('Here is the explanation.')

    // 3. Finish
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    expect(state.messages[1].isStreaming).toBe(false)
  })

  it('interleaves tool calls and subsequent answer in strict chronological order', () => {
    state = startUserTurn(state, 'Check files', 'turn-003')

    // Step 1: Tool call
    const tc: ToolCallPayload = { id: 'call_1', name: 'list_directory', arguments: { path: '.' } }
    state = chatReducer(state, { type: 'tool_call_start', toolCall: tc })
    expect(state.messages[1].toolCalls?.length).toBe(1)
    expect(state.messages[1].toolResults?.length).toBe(0)

    // Tool finishes
    const tr: ToolResultPayload = { toolCallId: 'call_1', name: 'list_directory', output: 'file1.ts\nfile2.ts', isError: false }
    state = chatReducer(state, { type: 'tool_call_complete', result: tr })
    expect(state.messages[1].toolResults?.length).toBe(1)

    // Step 2: Final message based on tool result
    state = chatReducer(state, { type: 'message_delta', delta: 'Found 2 files: file1.ts and file2.ts' })
    expect(state.messages[1].content).toBe('Found 2 files: file1.ts and file2.ts')

    // Complete
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()
  })

  it('handles abort cleanly: finalizes current streaming message without duplicating', () => {
    state = startUserTurn(state, 'Long task', 'turn-004')
    state = chatReducer(state, { type: 'message_delta', delta: 'Partial text...' })

    // User aborts -> status_change idle
    state = chatReducer(state, { type: 'status_change', status: 'idle' })

    expect(state.messages[1].content).toBe('Partial text...')
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()

    // Next turn starts cleanly
    state = startUserTurn(state, 'New task', 'turn-005')
    expect(state.messages.length).toBe(4) // 2 previous + 2 new
    expect(state.activeTurnId).toBe('turn-005')
  })

  it('resets state completely on clear action', () => {
    state = startUserTurn(state, 'Clear me', 'turn-clear')
    expect(state.messages.length).toBe(2)
    state = chatReducer(state, { type: 'clear' })
    expect(state.messages.length).toBe(0)
    expect(state.activeTurnId).toBeNull()
  })

  it('preserves error message in assistant content on status_change error', () => {
    state = startUserTurn(state, 'Fail me', 'turn-err-1')
    state = chatReducer(state, { type: 'status_change', status: 'error', message: 'API rate limit exceeded' })
    expect(state.messages[1].content).toBe('[Error: API rate limit exceeded]')
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()
  })

  it('attaches late error event to last assistant message even after activeTurnId is null', () => {
    state = startUserTurn(state, 'Fail late', 'turn-err-2')
    // First closed by status_change
    state = chatReducer(state, { type: 'status_change', status: 'error' })
    expect(state.activeTurnId).toBeNull()
    // Then late error event arrives
    state = chatReducer(state, { type: 'error', message: 'Network disconnected' })
    expect(state.messages[1].content).toContain('[Error: Network disconnected]')
  })
})

describe('Chat State Machine — MessageBlock 有序时序流水线 (Interleaved Blocks)', () => {
  let state: ChatState

  beforeEach(() => {
    state = createInitialChatState()
  })

  it('interleaves text, tools, and subsequent text into an ordered blocks array', () => {
    state = startUserTurn(state, '排查跨账号串线', 'turn-blk-1')

    // 1. First text paragraph
    state = chatReducer(state, { type: 'message_delta', delta: '能理解，属于跨账号数据串线。\n' })
    state = chatReducer(state, { type: 'message_delta', delta: '先找到具体串线点，再修。' })

    // 2. Tool 1 start & complete
    state = chatReducer(state, {
      type: 'tool_call_start',
      toolCall: {
        id: 'tc-001',
        name: 'view_file',
        arguments: { filePath: 'src/auth/session.ts', toolAction: '调查跨账户数据泄漏并查找用户缓存逻辑' }
      }
    })
    state = chatReducer(state, {
      type: 'tool_call_complete',
      result: {
        toolCallId: 'tc-001',
        name: 'view_file',
        output: 'session code...',
        isError: false
      }
    })

    // 3. Second text paragraph
    state = chatReducer(state, { type: 'message_delta', delta: '从现在的证据看，更可能是身份合并逻辑问题。' })

    // 4. Tool 2 start
    state = chatReducer(state, {
      type: 'tool_call_start',
      toolCall: {
        id: 'tc-002',
        name: 'run_command',
        arguments: { command: 'bun test', toolAction: '排查跨账户数据泄漏原因' }
      }
    })

    const asst = state.messages[1]
    expect(asst.blocks).toBeDefined()
    expect(asst.blocks!.length).toBe(4)

    // Block 0: text
    expect(asst.blocks![0].type).toBe('text')
    if (asst.blocks![0].type === 'text') {
      expect(asst.blocks![0].content).toBe('能理解，属于跨账号数据串线。\n先找到具体串线点，再修。')
    }

    // Block 1: tool (completed)
    expect(asst.blocks![1].type).toBe('tool')
    if (asst.blocks![1].type === 'tool') {
      expect(asst.blocks![1].id).toBe('tc-001')
      expect(asst.blocks![1].status).toBe('completed')
      expect(asst.blocks![1].toolCall.arguments.toolAction).toBe('调查跨账户数据泄漏并查找用户缓存逻辑')
    }

    // Block 2: text
    expect(asst.blocks![2].type).toBe('text')
    if (asst.blocks![2].type === 'text') {
      expect(asst.blocks![2].content).toBe('从现在的证据看，更可能是身份合并逻辑问题。')
    }

    // Block 3: tool (running)
    expect(asst.blocks![3].type).toBe('tool')
    if (asst.blocks![3].type === 'tool') {
      expect(asst.blocks![3].id).toBe('tc-002')
      expect(asst.blocks![3].status).toBe('running')
    }

    // Dual-track verification: asst.content and asst.toolCalls are also preserved
    expect(asst.content).toContain('先找到具体串线点，再修。从现在的证据看')
    expect(asst.toolCalls?.length).toBe(2)
  })

  it('normalizes legacy message without blocks into ordered blocks seamlessly', () => {
    const legacyMsg: any = {
      id: 'legacy-001',
      role: 'assistant',
      thinking: 'Thinking about the issue...',
      toolCalls: [
        { id: 'call-1', name: 'view_file', arguments: { filePath: 'foo.ts' } }
      ],
      toolResults: [
        { toolCallId: 'call-1', name: 'view_file', output: 'content', isError: false }
      ],
      content: 'Here is the diagnosis.',
      timestamp: 12345
    }

    const blocks = normalizeMessageBlocks(legacyMsg)
    expect(blocks.length).toBe(3)
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[1].type).toBe('tool')
    expect(blocks[2].type).toBe('text')
  })

  // ─── 2026-09-18 变异审计补测：猎杀存活体 R2 / R6 ───

  it('R2: shows placeholder on completed turn with empty content (no silent blank cards)', () => {
    state = startUserTurn(state, 'Are you there?', 'turn_empty_1')
    // 无任何 message_delta/thinking_delta 即完成 —— 空响应场景
    state = chatReducer(state, { type: 'status_change', status: 'completed' })
    const asst = state.messages.find((m) => m.id === 'turn_empty_1')!
    expect(asst.isStreaming).toBe(false)
    expect(asst.content).toBe('(No response returned from model)') // 兜底文案缺失 = 气泡空白回归
  })

  it('R6: appends identical error message only once when duplicate error events arrive (transport retry)', () => {
    state = startUserTurn(state, 'Retry me', 'turn_err_dup')
    state = chatReducer(state, { type: 'message_delta', delta: 'Partial answer before failure' })
    // 传输层重试导致同一 error 事件重复到达两次
    state = chatReducer(state, { type: 'error', message: 'API connection reset' })
    state = chatReducer(state, { type: 'error', message: 'API connection reset' })
    const asst = state.messages.find((m) => m.id === 'turn_err_dup')!
    const occurrences = asst.content.split('[Error: API connection reset]').length - 1
    expect(occurrences).toBe(1) // 去重失效 = [Error: X] 刷屏回归
    expect(asst.content).toContain('Partial answer before failure')
  })

  it('load_history replaces messages cleanly and clears activeTurnId', () => {
    state = startUserTurn(state, 'Old turn', 'turn_old')
    expect(state.messages.length).toBe(2)

    const historicalMessages = [
      { id: 'h1', role: 'user' as const, content: 'Historical prompt', timestamp: 1000 },
      { id: 'h2', role: 'assistant' as const, content: 'Historical answer', isStreaming: true, timestamp: 1001 }
    ]

    state = chatReducer(state, { type: 'load_history', messages: historicalMessages })

    expect(state.messages.length).toBe(2)
    expect(state.messages[0].content).toBe('Historical prompt')
    expect(state.messages[1].content).toBe('Historical answer')
    // Crucial: ensures loaded messages have isStreaming set to false so no spinner lingers
    expect(state.messages[1].isStreaming).toBe(false)
    expect(state.activeTurnId).toBeNull()
  })

  it('clear action resets chat state to empty with null activeTurnId', () => {
    state = startUserTurn(state, 'Will clear', 'turn_clear')
    expect(state.messages.length).toBe(2)

    state = chatReducer(state, { type: 'clear' })
    expect(state.messages.length).toBe(0)
    expect(state.activeTurnId).toBeNull()
  })
})


describe('local_note — P4 委派本地记录(不悬空占位)', () => {
  it('追加一条 user 角色的本地说明消息,不产生流式占位、不影响 activeTurnId', async () => {
    const { chatReducer, createInitialChatState } = await import('../src/renderer/src/utils/chatReducer')
    let st = createInitialChatState()
    st = chatReducer(st, { type: 'local_note', text: '已委派给会话 X: 帮我审查' } as never)
    expect(st.messages.length).toBe(1)
    expect(st.messages[0].role).toBe('user')
    expect(st.messages[0].content).toContain('已委派给会话 X')
    expect(st.activeTurnId).toBeNull()
    expect(st.messages[0].isStreaming ?? false).toBe(false)
  })
})
