import { AgentEvent, ChatMessage, MessageBlock } from '../../../../src/shared/types'

export interface ChatState {
  messages: ChatMessage[]
  activeTurnId: string | null
}

export function createInitialChatState(): ChatState {
  return {
    messages: [],
    activeTurnId: null
  }
}

/**
 * Normalizes a ChatMessage into an ordered list of MessageBlock.
 * If msg.blocks is already populated, returns it directly.
 * Otherwise, falls back to composing blocks from thinking, toolCalls, and content.
 */
export function normalizeMessageBlocks(msg: ChatMessage): MessageBlock[] {
  if (msg.blocks && msg.blocks.length > 0) {
    return msg.blocks
  }
  const blocks: MessageBlock[] = []
  if (msg.thinking) {
    blocks.push({
      type: 'thinking',
      id: `norm_th_${msg.id}`,
      content: msg.thinking
    })
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const result = msg.toolResults?.find((r) => r.toolCallId === tc.id)
      blocks.push({
        type: 'tool',
        id: tc.id,
        toolCall: tc,
        result,
        status: result ? (result.isError ? 'error' : 'completed') : 'completed'
      })
    }
  }
  if (msg.content) {
    blocks.push({
      type: 'text',
      id: `norm_tx_${msg.id}`,
      content: msg.content
    })
  }
  return blocks
}

/**
 * Initiates a user prompt and provisions a single streaming assistant placeholder.
 * Strictly idempotent: invoking with the same turnId will not create duplicate messages.
 */
export function startUserTurn(state: ChatState, prompt: string, turnId: string): ChatState {
  if (state.activeTurnId === turnId) {
    return state
  }

  const now = Date.now()
  const userMsgId = `user_${now}_${Math.random().toString(36).slice(2, 7)}`

  // Defensively seal any prior streaming messages so old turns never keep streaming
  const sanitizedMessages = state.messages.map((msg) =>
    msg.isStreaming ? { ...msg, isStreaming: false } : msg
  )

  return {
    messages: [
      ...sanitizedMessages,
      {
        id: userMsgId,
        role: 'user',
        content: prompt,
        timestamp: now
      },
      {
        id: turnId,
        role: 'assistant',
        content: '',
        thinking: '',
        toolCalls: [],
        toolResults: [],
        blocks: [],
        isStreaming: true,
        timestamp: now
      }
    ],
    activeTurnId: turnId
  }
}

export type ChatAction =
  | AgentEvent
  | { type: 'start_turn'; prompt: string; turnId: string }
  | { type: 'clear' }
  | { type: 'load_history'; messages: ChatMessage[] }

