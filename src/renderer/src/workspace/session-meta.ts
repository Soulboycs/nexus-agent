import { create } from 'zustand'

/**
 * 会话元数据(标题等)跨组件共享:
 * - 标签页标题与 @ 提及候选使用同一来源(buildSessionLabel 风格),保证"所见即所@"
 * - ChatPane 装载/派生标题时写入;version 供 TabBar 感知变更后重渲染
 */
interface SessionMetaState {
  titles: Record<string, string>
  version: number
  setSessionTitle(sessionId: string, title: string): void
}

export const useSessionMetaStore = create<SessionMetaState>()((set, get) => ({
  titles: {},
  version: 0,
  setSessionTitle(sessionId, title) {
    if (!sessionId || !title) return
    if (get().titles[sessionId] === title) return
    set({ titles: { ...get().titles, [sessionId]: title }, version: get().version + 1 })
  }
}))
