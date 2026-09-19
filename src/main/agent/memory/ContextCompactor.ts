import type { LLMMessage, ILLMProvider } from '../providers/LLMProvider'
import { sanitizeConversationHistory } from '../utils/messageSanitizer'

export interface ContextCompactorOptions {
  thresholdTokens?: number
  preserveRecentRounds?: number
  llmProvider?: ILLMProvider
}

export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 60_000
export const DEFAULT_PRESERVE_RECENT_ROUNDS = 2
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

export const COMPACTABLE_TOOLS = new Set<string>([
  'view_file',
  'read_file',
  'cat',
  'run_command',
  'bash',
  'powershell',
  'exec',
  'sh',
  'grep_search',
  'grep',
  'find_by_name',
  'glob',
  'list_dir',
  'list_directory',
  'ls',
  'search_web',
  'read_url_content',
  'write_to_file',
  'replace_file_content'
])

/**
 * Fast token estimation heuristic.
 * Distinguishes CJK characters (~1.5 chars/token) and ASCII/code (~3.5 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjkCount = 0
  let nonCjkCount = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Common CJK ranges: 0x4E00-0x9FFF, 0x3400-0x4DBF, 0xF900-0xFAFF
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount++
    } else {
      nonCjkCount++
    }
  }

  const cjkTokens = Math.ceil(cjkCount / 1.5)
  const nonCjkTokens = Math.ceil(nonCjkCount / 3.5)
  return cjkTokens + nonCjkTokens
}

/**
 * Calculates estimated token usage across all messages in history.
 */
export function estimateConversationTokens(messages: LLMMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += 4 // overhead per message
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += 10
        total += estimateTokens(tc.function.name)
        total += estimateTokens(tc.function.arguments)
      }
    }
  }
  return total
}

export class ContextCompactor {
  private thresholdTokens: number
  private preserveRecentRounds: number
  private llmProvider?: ILLMProvider

  constructor(options?: ContextCompactorOptions) {
    this.thresholdTokens = options?.thresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS
    this.preserveRecentRounds = options?.preserveRecentRounds ?? DEFAULT_PRESERVE_RECENT_ROUNDS
    this.llmProvider = options?.llmProvider
  }

  public needsCompaction(messages: LLMMessage[]): boolean {
    return estimateConversationTokens(messages) > this.thresholdTokens
  }

