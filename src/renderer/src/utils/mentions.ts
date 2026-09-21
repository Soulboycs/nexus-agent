import { normalizeKeyPath } from '@shared/paths'
import type { ChatMessage } from '@shared/types'

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

/**
 * 会话可区分标签(M4,回应"@ 了分不清哪个"):
 * 真实标题 → 最近任务摘要 + 短编号 → 空会话标记 + 短编号;同名自动追加序号。
 * usedNames 由调用方在同一次候选构建中共享(跨会话去重)。
 */
export function buildSessionLabel(
  title: string,
  lastPrompt: string | undefined,
  sessionId: string,
  usedNames: Map<string, number>
): string {
  const shortId = sessionId.slice(-4)
  let base: string
  if (title && title !== 'New Conversation' && title !== 'New Session') {
    base = title
  } else if (lastPrompt && lastPrompt.trim()) {
    base = lastPrompt.trim().slice(0, 20) + '… #' + shortId
  } else {
    base = '空会话 #' + shortId
  }
  const n = usedNames.get(base) ?? 0
  usedNames.set(base, n + 1)
  return n === 0 ? base : `${base} #${n + 1}`
}

/** 剥离 @提及 token:优先按已知候选名整段移除(支持带空格的标题),残留孤立 @token 兜底移除 */
export function stripMentionTokens(text: string, candidates: MentionCandidate[]): string {
  let out = text
  for (const c of candidates) {
    out = out.split('@' + c.name).join(' ')
  }
  out = out.replace(/@[^\s@]+/g, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 会话引用块(§6.7 引用语义):@会话 → 该会话近期内容作为上下文注入当前任务。
 *
 * 长会话策略(三明治,确定性、零 LLM 成本):
 * - 全量可容纳 → 完整转录;
 * - 超预算 → 保留【任务源头】(第一条 user 消息,模型需要知道"当初要干什么")
 *   + 【近期状态】(尾部若干轮)+ 中段省略标记(模型知晓有空洞,可追问)。
 * 单条消息预览截断至 300 字符;详情由目标 agent 按需追问或用工具细读(L2)。
 */
export function buildSessionReferenceBlock(
  title: string,
  messages: ChatMessage[],
  maxChars = 4000
): string {
  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  const fmt = (m: ChatMessage): string => {
    const role = m.role === 'user' ? '用户' : '助手'
    const content = (m.content || '').replace(/\s+/g, ' ').slice(0, 300)
    return `${role}: ${content}`
  }

  const fullLines = convo.map(fmt)
  const header = `【引用会话:「${title}」近期内容】`
  if (header.length + fullLines.join('\n').length + 20 <= maxChars) {
    return `${header}\n${fullLines.join('\n') || '(空)'}`
  }

  // 三明治:源头(第一条 user)+ 尾部窗口 + 中段省略标记
  const firstUserIdx = convo.findIndex((m) => m.role === 'user')
  const head: string[] = []
  let headBudget = Math.floor(maxChars * 0.3)
  if (firstUserIdx >= 0) {
    const line = fmt(convo[firstUserIdx])
    head.push(line)
    headBudget -= line.length
    // 顺带带上源头的第一条回复(若有空间)
    if (firstUserIdx + 1 < convo.length) {
      const reply = fmt(convo[firstUserIdx + 1])
      if (reply.length <= headBudget) {
        head.push(reply)
        headBudget -= reply.length
      }
    }
  }

  const tail: string[] = []
  let tailBudget = maxChars - header.length - head.join('\n').length - 40
  for (let i = convo.length - 1; i > firstUserIdx + 1 && tailBudget > 0; i--) {
    const line = fmt(convo[i])
    if (line.length > tailBudget) break
    tail.unshift(line)
    tailBudget -= line.length
  }

  const omitted = convo.length - head.length - tail.length
  const parts = [header, ...head]
  if (omitted > 0) parts.push(`…(中间省略 ${omitted} 条消息)…`)
  parts.push(...tail)
  return parts.join('\n')
}
