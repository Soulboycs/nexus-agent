import fs from 'fs/promises'
import { existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { ChatMessage, SessionRecord, SessionSummary, MessageBlock, ToolCallPayload } from '../../shared/types'
import { extractSessionTitle } from '../../shared/sessionUtils'
import { atomicWriteFile } from '../docx/atomic-write'

export { extractSessionTitle }

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 1:1 validation with Claude Code's validateUuid in sessionStoragePortable.ts.
 */
export function validateUuid(maybeUuid: unknown): string | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? maybeUuid : null
}

/** Buffer size for lightweight head/tail metadata reads (1:1 with Claude Code LITE_READ_BUF_SIZE) */
export const LITE_READ_BUF_SIZE = 65536 // 64KB

/** Maximum length for sanitized project folder names (1:1 with Claude Code MAX_SANITIZED_LENGTH) */
export const MAX_SANITIZED_LENGTH = 200

// ── Claude Code 1:1 Complete Entry Types (D:/claude code/src/types/logs.ts:297-317) ──

export interface SummaryMessage {
  type: 'summary'
  leafUuid: string
  summary: string
}

export interface CustomTitleMessage {
  type: 'custom-title'
  sessionId: string
  customTitle: string
}

export interface AiTitleMessage {
  type: 'ai-title'
  sessionId: string
  aiTitle: string
}

export interface LastPromptMessage {
  type: 'last-prompt'
  sessionId: string
  lastPrompt: string
}

export interface TaskSummaryMessage {
  type: 'task-summary'
  sessionId: string
  summary: string
  timestamp: string
}

export interface TagMessage {
  type: 'tag'
  sessionId: string
  tag: string
}

export interface AgentNameMessage {
  type: 'agent-name'
  sessionId: string
  agentName: string
}

export interface AgentColorMessage {
  type: 'agent-color'
  sessionId: string
  agentColor: string
}

export interface AgentSettingMessage {
  type: 'agent-setting'
  sessionId: string
  agentSetting: string
}

export interface PRLinkMessage {
  type: 'pr-link'
  sessionId: string
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
}

export interface ModeEntry {
  type: 'mode'
  sessionId: string
  mode: 'coordinator' | 'normal'
}

export interface PersistedWorktreeSession {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

export interface WorktreeStateEntry {
  type: 'worktree-state'
  sessionId: string
  worktreeSession: PersistedWorktreeSession | null
}

export interface ContentReplacementEntry {
  type: 'content-replacement'
  sessionId: string
  agentId?: string
  replacements: Array<Record<string, unknown>>
}

export interface FileHistorySnapshotMessage {
  type: 'file-history-snapshot'
  messageId: string
  snapshot: Record<string, unknown>
  isSnapshotUpdate?: boolean
}

export interface AttributionSnapshotMessage {
  type: 'attribution-snapshot'
  messageId: string
  surface?: string
  fileStates?: Record<string, unknown>
  promptCount?: number
  promptCountAtLastCommit?: number
  permissionPromptCount?: number
  permissionPromptCountAtLastCommit?: number
  escapeCount?: number
  escapeCountAtLastCommit?: number
}

export interface QueueOperationMessage {
  type: 'queue-operation'
  operation?: string
  timestamp?: string
  [key: string]: unknown
}

export interface SpeculationAcceptMessage {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

export interface ContextCollapseCommitEntry {
  type: 'marble-origami-commit'
  sessionId: string
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

export interface ContextCollapseSnapshotEntry {
  type: 'marble-origami-snapshot'
  sessionId: string
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'attachment' | 'system'
  uuid: string
  parentUuid: string | null
  logicalParentUuid?: string | null
  sessionId: string
  cwd: string
  timestamp: string
  version?: string
  userType?: string
  entrypoint?: string
  isSidechain?: boolean
  gitBranch?: string
  slug?: string
  agentId?: string
  teamName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  promptId?: string
  forkedFrom?: {
    sessionId: string
    messageUuid: string
  }
  message: {
    role: 'user' | 'assistant' | 'system'
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
    blocks?: MessageBlock[]
    toolCalls?: ToolCallPayload[]
    thinking?: string
    [key: string]: unknown
  }
}

/** 1:1 Complete Entry Union matching D:/claude code/src/types/logs.ts:297-317 */
export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | QueueOperationMessage
  | SpeculationAcceptMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry
  | ContextCollapseCommitEntry
  | ContextCollapseSnapshotEntry

// Backward-compatibility aliases
export type MessageTranscriptEntry = TranscriptMessage
export type UserTranscriptEntry = MessageTranscriptEntry & { type: 'user' }
export type AssistantTranscriptEntry = MessageTranscriptEntry & { type: 'assistant' }
export type CustomTitleEntry = CustomTitleMessage
export type AiTitleEntry = AiTitleMessage
export type SummaryEntry = SummaryMessage
export type TranscriptEntry = Entry

// ── 1:1 Lightweight JSON Field & Prompt Extraction (sessionStoragePortable.ts) ──

/**
 * Unescape a JSON string value extracted as raw text.
 * 1:1 with Claude Code sessionStoragePortable.ts unescapeJsonString.
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * 1:1 with Claude Code sessionStoragePortable.ts extractJsonStringField.
 */
export function extractJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * Finds the LAST occurrence of a JSON string field.
 * 1:1 with Claude Code sessionStoragePortable.ts extractLastJsonStringField.
 * Essential for fields appended later (customTitle, aiTitle, etc.).
 */
export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * Extracts the first meaningful user prompt from a JSONL head chunk.
 * 1:1 with Claude Code sessionStoragePortable.ts extractFirstPromptFromHead.
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (
      !line.includes('"type":"user"') &&
      !line.includes('"type": "user"') &&
      !line.includes('"role":"user"') &&
      !line.includes('"role": "user"')
    ) {
      continue
    }
    if (
      line.includes('"tool_result"') ||
      line.includes('"isMeta":true') ||
      line.includes('"isCompactSummary":true')
    ) {
      continue
    }

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      let content: unknown = undefined
      if (entry.type === 'user') {
        const msg = entry.message as Record<string, unknown> | undefined
        content = msg?.content
      } else if (entry.t === 'msg' && entry.role === 'user') {
        content = entry.content
      } else if (entry.role === 'user') {
        content = entry.content
      }
      if (!content) continue

      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) continue

        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '…'
        }
        return result
      }
    } catch {
      continue
    }
  }
  if (commandFallback) return commandFallback
  return ''
}

