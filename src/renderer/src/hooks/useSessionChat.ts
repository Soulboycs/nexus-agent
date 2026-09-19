import { useEffect, useReducer } from 'react'
import { chatReducer, createInitialChatState, type ChatAction, type ChatState } from '../utils/chatReducer'
import { sessionEventBus } from '../utils/sessionEventBus'

/**
 * 每会话独立的 chat 状态(计划 §8.1)。
 *
 * 每个 pane 一个 useReducer 实例;事件经 sessionEventBus 按 sessionId 精确投递,
 * A pane 流式时 B pane 零渲染。chatReducer 纯函数零改动直接复用。
 */
export function useSessionChat(sessionId: string): {
  state: ChatState
  dispatch: React.Dispatch<ChatAction>
} {
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState)
  useEffect(() => sessionEventBus.subscribe(sessionId, dispatch), [sessionId])
  return { state, dispatch }
}
