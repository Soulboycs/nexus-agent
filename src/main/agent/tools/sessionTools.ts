import type { AgentTool } from './ToolRegistry'
import { z } from 'zod'
import { SessionStore } from '../../session/sessionStore'

/**
 * session_read / session_list(§6.6 L2 引用语义的精确读取通道):
 * @会话 引用骨架是"地图",这两个工具是 agent 按需细读原文的手段——
 * 引用块省略的中段消息、精确原文,都经此获取。store 由工厂注入(bun 可测)。
 */

type StoreLike = Pick<SessionStore, 'getSession' | 'listSessions'>

type ToolContext = { workspaceRoot: string }

function fmtTranscript(messages: Array<{ role: string; content: string }>, lastN?: number): string {
  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  const slice = lastN && lastN > 0 ? convo.slice(-lastN) : convo
  if (slice.length === 0) return '(该会话暂无消息)'
  return slice.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n\n')
}

export function createSessionReadTool(getStore: () => StoreLike): AgentTool {
  return {
    name: 'session_read',
    description: () =>
      '精确读取某个会话的对话原文(用户/助手逐条)。当你收到"来自会话 X 的引用/提问"、' +
      '或引用块被省略需要细节时,先用 session_list 找到会话,再用本工具读取。' +
      'lastN 可限制只读最近 N 条(默认全部)。',
    searchHint: 'read session transcript conversation history 历史记录',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    parameters: z.object({
      sessionId: z.string().describe('目标会话 id(可从 session_list 或引用标注中获得)'),
      lastN: z.number().int().positive().optional().describe('只读最近 N 条消息(省略=全部)')
    }),
    execute: async ({ sessionId, lastN }: { sessionId: string; lastN?: number }) => {
      const store = getStore()
      const session = await store.getSession(sessionId)
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`)
      }
      return fmtTranscript(session.messages, lastN)
    }
  }
}

export function createSessionListTool(getStore: () => StoreLike): AgentTool {
  return {
    name: 'session_list',
    description: () =>
      '列出当前工作区的会话(id、标题、时间、消息数)。当用户提到"某个会话/刚才那个对话"而你不确定是哪个时,先用本工具枚举。',
    searchHint: 'list sessions enumerate conversations 会话列表',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    parameters: z.object({}),
    execute: async (_args: Record<string, never>, context: ToolContext) => {
      const store = getStore()
      const list = (await (store as unknown as {
        listSessions(ws?: string): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount?: number }>>
      }).listSessions(context.workspaceRoot)) || []
      if (list.length === 0) return '(当前工作区无会话)'
      return list
        .map((s) => `${s.id.slice(0, 8)}  ${s.title}  (${s.messageCount ?? 0} 条, ${new Date(s.updatedAt).toLocaleString()})  [id:${s.id}]`)
        .join('\n')
    }
  }
}