/**
 * Sanitizes a workspace project directory path into a valid, safe directory name.
 * 1:1 alignment with Claude Code's sanitizePath in sessionStoragePortable.ts.
 *
 * Example:
 *   "D:\Agent" -> "D--Agent"
 *   "D:/ProjectB" -> "D--ProjectB"
 *   "/Users/admin/work" -> "-Users-admin-work"
 */
export function sanitizePath(name: string): string {
  if (!name) return 'default'
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  const hashStr = Math.abs(hash).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hashStr}`
}

/**
 * Type guard and validator ensuring only meaningful conversation messages
 * are persisted to JSONL storage (1:1 alignment with Claude Code's isTranscriptMessage).
 *
 * Ephemeral UI states (empty assistant placeholders, progress ticks, etc.)
 * are explicitly rejected to prevent transcript corruption and bloating.
 */
export function isTranscriptMessage(msg: unknown): msg is ChatMessage {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'string' || !m.id) return false
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system' && m.role !== 'attachment') return false

  const hasContent = typeof m.content === 'string' && m.content.trim().length > 0
  const hasBlocks = Array.isArray(m.blocks) && m.blocks.length > 0
  const hasToolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
  const hasThinking = typeof m.thinking === 'string' && m.thinking.trim().length > 0

  if (!hasContent && !hasBlocks && !hasToolCalls && !hasThinking) {
    return false
  }

  return true
}

/**
 * Reconstruct a chronological conversation thread from a DAG of messages.
 * (1:1 alignment with Claude Code's buildConversationChain in sessionStorage.ts).
 */
export function buildConversationChain(
  messages: ChatMessage[],
  activeLeafId?: string | null
): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  const hasDagLinks = messages.some((m) => m.parentId !== undefined)
  if (!hasDagLinks) {
    return [...messages]
  }

  const map = new Map<string, ChatMessage>()
  for (const msg of messages) {
    map.set(msg.id, msg)
  }

  let leaf: ChatMessage | undefined
  if (activeLeafId && map.has(activeLeafId)) {
    leaf = map.get(activeLeafId)
  }

  if (!leaf) {
    const referencedAsParent = new Set<string>()
    for (const msg of messages) {
      if (msg.parentId) {
        referencedAsParent.add(msg.parentId)
      }
    }
    const terminalMessages = messages.filter((m) => !referencedAsParent.has(m.id))
    if (terminalMessages.length > 0) {
      terminalMessages.sort((a, b) => b.timestamp - a.timestamp)
      leaf = terminalMessages[0]
    } else {
      leaf = messages[messages.length - 1]
    }
  }

  if (!leaf) return [...messages]

  const chain: ChatMessage[] = []
  const seen = new Set<string>()
  let curr: ChatMessage | undefined = leaf

  while (curr) {
    if (seen.has(curr.id)) {
      console.warn(`[SessionStore] Cycle detected in message DAG at ${curr.id}. Returning partial chain.`)
      break
    }
    seen.add(curr.id)
    chain.push(curr)
    curr = curr.parentId ? map.get(curr.parentId) : undefined
  }

  chain.reverse()
  return chain
}

export interface MetaLine {
  t?: 'meta' | 'meta_update'
  type?: string
  id: string
  title: string
  customTitle?: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  activeLeafId?: string | null
  tag?: string
  agentName?: string
  agentColor?: string
  mode?: 'coordinator' | 'normal'
  lastPrompt?: string
  forkedFrom?: {
    sessionId: string
    messageUuid: string
  }
}

export class SessionStore {
  private baseDir: string
  private indexCache: SessionSummary[] | null = null
  private initialized = false

  constructor(customDir?: string) {
    if (customDir) {
      this.baseDir = customDir
    } else {
      let userDir = ''
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          userDir = join(app.getPath('userData'), 'sessions')
        }
      } catch {
        // Fallback for tests or non-electron runtimes
      }
      if (!userDir) {
        userDir = join(os.homedir(), '.nexus-agent', 'sessions')
      }
      this.baseDir = userDir
    }
  }

  public async init(): Promise<void> {
    if (this.initialized) return
    const projectsDir = this.getProjectsDir()
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true })
    }
    await this.refreshIndex()
    await this.reconcileIndex()
    this.initialized = true
  }

  public getProjectsDir(): string {
    return join(this.baseDir, 'projects')
  }

  public getProjectDir(workspacePath?: string): string {
    return join(this.getProjectsDir(), sanitizePath(workspacePath || 'default'))
  }

  private get indexPath(): string {
    return join(this.baseDir, 'index.json')
  }

  public async findSessionFilePath(id: string, workspacePath?: string): Promise<string | null> {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filename = `${safeId}.jsonl`

    if (workspacePath) {
      const p = join(this.getProjectDir(workspacePath), filename)
      if (existsSync(p)) return p
    }

    if (this.indexCache) {
      const cached = this.indexCache.find((s) => s.id === id)
      if (cached?.workspacePath) {
        const p = join(this.getProjectDir(cached.workspacePath), filename)
        if (existsSync(p)) return p
      }
    }

    const projectsDir = this.getProjectsDir()
    if (existsSync(projectsDir)) {
      try {
        const dirs = await fs.readdir(projectsDir, { withFileTypes: true })
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const candidate = join(projectsDir, dir.name, filename)
            if (existsSync(candidate)) return candidate
          }
        }
      } catch {}
    }

    const flatPath = join(this.baseDir, filename)
    if (existsSync(flatPath)) return flatPath

    return null
  }

  private getSessionTargetFilePath(id: string, workspacePath?: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
    const projectDir = this.getProjectDir(workspacePath)
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
    return join(projectDir, `${safeId}.jsonl`)
  }

  // ── JSONL Pure Append-Only Helpers (ZERO TRUNCATION) ──────────

  /** Parse a .jsonl file into { meta, messages } with crash resiliency and dual compatibility */
  private async parseSessionFile(filePath: string): Promise<{ meta: MetaLine; messages: ChatMessage[] } | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      const fileStat = await fs.stat(filePath).catch(() => null)
      const filename = filePath.split(/[/\\]/).pop() || ''
      const safeId = filename.replace(/\.jsonl$/, '')

      if (lines.length === 0) {
        return {
          meta: {
            id: safeId,
            title: 'New Conversation',
            workspacePath: '',
            createdAt: fileStat?.birthtimeMs || Date.now(),
            updatedAt: fileStat?.mtimeMs || Date.now(),
            activeLeafId: null
          },
          messages: []
        }
      }

      let id: string | null = null
      let workspacePath = ''
      let customTitle: string | undefined = undefined
      let aiTitle: string | undefined = undefined
      let activeLeafId: string | null = null
      let createdAt = 0
      let updatedAt = 0
      let tag: string | undefined = undefined
      let agentName: string | undefined = undefined
      let agentColor: string | undefined = undefined
      let mode: 'coordinator' | 'normal' | undefined = undefined
      let lastPrompt: string | undefined = undefined
      let forkedFrom: { sessionId: string; messageUuid: string } | undefined = undefined
      const messages: ChatMessage[] = []

      for (const line of lines) {
        try {
          const obj = JSON.parse(line)

          // 1. Claude Code 1:1 Complete Entry Format Handling (20 types)
          if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system' || obj.type === 'attachment') {
            if (obj.sessionId && !id) id = obj.sessionId
            if (obj.cwd && !workspacePath) workspacePath = obj.cwd
            if (obj.forkedFrom) forkedFrom = obj.forkedFrom
            const msgTime = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            if (!createdAt || msgTime < createdAt) createdAt = msgTime
            if (msgTime > updatedAt) updatedAt = msgTime

            let content = ''
            if (typeof obj.message?.content === 'string') {
              content = obj.message.content
            } else if (Array.isArray(obj.message?.content)) {
              content = obj.message.content.map((c: any) => c.text || '').join('')
            }

            const chatMsg: ChatMessage = {
              id: obj.uuid || obj.id || `msg_${Date.now()}`,
              parentId: obj.parentUuid !== undefined ? obj.parentUuid : (obj.parentId ?? null),
              role: obj.message?.role || obj.type,
              content,
              blocks: obj.message?.blocks,
              toolCalls: obj.message?.toolCalls,
              thinking: obj.message?.thinking,
              timestamp: msgTime,
              isStreaming: false
            }
            if (isTranscriptMessage(chatMsg)) {
              messages.push(chatMsg)
              activeLeafId = chatMsg.id
            }
          } else if (obj.type === 'custom-title') {
            if (obj.sessionId && !id) id = obj.sessionId
            customTitle = obj.customTitle
          } else if (obj.type === 'ai-title') {
            if (obj.sessionId && !id) id = obj.sessionId
            aiTitle = obj.aiTitle
          } else if (obj.type === 'summary') {
            if (obj.leafUuid) activeLeafId = obj.leafUuid
          } else if (obj.type === 'last-prompt') {
            if (obj.sessionId && !id) id = obj.sessionId
            lastPrompt = obj.lastPrompt
          } else if (obj.type === 'tag') {
            if (obj.sessionId && !id) id = obj.sessionId
            tag = obj.tag
          } else if (obj.type === 'agent-name') {
            if (obj.sessionId && !id) id = obj.sessionId
            agentName = obj.agentName
          } else if (obj.type === 'agent-color') {
            if (obj.sessionId && !id) id = obj.sessionId
            agentColor = obj.agentColor
          } else if (obj.type === 'agent-setting') {
            if (obj.sessionId && !id) id = obj.sessionId
          } else if (obj.type === 'mode') {
            if (obj.sessionId && !id) id = obj.sessionId
            mode = obj.mode
          } else if (obj.type === 'worktree-state') {
            if (obj.sessionId && !id) id = obj.sessionId
          } else if (obj.type === 'pr-link') {
            if (obj.sessionId && !id) id = obj.sessionId
          } else if (
            obj.type === 'file-history-snapshot' ||
            obj.type === 'attribution-snapshot' ||
            obj.type === 'queue-operation' ||
            obj.type === 'speculation-accept' ||
            obj.type === 'content-replacement' ||
            obj.type === 'marble-origami-commit' ||
            obj.type === 'marble-origami-snapshot'
          ) {
            // Recognized 1:1 Claude Code native auxiliary entries - gracefully preserved
            if (obj.sessionId && !id) id = obj.sessionId
          }
          // 2. Legacy format support (t: 'meta' | 'msg' | 'meta_update')
          else if (obj.t === 'meta') {
            if (obj.id) id = obj.id
            if (obj.title) customTitle = obj.customTitle || obj.title
            if (obj.workspacePath) workspacePath = obj.workspacePath
            if (obj.createdAt) createdAt = obj.createdAt
            if (obj.updatedAt) updatedAt = obj.updatedAt
            if (obj.activeLeafId) activeLeafId = obj.activeLeafId
          } else if (obj.t === 'meta_update') {
            if (obj.title) customTitle = obj.customTitle || obj.title
            if (obj.activeLeafId) activeLeafId = obj.activeLeafId
            if (obj.updatedAt) updatedAt = obj.updatedAt
          } else if (obj.t === 'msg') {
            const { t: _, ...msg } = obj
            const chatMsg = msg as ChatMessage
            if (isTranscriptMessage(chatMsg)) {
              messages.push({ ...chatMsg, isStreaming: false })
              activeLeafId = chatMsg.id
            }
          }
        } catch {
          // Skip malformed lines gracefully
        }
      }

      if (!id) id = safeId
      if (!createdAt) createdAt = fileStat?.birthtimeMs || Date.now()
      if (!updatedAt) updatedAt = fileStat?.mtimeMs || Date.now()

      const firstPrompt = extractFirstPromptFromHead(raw.slice(0, LITE_READ_BUF_SIZE))
      const title =
        customTitle ||
        aiTitle ||
        (firstPrompt ? (firstPrompt.length > 30 ? firstPrompt.slice(0, 27) + '...' : firstPrompt) : 'New Conversation')

      const meta: MetaLine = {
        type: 'session',
        id,
        title,
        customTitle,
        workspacePath,
        createdAt,
        updatedAt,
        activeLeafId,
        tag,
        agentName,
        agentColor,
        mode,
        lastPrompt,
        forkedFrom
      }

      return { meta, messages }
    } catch {
      return null
    }
  }

  /** Write a full session file using 1:1 Claude Code Entry format */
  private async writeSessionFile(
    filePath: string,
    meta: MetaLine,
    messages: ChatMessage[]
  ): Promise<void> {
    const lines: string[] = []

    if (meta.customTitle) {
      const titleEntry: CustomTitleEntry = {
        type: 'custom-title',
        sessionId: meta.id,
        customTitle: meta.customTitle
      }
      lines.push(JSON.stringify(titleEntry))
    }

    let prevMsgId: string | null = null
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!isTranscriptMessage(msg)) continue
      const { isStreaming: _, ...persistedMsg } = msg
      const resolvedParentId = msg.parentId !== undefined ? msg.parentId : prevMsgId
      prevMsgId = msg.id

      const entry: MessageTranscriptEntry = {
        type: msg.role,
        uuid: msg.id,
        parentUuid: resolvedParentId,
        sessionId: meta.id,
        cwd: meta.workspacePath || '',
        timestamp: new Date(msg.timestamp || Date.now()).toISOString(),
        ...(meta.forkedFrom && msg.id === meta.forkedFrom.messageUuid
          ? { forkedFrom: meta.forkedFrom }
          : {}),
        message: {
          role: msg.role,
          content: msg.content,
          blocks: msg.blocks,
          toolCalls: msg.toolCalls,
          thinking: msg.thinking
        }
      }
      lines.push(JSON.stringify(entry))
    }

    if (meta.activeLeafId) {
      const summaryEntry: SummaryEntry = {
        type: 'summary',
        leafUuid: meta.activeLeafId,
        summary: 'active_leaf'
      }
      lines.push(JSON.stringify(summaryEntry))
    }

    await fs.writeFile(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
  }

  /**
   * Robust atomic single-line append with crash-boundary protection.
   * If an external crash left a trailing line without \n, prepends \n to isolate the corrupted fragment.
   */
  public appendLineToFile(filePath: string, line: string): void {
    try {
      if (existsSync(filePath)) {
        const stats = statSync(filePath)
        if (stats.size > 0) {
          const fd = openSync(filePath, 'r')
          try {
            const buf = Buffer.alloc(1)
            readSync(fd, buf, 0, 1, stats.size - 1)
            if (buf[0] !== 0x0A) {
              appendFileSync(filePath, '\n' + line + '\n', 'utf-8')
              return
            }
          } finally {
            closeSync(fd)
          }
        }
      }
    } catch {}
    appendFileSync(filePath, line + '\n', 'utf-8')
  }

  /** Append a single message line via synchronous appendFileSync (1:1 with Claude Code Entry format) */
  private appendMessageLine(filePath: string, sessionId: string, workspacePath: string, msg: ChatMessage): void {
    const { isStreaming: _, ...persistedMsg } = msg
    const entry: MessageTranscriptEntry = {
      type: msg.role,
      uuid: msg.id,
      parentUuid: msg.parentId !== undefined ? msg.parentId : null,
      sessionId,
      cwd: workspacePath || '',
      timestamp: new Date(msg.timestamp || Date.now()).toISOString(),
      message: {
        role: msg.role,
        content: msg.content,
        blocks: msg.blocks,
        toolCalls: msg.toolCalls,
        thinking: msg.thinking
      }
    }
    this.appendLineToFile(filePath, JSON.stringify(entry))
  }

  /** Append an ai-title entry to the JSONL (1:1 with Claude Code saveAiGeneratedTitle) */
  private appendAiTitleLine(filePath: string, sessionId: string, aiTitle: string): void {
    const entry: AiTitleEntry = {
      type: 'ai-title',
      sessionId,
      aiTitle
    }
    this.appendLineToFile(filePath, JSON.stringify(entry))
  }

  /** Append a custom-title entry to the JSONL (1:1 with Claude Code saveCustomTitle) */
  public appendCustomTitleLine(filePath: string, sessionId: string, customTitle: string): void {
    const entry: CustomTitleEntry = {
      type: 'custom-title',
      sessionId,
      customTitle
    }
    this.appendLineToFile(filePath, JSON.stringify(entry))
  }

  /**
   * Reads head and tail 64KB chunks of a file without loading entire file (1:1 Claude Code readHeadAndTail).
   */
  public async readHeadAndTail(filePath: string): Promise<{ head: string; tail: string }> {
    let fh: fs.FileHandle | null = null
    try {
      const fileStat = await fs.stat(filePath)
      const fileSize = fileStat.size
      if (fileSize === 0) return { head: '', tail: '' }

      fh = await fs.open(filePath, 'r')
      const buf = Buffer.alloc(LITE_READ_BUF_SIZE)

      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }
      const head = buf.toString('utf8', 0, headResult.bytesRead)

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { head, tail }
    } catch {
      return { head: '', tail: '' }
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }

  /**
   * Lightweight meta read using 64KB Head & Tail window (1:1 with Claude Code sessionStoragePortable.ts).
   * Total memory: strictly bounded to 64KB, O(1).
   */
  public async readMetaOnly(filePath: string): Promise<MetaLine | null> {
    try {
      const { head, tail } = await this.readHeadAndTail(filePath)
      const fileStat = await fs.stat(filePath).catch(() => null)
      const filename = filePath.split(/[/\\]/).pop() || ''
      const safeId = filename.replace(/\.jsonl$/, '')

      if (!head && !tail) {
        return {
          id: safeId,
          title: 'New Conversation',
          workspacePath: '',
          createdAt: fileStat?.birthtimeMs || Date.now(),
          updatedAt: fileStat?.mtimeMs || Date.now(),
          activeLeafId: null
        }
      }

      // 0. Filter out sidechain (subagent) sessions (1:1 with Claude Code listSessionsImpl.ts:89-94)
      const firstNewline = head.indexOf('\n')
      const firstLine = firstNewline >= 0 ? head.slice(0, firstNewline) : head
      if (
        firstLine.includes('"isSidechain":true') ||
        firstLine.includes('"isSidechain": true')
      ) {
        return null
      }

      // 1. Extract from Claude Code 1:1 format using lightweight substring search
      const customTitle = extractLastJsonStringField(tail, 'customTitle') || extractLastJsonStringField(head, 'customTitle')
      const aiTitle = extractLastJsonStringField(tail, 'aiTitle') || extractLastJsonStringField(head, 'aiTitle')
      const sessionId = extractJsonStringField(head, 'sessionId') || extractJsonStringField(tail, 'sessionId')
      const cwd = extractJsonStringField(head, 'cwd') || extractJsonStringField(tail, 'cwd') || ''
      const lastPrompt = extractLastJsonStringField(tail, 'lastPrompt')
      const tag = extractLastJsonStringField(tail, 'tag')
      const firstPrompt = extractFirstPromptFromHead(head)

      // 2. Check legacy t: 'meta'
      let legacyTitle: string | undefined
      let legacyWs: string | undefined
      let legacyId: string | undefined
      let legacyActiveLeaf: string | null = null

      if (head.includes('"t":"meta"') || head.includes('"t": "meta"')) {
        legacyTitle = extractLastJsonStringField(tail, 'title') || extractJsonStringField(head, 'title')
        legacyWs = extractJsonStringField(head, 'workspacePath')
        legacyId = extractJsonStringField(head, 'id')
        legacyActiveLeaf = extractLastJsonStringField(tail, 'activeLeafId') || extractJsonStringField(head, 'activeLeafId') || null
      }

      const id = sessionId || legacyId || safeId
      const workspacePath = cwd || legacyWs || ''
      const title =
        customTitle ||
        aiTitle ||
        legacyTitle ||
        (lastPrompt ? (lastPrompt.length > 30 ? lastPrompt.slice(0, 27) + '...' : lastPrompt) : undefined) ||
        (firstPrompt ? (firstPrompt.length > 30 ? firstPrompt.slice(0, 27) + '...' : firstPrompt) : 'New Conversation')

      // 3. Resolve active leaf ID: scan tail backwards for the last valid complete JSON entry
      let activeLeafId: string | null = null
      const tailLines = tail.split('\n')
      for (let i = tailLines.length - 1; i >= 0; i--) {
        const tl = tailLines[i].trim()
        if (!tl) continue
        try {
          const parsed = JSON.parse(tl)
          if (parsed.leafUuid && typeof parsed.leafUuid === 'string') {
            activeLeafId = parsed.leafUuid
            break
          }
          if (
            parsed.uuid &&
            typeof parsed.uuid === 'string' &&
            (parsed.type === 'user' || parsed.type === 'assistant' || parsed.type === 'system' || parsed.type === 'attachment')
          ) {
            activeLeafId = parsed.uuid
            break
          }
          if (parsed.t === 'msg' && parsed.id) {
            activeLeafId = parsed.id
            break
          }
          if (parsed.activeLeafId) {
            activeLeafId = parsed.activeLeafId
            break
          }
        } catch {
          // Incomplete or corrupted tail line; safely skip to find last valid entry
        }
      }

      if (!activeLeafId) {
        const leafUuid = extractLastJsonStringField(tail, 'leafUuid')
        const lastUuid = extractLastJsonStringField(tail, 'uuid')
        activeLeafId = leafUuid || lastUuid || legacyActiveLeaf
      }

      return {
        id,
        title,
        customTitle,
        workspacePath,
        createdAt: fileStat?.birthtimeMs || Date.now(),
        updatedAt: fileStat?.mtimeMs || Date.now(),
        activeLeafId: activeLeafId || null,
        tag,
        lastPrompt
      }
    } catch {
      return null
    }
  }

  public async countMessages(filePath: string): Promise<number> {
    let fh: fs.FileHandle | null = null
    try {
      fh = await fs.open(filePath, 'r')
      const buf = Buffer.alloc(LITE_READ_BUF_SIZE)
      let newlines = 0
      while (true) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0A) newlines++
        }
      }
      return newlines
    } catch {
      return 0
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }

  // ── Index Management & Project Isolation ──────────────────────

  private async refreshIndex(): Promise<void> {
    try {
      if (existsSync(this.indexPath)) {
        const raw = await fs.readFile(this.indexPath, 'utf-8')
        this.indexCache = JSON.parse(raw)
        return
      }
    } catch (e) {
      console.warn('[SessionStore] Failed to read index.json, rebuilding:', e)
    }

    const summaries: SessionSummary[] = []
    const projectsDir = this.getProjectsDir()
    try {
      if (existsSync(projectsDir)) {
        const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true })
        for (const dir of projectDirs) {
          if (dir.isDirectory()) {
            const pDir = join(projectsDir, dir.name)
            const files = await fs.readdir(pDir)
            for (const file of files) {
              if (file.endsWith('.jsonl')) {
                const filePath = join(pDir, file)
                const meta = await this.readMetaOnly(filePath)
                if (meta) {
                  const msgCount = await this.countMessages(filePath)
                  summaries.push({
                    id: meta.id,
                    title: meta.title || 'New Conversation',
                    customTitle: meta.customTitle,
                    workspacePath: meta.workspacePath || '',
                    createdAt: meta.createdAt || Date.now(),
                    updatedAt: meta.updatedAt || Date.now(),
                    activeLeafId: meta.activeLeafId,
                    messageCount: msgCount
                  })
                }
              }
            }
          }
        }
      }
    } catch {}

    summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    this.indexCache = summaries
    await this.persistIndex()
  }

  public async reconcileIndex(): Promise<void> {
    try {
      const projectsDir = this.getProjectsDir()
      if (!existsSync(projectsDir)) {
        mkdirSync(projectsDir, { recursive: true })
      }

      const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => [])
      const foundSessionFiles = new Map<string, string>()

      for (const entry of projectEntries) {
        if (entry.isDirectory()) {
          const pDir = join(projectsDir, entry.name)
          const files = await fs.readdir(pDir).catch(() => [])
          for (const f of files) {
            if (f.endsWith('.jsonl')) {
              const safeId = f.replace(/\.jsonl$/, '')
              foundSessionFiles.set(safeId, join(pDir, f))
            }
          }
        }
      }

      if (!this.indexCache) this.indexCache = []
      let changed = false

      const prevLength = this.indexCache.length
      this.indexCache = this.indexCache.filter((entry) => {
        const safeId = entry.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        return foundSessionFiles.has(safeId)
      })
      if (this.indexCache.length !== prevLength) {
        changed = true
      }

      for (const [safeId, filePath] of foundSessionFiles) {
        const fileStat = await fs.stat(filePath).catch(() => null)
        if (!fileStat) continue

        const cachedEntry = this.indexCache.find(
          (item) => item.id.replace(/[^a-zA-Z0-9_-]/g, '_') === safeId
        )

        if (!cachedEntry || fileStat.mtimeMs > (cachedEntry.updatedAt || 0) + 1000) {
          const meta = await this.readMetaOnly(filePath)
          if (meta) {
            const msgCount = await this.countMessages(filePath)
            const summary: SessionSummary = {
              id: meta.id,
              title: meta.title || 'New Conversation',
              customTitle: meta.customTitle,
              workspacePath: meta.workspacePath || '',
              createdAt: meta.createdAt || fileStat.birthtimeMs || Date.now(),
              updatedAt: meta.updatedAt || fileStat.mtimeMs || Date.now(),
              activeLeafId: meta.activeLeafId,
              messageCount: msgCount
            }

            if (cachedEntry) {
              Object.assign(cachedEntry, summary)
            } else {
              this.indexCache.push(summary)
            }
            changed = true
          }
        }
      }

      if (changed) {
        this.indexCache.sort((a, b) => b.updatedAt - a.updatedAt)
        await this.persistIndex()
      }
    } catch (e) {
      console.warn('[SessionStore] Index reconciliation skipped:', e)
    }
  }

  // R13:并发加固。indexWriteQueue 串行化整文件写(单飞互斥),
  // atomicWriteFile 走同目录 temp+rename(Windows Defender/索引器锁有 EPERM 重试),
  // 快照在调用时刻序列化,排队期间的新 mutation 不污染已入队的写。
  private indexWriteQueue: Promise<void> = Promise.resolve()

  private async persistIndex(): Promise<void> {
    if (!this.indexCache) return
    const snapshot = Buffer.from(JSON.stringify(this.indexCache, null, 2), 'utf-8')
    const write = this.indexWriteQueue.then(() => atomicWriteFile(this.indexPath, snapshot))
    this.indexWriteQueue = write.catch(() => {}) // 队列永 reject,后续写不被一次失败卡死
    try {
      await write
    } catch (e) {
      console.error('[SessionStore] Failed to persist index.json:', e)
    }
  }

  private updateIndexEntry(session: SessionRecord): void {
    if (!this.indexCache) this.indexCache = []
    const existingIdx = this.indexCache.findIndex((s) => s.id === session.id)
    const summary: SessionSummary = {
      id: session.id,
      title: session.title,
      customTitle: session.customTitle,
      workspacePath: session.workspacePath,
      createdAt: session.createdAt || Date.now(),
      updatedAt: session.updatedAt,
      activeLeafId: session.activeLeafId,
      messageCount: session.messages.length,
      lastPrompt: session.messages.find((m) => m.role === 'user')?.content?.slice(0, 60)
    }

    if (existingIdx >= 0) {
      this.indexCache[existingIdx] = summary
    } else {
      this.indexCache.unshift(summary)
    }
    this.indexCache.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ── Public API ────────────────────────────────────────────────

  public async listSessions(workspacePath?: string): Promise<SessionSummary[]> {
    await this.init()
    await this.reconcileIndex()
    const list = this.indexCache || []
    if (!workspacePath) {
      return [...list]
    }
    const normalizedWs = workspacePath.replace(/[/\\]+/g, '/').toLowerCase()
    return list.filter((item) => {
      if (!item.workspacePath) return true
      const itemWs = item.workspacePath.replace(/[/\\]+/g, '/').toLowerCase()
      return itemWs === normalizedWs || itemWs.includes(normalizedWs) || normalizedWs.includes(itemWs)
    })
  }

  public async getSession(id: string): Promise<SessionRecord | null> {
    await this.init()
    const filePath = await this.findSessionFilePath(id)
    if (!filePath || !existsSync(filePath)) {
      return null
    }
    const parsed = await this.parseSessionFile(filePath)
    if (!parsed) return null

    const activeMessages = buildConversationChain(parsed.messages, parsed.meta.activeLeafId)
    const effectiveLeafId =
      parsed.meta.activeLeafId ||
      (activeMessages.length > 0 ? activeMessages[activeMessages.length - 1].id : null)

    return {
      id: parsed.meta.id,
      title: parsed.meta.title,
      customTitle: parsed.meta.customTitle,
      workspacePath: parsed.meta.workspacePath,
      createdAt: parsed.meta.createdAt,
      updatedAt: parsed.meta.updatedAt,
      activeLeafId: effectiveLeafId,
      tag: parsed.meta.tag,
      agentName: parsed.meta.agentName,
      agentColor: parsed.meta.agentColor,
      mode: parsed.meta.mode,
      lastPrompt: parsed.meta.lastPrompt,
      forkedFrom: parsed.meta.forkedFrom,
      messages: activeMessages
    }
  }

  public async createSession(title = 'New Conversation', workspacePath = ''): Promise<SessionRecord> {
    await this.init()
    const now = Date.now()
    const id = randomUUID()
    const filePath = this.getSessionTargetFilePath(id, workspacePath)

    const record: SessionRecord = {
      id,
      title,
      workspacePath,
      createdAt: now,
      updatedAt: now,
      activeLeafId: null,
      messages: []
    }

    if (title && title !== 'New Conversation' && title !== 'New Session') {
      record.customTitle = title
      const entry: CustomTitleEntry = {
        type: 'custom-title',
        sessionId: id,
        customTitle: title
      }
      await fs.writeFile(filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } else {
      await fs.writeFile(filePath, '', 'utf-8')
    }

    this.updateIndexEntry(record)
    await this.persistIndex()
    return record
  }

  /**
   * Append a single message to a session's .jsonl file (100% Crash-Safe Append-Only).
   *
   * ABSOLUTE GUARANTEES:
   * 1. NEVER reads the whole file.
   * 2. NEVER calls fs.writeFile (no truncate, zero data loss risk on power cutoff).
   * 3. Uses synchronous appendFileSync for 1:1 Claude Code Entry lines.
   */
  public async appendMessage(sessionId: string, message: ChatMessage): Promise<boolean> {
    await this.init()
    if (!isTranscriptMessage(message)) {
      return false
    }

    try {
      const filePath = await this.findSessionFilePath(sessionId)
      if (!filePath || !existsSync(filePath)) return false

      // 1. Read metadata from 64KB Head/Tail (never full file)
      const meta = await this.readMetaOnly(filePath)
      if (!meta) return false

      // 1.5 终极去重(轻量):与当前活跃叶子同 id 的追加直接拒绝(双写兜底)
      if (message.id && meta.activeLeafId === message.id) {
        return false
      }

      // 2. DAG automatic chaining: if parentId is undefined, link to current activeLeafId
      if (message.parentId === undefined) {
        message.parentId = meta.activeLeafId || null
      }

      // 3. Synchronous atomic append of 1:1 message line
      this.appendMessageLine(filePath, sessionId, meta.workspacePath, message)

      // 3b. Rolling last-prompt entry (1:1 with Claude Code sessionStorage.ts:1269-1275)
      if (message.role === 'user' && message.content) {
        const lastPromptEntry: LastPromptMessage = {
          type: 'last-prompt',
          sessionId,
          lastPrompt: message.content.slice(0, 200).trim()
        }
        this.appendLineToFile(filePath, JSON.stringify(lastPromptEntry))
      }

      // 4. Update active leaf and check title derivation
      const now = Date.now()
      meta.activeLeafId = message.id
      meta.updatedAt = now

      let titleChanged = false
      if (!meta.customTitle && (!meta.title || meta.title === 'New Conversation' || meta.title === 'New Session')) {
        if (message.role === 'user' && message.content) {
          const derived = extractSessionTitle([message], meta.title)
          if (derived !== meta.title) {
            meta.title = derived
            titleChanged = true
            // Append ai-title entry (1:1 with Claude Code saveAiGeneratedTitle)
            this.appendAiTitleLine(filePath, sessionId, derived)
          }
        }
      }

      // 5. Update in-memory index cache
      if (this.indexCache) {
        const idx = this.indexCache.findIndex((s) => s.id === sessionId)
        if (idx >= 0) {
          this.indexCache[idx].updatedAt = now
          this.indexCache[idx].activeLeafId = message.id
          if (titleChanged) {
            this.indexCache[idx].title = meta.title
          }
          this.indexCache[idx].messageCount = (this.indexCache[idx].messageCount || 0) + 1
          if (message.role === 'user') {
            this.indexCache[idx].lastPrompt = message.content?.slice(0, 60)
          }
          this.indexCache.sort((a, b) => b.updatedAt - a.updatedAt)
          await this.persistIndex()
        }
      }
      return true
    } catch (e) {
      console.error(`[SessionStore] Failed to append message to ${sessionId}:`, e)
      return false
    }
  }

  /**
   * Switch the active view/leaf of a session to another DAG branch.
   * Pure Append-Only: appends summary entry with leafUuid (1:1 with Claude Code).
   */
  public async setActiveBranch(sessionId: string, leafMessageId: string): Promise<SessionRecord | null> {
    await this.init()
    const filePath = await this.findSessionFilePath(sessionId)
    if (!filePath || !existsSync(filePath)) return null

    const parsed = await this.parseSessionFile(filePath)
    if (!parsed) return null

    const exists = parsed.messages.some((m) => m.id === leafMessageId)
    if (!exists) return null

    const entry: SummaryEntry = {
      type: 'summary',
      leafUuid: leafMessageId,
      summary: 'branch_switch'
    }
    this.appendLineToFile(filePath, JSON.stringify(entry))

    return this.getSession(sessionId)
  }

  /**
   * Generates a unique branch title matching Claude Code's getUniqueForkName (sessionBranching.ts:253-284).
   * Format: "${baseName} (Branch)" or "${baseName} (Branch ${nextNumber})".
   */
  public async getUniqueBranchTitle(baseName: string, workspacePath?: string): Promise<string> {
    const list = await this.listSessions(workspacePath)
    const existingTitles = new Set(list.map((s) => s.title.trim()).filter(Boolean))

    const cleanBase = baseName.replace(/\s*\(Branch(?:\s+\d+)?\)$/, '').trim()
    const candidateName = `${cleanBase} (Branch)`
    if (!existingTitles.has(candidateName)) {
      return candidateName
    }

    const usedNumbers = new Set<number>([1])
    const branchPattern = new RegExp(`^${cleanBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Branch(?: (\\d+))?\\)$`)
    for (const title of existingTitles) {
      const match = title.match(branchPattern)
      if (match) {
        usedNumbers.add(match[1] ? parseInt(match[1], 10) : 1)
      }
    }

    let nextNumber = 2
    while (usedNumbers.has(nextNumber)) {
      nextNumber++
    }
    return `${cleanBase} (Branch ${nextNumber})`
  }

  public async forkSession(
    sessionId: string,
    fromMessageId: string,
    newTitle?: string
  ): Promise<SessionRecord | null> {
    await this.init()
    const original = await this.getSession(sessionId)
    if (!original) return null

    const filePath = await this.findSessionFilePath(sessionId)
    if (!filePath) return null

    const parsed = await this.parseSessionFile(filePath)
    if (!parsed) return null

    const forkedChain = buildConversationChain(parsed.messages, fromMessageId)
    if (forkedChain.length === 0) return null

    const title = newTitle || (await this.getUniqueBranchTitle(original.title, original.workspacePath))
    const newSession = await this.createSession(
      title,
      original.workspacePath
    )

    // Preserve metadata 1:1 with Claude Code buildPreservedMetadataEntries (sessionBranching.ts:286-327)
    newSession.tag = original.tag
    newSession.agentName = original.agentName
    newSession.agentColor = original.agentColor
    newSession.mode = original.mode
    newSession.forkedFrom = {
      sessionId,
      messageUuid: fromMessageId
    }

    // Every copied message is marked with forkedFrom 1:1 with Claude Code sessionBranching.ts:477
    newSession.messages = forkedChain.map((m) => ({
      ...m,
      forkedFrom: {
        sessionId,
        messageUuid: m.id
      }
    }))
    newSession.activeLeafId = fromMessageId
    await this.saveSession(newSession)
    return newSession
  }

  /**
   * Rename a session using 1:1 Claude Code custom-title entry append (sessionStorage.ts:2860-2882).
   */
  public async renameSession(sessionId: string, newTitle: string): Promise<boolean> {
    await this.init()
    const filePath = await this.findSessionFilePath(sessionId)
    if (!filePath || !existsSync(filePath)) return false

    this.appendCustomTitleLine(filePath, sessionId, newTitle)

    if (this.indexCache) {
      const idx = this.indexCache.findIndex((s) => s.id === sessionId)
      if (idx >= 0) {
        this.indexCache[idx].customTitle = newTitle
        this.indexCache[idx].title = newTitle
        this.indexCache[idx].updatedAt = Date.now()
        this.indexCache.sort((a, b) => b.updatedAt - a.updatedAt)
        await this.persistIndex()
      }
    }
    return true
  }

  /**
   * Set session tag using 1:1 Claude Code tag entry append (sessionStorage.ts:2934-2940).
   */
  public async setSessionTag(sessionId: string, tag: string): Promise<boolean> {
    await this.init()
    const filePath = await this.findSessionFilePath(sessionId)
    if (!filePath || !existsSync(filePath)) return false

    const tagEntry: TagMessage = {
      type: 'tag',
      sessionId,
      tag
    }
    this.appendLineToFile(filePath, JSON.stringify(tagEntry))

    if (this.indexCache) {
      const idx = this.indexCache.findIndex((s) => s.id === sessionId)
      if (idx >= 0) {
        this.indexCache[idx].tag = tag
        this.indexCache[idx].updatedAt = Date.now()
        await this.persistIndex()
      }
    }
    return true
  }

  public async saveSession(session: SessionRecord): Promise<boolean> {
    await this.init()
    try {
      const now = Date.now()
      if (session.customTitle) {
        session.title = session.customTitle
      } else if (!session.title || session.title === 'New Conversation' || session.title === 'New Session') {
        session.title = extractSessionTitle(session.messages, session.title || 'New Conversation')
      }
      session.updatedAt = now

      const activeLeaf =
        session.activeLeafId ||
        (session.messages.length > 0 ? session.messages[session.messages.length - 1].id : null)

      const meta: MetaLine = {
        id: session.id,
        title: session.title,
        customTitle: session.customTitle,
        workspacePath: session.workspacePath,
        createdAt: session.createdAt || now,
        updatedAt: session.updatedAt,
        activeLeafId: activeLeaf,
        tag: session.tag,
        agentName: session.agentName,
        agentColor: session.agentColor,
        mode: session.mode,
        lastPrompt: session.lastPrompt,
        forkedFrom: session.forkedFrom
      }

      const existingPath = await this.findSessionFilePath(session.id, session.workspacePath)
      const filePath = existingPath || this.getSessionTargetFilePath(session.id, session.workspacePath)

      await this.writeSessionFile(filePath, meta, session.messages)

      this.updateIndexEntry(session)
      await this.persistIndex()
      return true
    } catch (e) {
      console.error(`[SessionStore] Failed to save session ${session.id}:`, e)
      return false
    }
  }

  public async deleteSession(id: string): Promise<boolean> {
    await this.init()
    try {
      const filePath = await this.findSessionFilePath(id)
      if (filePath && existsSync(filePath)) {
        await fs.unlink(filePath)
      }
      if (this.indexCache) {
        this.indexCache = this.indexCache.filter((s) => s.id !== id)
        await this.persistIndex()
      }
      return true
    } catch (e) {
      console.error(`[SessionStore] Failed to delete session ${id}:`, e)
      return false
    }
  }
}

export const sessionStore = new SessionStore()

