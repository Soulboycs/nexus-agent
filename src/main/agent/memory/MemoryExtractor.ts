import type { LLMMessage, ILLMProvider } from '../providers/LLMProvider'
import { MemoryManager } from './MemoryManager'
import type { MemoryItem, MemoryType } from './types'

export interface MemoryExtractorOptions {
  memoryManager: MemoryManager
  llmProvider?: ILLMProvider
  onMemoryUpdated?: (item: MemoryItem) => void
  /**
   * 'regex' (default): heuristic pattern matching, zero cost.
   * 'llm': side LLM call per finished turn (1:1 Claude Code memory extraction);
   * falls back to regex when the provider fails or returns nothing usable.
   */
  mode?: 'regex' | 'llm'
}

const LLM_EXTRACTION_SYSTEM = `You extract long-term memories for a coding agent. Given a user message and the agent's reply, decide whether the user revealed durable facts worth remembering across sessions.

Categories (pick exactly one per memory):
- user: the user's background, role, skill level, preferences
- feedback: corrections, "always/never" working instructions
- project: deadlines, milestones, constraints, release plans
- reference: pointers to external resources, teams, tools

Rules:
- Only durable facts. Never store code architecture, file contents, or anything derivable from the repo.
- Output STRICT JSON, no prose, no code fences: {"memories":[{"type":"user|feedback|project|reference","name":"short title","description":"one sentence","content":"full memory text"}]}
- Output {"memories":[]} when there is nothing worth remembering. Max 3 memories.`

interface LLMExtractedMemory {
  type: string
  name: string
  description: string
  content: string
}

const MAX_MEMORIES_PER_TURN = 3
const MAX_NAME_LEN = 80
const MAX_DESC_LEN = 200
const MAX_CONTENT_LEN = 2000
const MAX_USER_TEXT = 4000
const MAX_ASSISTANT_TEXT = 2000

function slugifyFilename(name: string, type: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'note'
  return `${type}_${slug}.md`
}

export class MemoryExtractor {
  private memoryManager: MemoryManager
  private llmProvider?: ILLMProvider
  private onMemoryUpdated?: (item: MemoryItem) => void
  private mode: 'regex' | 'llm'
  private isExtracting = false

  constructor(options: MemoryExtractorOptions) {
    this.memoryManager = options.memoryManager
    this.llmProvider = options.llmProvider
    this.onMemoryUpdated = options.onMemoryUpdated
    this.mode = options.mode ?? 'regex'
  }

  /**
   * Extracts memorable facts from a finished turn.
   */
  public async extractFromTurn(messages: LLMMessage[]): Promise<MemoryItem[]> {
    if (this.memoryManager.isDisabled() || this.isExtracting) {
      return []
    }

    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg || !lastUserMsg.content || lastUserMsg.content.length < 10) {
      return []
    }

    const text = lastUserMsg.content.trim()

    // Filter out trivial chatter
    if (/^(hi|hello|hey|ok|thanks|thank you|yes|no|done|你好|好的|谢谢|已完成)$/i.test(text)) {
      return []
    }

    this.isExtracting = true
    try {
      let candidates: MemoryItem[] = []
      if (this.mode === 'llm' && this.llmProvider) {
        try {
          candidates = await this.extractViaLLM(messages, text)
        } catch {
          candidates = [] // provider failure → regex fallback below
        }
        if (candidates.length === 0) {
          candidates = this.identifyMemoryCandidates(text)
        }
      } else {
        candidates = this.identifyMemoryCandidates(text)
      }
      const savedItems: MemoryItem[] = []

      for (const item of candidates) {
        await this.memoryManager.saveMemory(item)
        savedItems.push(item)
        if (this.onMemoryUpdated) {
          this.onMemoryUpdated(item)
        }
      }

      return savedItems
    } finally {
      this.isExtracting = false
    }
  }

  /**
   * Identifies candidate facts across the 4 taxonomies from user text.
   */
  private identifyMemoryCandidates(userText: string): MemoryItem[] {
    const items: MemoryItem[] = []
    const lower = userText.toLowerCase()

    // 1. User Profile Detection
    const isUserProfile =
      /(i am|i'm|my background|my role|years of experience|new to|我是|我的经验是)/i.test(userText) &&
      /(engineer|developer|designer|scientist|go|python|rust|c\+\+|react|vue|新手|工程师|架构师)/i.test(userText)

    if (isUserProfile) {
      items.push({
        filename: 'user_profile.md',
        name: 'User Background and Preferences',
        type: 'user',
        description: userText.slice(0, 80).replace(/\n/g, ' '),
        content: `User Profile & Knowledge Context:\n${userText}\n\n**How to apply:** Tailor technical explanations, analogies, and code suggestions to the user's stated background and experience level.`
      })
    }

    // 2. Feedback / Policy Detection
    const isFeedback =
      /(remember|note that|keep in mind|never|don't|stop doing|always use|do not|必须|不要|千万别|禁止|记住)/i.test(userText)

    if (isFeedback) {
      // Slugify first few words
      const cleanSlug = userText
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 20)
        .toLowerCase()
      const filename = `feedback_${cleanSlug || 'guideline'}.md`

      items.push({
        filename,
        name: `Feedback Guidance (${userText.slice(0, 30)})`,
        type: 'feedback',
        description: userText.slice(0, 80).replace(/\n/g, ' '),
        content: `User Correction / Working Guidance:\n${userText}\n\n**Why:** Stated directly by the user during interactive session.\n**How to apply:** Comply with this instruction in all future file edits, tool calls, and responses.`
      })
    }

    // 3. Project Dynamics Detection
    const isProject =
      /(freeze|deadline|release branch|sprint|milestone|上线|冻结|发布|截止日期)/i.test(userText) &&
      !isFeedback

    if (isProject) {
      items.push({
        filename: 'project_context.md',
        name: 'Project Timeline & Constraints',
        type: 'project',
        description: userText.slice(0, 80).replace(/\n/g, ' '),
        content: `Project Constraint / Timeline:\n${userText}\n\n**How to apply:** Factor this project constraint into implementation schedules and reviews.`
      })
    }

    return items
  }

  /**
   * Side LLM call (no tools): extracts durable memories as strict JSON.
   * Throws on provider failure — caller falls back to regex heuristics.
   */
  private async extractViaLLM(messages: LLMMessage[], userText: string): Promise<MemoryItem[]> {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)
    const prompt = [
      'User message:',
      userText.slice(0, MAX_USER_TEXT),
      '',
      'Agent reply (excerpt):',
      (lastAssistant?.content || '').slice(0, MAX_ASSISTANT_TEXT),
    ].join('\n')

    const result = await this.llmProvider!.chatStream(
      [
        { role: 'system', content: LLM_EXTRACTION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      [],
      () => {}
    )

    const raw = (result.fullContent || '').trim()
    const jsonText = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      return [] // not JSON → nothing usable
    }
    const memories = (parsed as any)?.memories
    if (!Array.isArray(memories)) return []

    const items: MemoryItem[] = []
    for (const m of memories as LLMExtractedMemory[]) {
      if (items.length >= MAX_MEMORIES_PER_TURN) break
      if (!m || typeof m !== 'object') continue
      const type = String(m.type)
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) continue
      const name = String(m.name || '').slice(0, MAX_NAME_LEN)
      if (!name) continue
      const description = String(m.description || '').slice(0, MAX_DESC_LEN)
      const content = String(m.content || '').slice(0, MAX_CONTENT_LEN)
      items.push({
        filename: slugifyFilename(name, type),
        name,
        type: type as MemoryItem['type'],
        description,
        content,
      })
    }
    return items
  }
}
