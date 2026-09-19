import { normalizeKeyPath } from '@shared/paths'

/**
 * @ 提及解析(计划 §6.7,P4 委派):
 * 纯函数,供 FloatingInputDock 弹层与 ChatPane 发送解析共用。
 */

export type MentionType = 'session' | 'doc'

export interface MentionCandidate {
  type: MentionType
  /** session id 或文档路径 */
  id: string
  name: string
}

export interface MentionQuery {
  query: string
  /** '@' 在文本中的起始下标(插入替换用) */
  start: number
}

/** 光标处(文本末尾)是否处于 @ 提及态:提取 @ 后到文本末尾的查询词 */
export function extractMentionQuery(text: string): MentionQuery | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  const query = text.slice(at + 1)
  if (query.includes(' ') || query.includes('\n')) return null
  return { query, start: at }
}

/** 候选过滤:名称子串、大小写不敏感;空查询=全部(运行中排序由调用方决定) */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string
): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  if (!q) return candidates
  return candidates.filter((c) => c.name.toLowerCase().includes(q))
}

export interface ResolvedMentions {
  delegatedSessionIds: string[]
  docPaths: string[]
}

/** 发送解析:文本中的 @名称 → 委派会话 id 集 + 文档路径集(各去重) */
export function resolveMentions(
  text: string,
  candidates: MentionCandidate[]
): ResolvedMentions {
  const delegatedSessionIds: string[] = []
  const docPaths: string[] = []
  const re = /@([^\s@]+)/g
  for (const m of text.matchAll(re)) {
    const token = m[1].toLowerCase()
    const hit = candidates.find((c) => c.name.toLowerCase().includes(token))
    if (!hit) continue
    if (hit.type === 'session') {
      if (!delegatedSessionIds.includes(hit.id)) delegatedSessionIds.push(hit.id)
    } else if (!docPaths.some((p) => normalizeKeyPath(p) === normalizeKeyPath(hit.id))) {
      docPaths.push(hit.id)
    }
  }
  return { delegatedSessionIds, docPaths }
}
