import { useEffect, useReducer } from 'react'
import { chatReducer, createInitialChatState, type ChatAction, type ChatState } from '../utils/chatReducer'
import { sessionEventBus } from '../utils/sessionEventBus'

/** 跨 pane 本地动作注册表:委派时源 pane 给目标 pane 注入 start_turn(否则目标 pane 渲染不出回复流) */
const dispatchers = new Map<string, React.Dispatch<ChatAction>>()
export function dispatchToSession(sessionId: string, action: ChatAction): boolean {
  const d = dispatchers.get(sessionId)
  if (!d) return false
  d(action)
  return true
}

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
  useEffect(() => {
    dispatchers.set(sessionId, dispatch)
    const off = sessionEventBus.subscribe(sessionId, dispatch)
    return () => {
      off()
      if (dispatchers.get(sessionId) === dispatch) dispatchers.delete(sessionId)
    }
  }, [sessionId])
  return { state, dispatch }
}