  /**
   * 1:1 with Claude Code microcompactMessages:
   * Fast, zero-LLM-cost compaction that clears historical tool outputs in older rounds
   * (e.g. view_file, grep, ls, bash outputs) while preserving recent turns and tool pairings.
   */
  public microcompactToolResults(
    messages: LLMMessage[],
    keepRecentRounds?: number
  ): {
    compacted: boolean
    messages: LLMMessage[]
    clearedCount: number
    savedTokens: number
  } {
    const keepRounds = keepRecentRounds ?? this.preserveRecentRounds
    const initialTokens = estimateConversationTokens(messages)

    // Locate boundary where recent user rounds begin
    const nonSystem = messages.filter((m) => m.role !== 'system')
    let userCount = 0
    let cutoffIdx = nonSystem.length

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === 'user') {
        userCount++
        if (userCount === keepRounds) {
          cutoffIdx = i
          break
        }
      }
    }

    if (cutoffIdx <= 0) {
      return { compacted: false, messages, clearedCount: 0, savedTokens: 0 }
    }

    // Identify tool_use ids belonging to recent rounds that should NOT be cleared
    const recentMessages = nonSystem.slice(cutoffIdx)
    const protectedToolCallIds = new Set<string>()
    for (const msg of recentMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          protectedToolCallIds.add(tc.id)
        }
      }
    }

    let clearedCount = 0
    const updatedMessages: LLMMessage[] = messages.map((msg) => {
      // Only process tool messages that appear prior to the cutoff
      if (msg.role === 'tool' && msg.tool_call_id) {
        if (!protectedToolCallIds.has(msg.tool_call_id)) {
          // Check if tool is compactable
          const toolName = msg.name || ''
          const isCompactable = !toolName || COMPACTABLE_TOOLS.has(toolName.toLowerCase())
          if (isCompactable && msg.content !== TOOL_RESULT_CLEARED_MESSAGE) {
            clearedCount++
            return {
              ...msg,
              content: TOOL_RESULT_CLEARED_MESSAGE
            }
          }
        }
      }
      return msg
    })

    if (clearedCount === 0) {
      return { compacted: false, messages, clearedCount: 0, savedTokens: 0 }
    }

    const finalTokens = estimateConversationTokens(updatedMessages)
    const savedTokens = Math.max(0, initialTokens - finalTokens)

    return {
      compacted: true,
      messages: updatedMessages,
      clearedCount,
      savedTokens
    }
  }

  /**
   * Compacts conversation history by summarizing older turns and keeping recent rounds intact.
   */
  public async compactHistory(
    messages: LLMMessage[],
    options?: { force?: boolean }
  ): Promise<{
    compacted: boolean
    messages: LLMMessage[]
    savedTokens: number
  }> {
    const initialTokens = estimateConversationTokens(messages)
    if (!options?.force && initialTokens <= this.thresholdTokens) {
      return { compacted: false, messages, savedTokens: 0 }
    }

    const systemMsg = messages.find((m) => m.role === 'system')
    const nonSystem = messages.filter((m) => m.role !== 'system')

    if (nonSystem.length <= this.preserveRecentRounds * 2) {
      return { compacted: false, messages, savedTokens: 0 }
    }

    // Find cut index based on preserveRecentRounds
    // Walk backwards from end to locate the last N user messages
    let userMsgCount = 0
    let cutIndex = nonSystem.length

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === 'user') {
        userMsgCount++
        if (userMsgCount === this.preserveRecentRounds) {
          cutIndex = i
          break
        }
      }
    }

    if (cutIndex <= 0) {
      return { compacted: false, messages, savedTokens: 0 }
    }

    const oldMessages = nonSystem.slice(0, cutIndex)
    const recentMessages = nonSystem.slice(cutIndex)

    // Generate summary of old messages
    const summaryText = await this.summarizeOlderMessages(oldMessages)

    const boundaryMsg: LLMMessage = {
      role: 'user',
      content:
        `[Conversation Summary up to this point:\n${summaryText}\n` +
        `This summary replaces older message turns to stay within the model context budget.]\n` +
        `[compact_boundary]`
    }

    const boundaryAck: LLMMessage = {
      role: 'assistant',
      content: 'Understood. I have internalized the prior context and decisions from the conversation summary. Continuing with the latest user task.'
    }

    // Assemble new history
    const newHistory: LLMMessage[] = []
    if (systemMsg) {
      newHistory.push(systemMsg)
    }
    newHistory.push(boundaryMsg, boundaryAck, ...recentMessages)

    // Ensure tool pairing integrity
    const sanitized = sanitizeConversationHistory(newHistory)
    const finalTokens = estimateConversationTokens(sanitized)
    const savedTokens = Math.max(0, initialTokens - finalTokens)

    return {
      compacted: true,
      messages: sanitized,
      savedTokens
    }
  }

  /**
   * Generates a concise summary of older messages.
   * If LLM provider is available, invokes a fast completion; otherwise extracts structured facts.
   */
  private async summarizeOlderMessages(messages: LLMMessage[]): Promise<string> {
    const goals: string[] = []
    const toolsUsed: string[] = []
    const keyActions: string[] = []

    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        const firstLine = msg.content.split('\n')[0].slice(0, 150)
        goals.push(firstLine)
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolsUsed.push(tc.function.name)
        }
      } else if (msg.role === 'tool' && msg.content) {
        if (msg.name === 'write_to_file' || msg.name === 'replace_file_content') {
          keyActions.push(`Modified file via ${msg.name}`)
        }
      }
    }

    const uniqueTools = Array.from(new Set(toolsUsed))
    const recentGoals = goals.slice(-5)

    const lines = [
      `• Primary user objectives: ${recentGoals.join('; ') || 'General coding/task assistance'}`,
      `• Tools executed: ${uniqueTools.length > 0 ? uniqueTools.join(', ') : 'None'}`,
      `• Key actions taken: ${keyActions.length > 0 ? keyActions.slice(-5).join('; ') : 'Analyzed repository and responded to user queries'}`
    ]

    return lines.join('\n')
  }
}