/**
 * Pure state reducer processing Agent streaming events in strict FIFO order.
 * Guarantees in-place updates, zero message duplication, and idempotency on status changes.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'start_turn') {
    return startUserTurn(state, action.prompt, action.turnId)
  }

  if (action.type === 'clear') {
    return createInitialChatState()
  }

  if (action.type === 'load_history') {
    return {
      messages: (action.messages || []).map((msg) => ({
        ...msg,
        isStreaming: false
      })),
      activeTurnId: null
    }
  }

  const activeId = state.activeTurnId

  switch (action.type) {
    case 'thinking_delta': {
      if (!activeId) return state
      return {
        ...state,
        messages: state.messages.map((msg) => {
          if (msg.id !== activeId) return msg
          const prevBlocks = msg.blocks || []
          const lastBlock = prevBlocks[prevBlocks.length - 1]
          let newBlocks: MessageBlock[]

          if (lastBlock && lastBlock.type === 'thinking') {
            newBlocks = [
              ...prevBlocks.slice(0, -1),
              { ...lastBlock, content: lastBlock.content + action.delta }
            ]
          } else {
            newBlocks = [
              ...prevBlocks,
              {
                type: 'thinking',
                id: `blk_th_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                content: action.delta
              }
            ]
          }

          return {
            ...msg,
            thinking: (msg.thinking || '') + action.delta,
            blocks: newBlocks
          }
        })
      }
    }

    case 'message_delta': {
      if (!activeId) return state
      return {
        ...state,
        messages: state.messages.map((msg) => {
          if (msg.id !== activeId) return msg
          const prevBlocks = msg.blocks || []
          const lastBlock = prevBlocks[prevBlocks.length - 1]
          let newBlocks: MessageBlock[]

          if (lastBlock && lastBlock.type === 'text') {
            newBlocks = [
              ...prevBlocks.slice(0, -1),
              { ...lastBlock, content: lastBlock.content + action.delta }
            ]
          } else {
            newBlocks = [
              ...prevBlocks,
              {
                type: 'text',
                id: `blk_tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                content: action.delta
              }
            ]
          }

          return {
            ...msg,
            content: (msg.content || '') + action.delta,
            blocks: newBlocks
          }
        })
      }
    }

    case 'tool_call_start': {
      if (!activeId) return state
      return {
        ...state,
        messages: state.messages.map((msg) => {
          if (msg.id !== activeId) return msg
          const existing = msg.toolCalls || []
          if (existing.some((tc) => tc.id === action.toolCall.id)) return msg

          let prevBlocks = [...(msg.blocks || [])]
          // Trim empty whitespace-only trailing text block
          if (prevBlocks.length > 0) {
            const lastBlock = prevBlocks[prevBlocks.length - 1]
            if (lastBlock.type === 'text' && !lastBlock.content.trim()) {
              prevBlocks.pop()
            }
          }

          const toolBlock: MessageBlock = {
            type: 'tool',
            id: action.toolCall.id,
            toolCall: action.toolCall,
            status: 'running'
          }

          return {
            ...msg,
            toolCalls: [...existing, action.toolCall],
            blocks: [...prevBlocks, toolBlock]
          }
        })
      }
    }

    case 'tool_call_complete': {
      if (!activeId) return state
      return {
        ...state,
        messages: state.messages.map((msg) => {
          if (msg.id !== activeId) return msg
          const existingResults = msg.toolResults || []
          const updatedResults = existingResults.some(
            (r) => r.toolCallId === action.result.toolCallId
          )
            ? existingResults.map((r) =>
                r.toolCallId === action.result.toolCallId ? action.result : r
              )
            : [...existingResults, action.result]

          const prevBlocks = msg.blocks || []
          const updatedBlocks = prevBlocks.map((b) => {
            if (b.type === 'tool' && b.id === action.result.toolCallId) {
              return {
                ...b,
                result: action.result,
                status: (action.result.isError ? 'error' : 'completed') as 'error' | 'completed'
              }
            }
            return b
          })

          return {
            ...msg,
            toolResults: updatedResults,
            blocks: updatedBlocks
          }
        })
      }
    }

    case 'status_change': {
      if (
        action.status === 'completed' ||
        action.status === 'error' ||
        action.status === 'idle'
      ) {
        if (!activeId) return state // Already finalized — completely idempotent
        return {
          messages: state.messages.map((msg) => {
            if (msg.id !== activeId) return msg

            // Settle any remaining running tool blocks
            const prevBlocks = msg.blocks || []
            const settledBlocks = prevBlocks.map((b) => {
              if (b.type === 'tool' && b.status === 'running') {
                return {
                  ...b,
                  status: (action.status === 'error' ? 'error' : 'completed') as 'error' | 'completed'
                }
              }
              return b
            })

            const finalContent =
              action.status === 'error' && action.message && !msg.content
                ? `[Error: ${action.message}]`
                : action.status === 'completed' &&
                  !msg.content &&
                  !msg.thinking &&
                  (!msg.toolCalls || msg.toolCalls.length === 0)
                ? '(No response returned from model)'
                : msg.content

            return {
              ...msg,
              content: finalContent,
              blocks: settledBlocks,
              isStreaming: false
            }
          }),
          activeTurnId: null
        }
      }
      return state
    }

    case 'error': {
      const targetId =
        activeId ||
        (state.messages.length > 0
          ? state.messages[state.messages.length - 1].id
          : null)
      if (!targetId) return state
      return {
        messages: state.messages.map((msg) =>
          msg.id === targetId
            ? {
                ...msg,
                content: msg.content
                  ? (msg.content.includes(action.message) ? msg.content : `${msg.content}\n\n[Error: ${action.message}]`)
                  : `[Error: ${action.message}]`,
                isStreaming: false
              }
            : msg
        ),
        activeTurnId: null
      }
    }

    default:
      return state
  }
}
