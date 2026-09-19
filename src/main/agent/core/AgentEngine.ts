import { EventEmitter } from 'events'
import {
  AgentEvent,
  ApprovalVerdict,
  AgentStatus,
  ApprovalRequest,
  ChatMessage,
  ProviderConfig,
  PermissionMode,
  normalizePermissionMode
} from '@shared/types'
import { ToolRegistry } from '../tools/ToolRegistry'
import {
  ILLMProvider,
  LLMMessage,
  MockLLMProvider
} from '../providers/LLMProvider'
import { createProvider } from '../providers/ProviderFactory'
import { sanitizeConversationHistory } from '../utils/messageSanitizer'
import { ToolOrchestrator } from '../../../agent/core/ToolOrchestrator'
import { query, QueryTerminal } from '../../../agent/core/query'
import { ToolSearchManager, createToolSearchTool } from '../tools/ToolSearchTool'
import { logger } from '../../utils/logger'
import {
  MemoryManager,
  ProjectInstructions,
  ContextCompactor,
  MemoryExtractor
} from '../memory'
import { FileHistoryTracker } from '../history/FileHistoryTracker'
import { PermissionEngine, ConfiguredRule } from '../permissions'
import { SandboxGuard } from '../sandbox'
import { SlashCommandDispatcher } from '../commands'

export interface AgentEngineOptions {
  workspaceRoot: string
  providerConfig?: ProviderConfig
  customProvider?: ILLMProvider
  maxSteps?: number
  /**
   * Memory extraction strategy: 'regex' (default, zero cost) or 'llm'
   * (side model call per finished turn, 1:1 Claude Code). createDefaultAgentEngine
   * opts production engines into 'llm'.
   */
  memoryExtraction?: 'regex' | 'llm'
  permissionMode?: PermissionMode
  permissionRules?: ConfiguredRule[]
  customMemoryDir?: string
  /** 跨会话文档写冲突检测(阶段三 §6.2 规则5);由 SessionManager 注入共享实例 */
  docConflict?: import('../utils/docConflictDetector').DocConflictDetector
}

export class AgentEngine extends EventEmitter {
  private workspaceRoot: string
  private toolRegistry: ToolRegistry
  private orchestrator: ToolOrchestrator
  private provider: ILLMProvider
  private status: AgentStatus = 'idle'
  private maxSteps: number
  private permissionMode: PermissionMode = 'ask'
  private currentAbortController?: AbortController

  // Commands
  private slashDispatcher: SlashCommandDispatcher

  // Memory & Context Management
  private memoryExtraction: 'regex' | 'llm'
  private memoryManager: MemoryManager
  private projectInstructions: ProjectInstructions
  private compactor: ContextCompactor
  private memoryExtractor: MemoryExtractor

  // Permissions & Sandbox Guard
  private permissionEngine: PermissionEngine
  private sandboxGuard: SandboxGuard

  // Dynamic Tool Search & Context Budget
  private toolSearchManager: ToolSearchManager

  // Pending approval resolver (verdict carries optional user-edited input)
  private pendingApprovals = new Map<
    string,
    { resolve: (verdict: ApprovalVerdict) => void; rejectReason?: string }
  >()
  private earlyResponses = new Map<string, ApprovalVerdict>()

  // File History Tracking & Rollback (/undo)
  private fileHistoryTracker: FileHistoryTracker

  private conversationHistory: LLMMessage[] = []
  private docConflict?: import('../utils/docConflictDetector').DocConflictDetector

  constructor(options: AgentEngineOptions) {
    super()
    this.workspaceRoot = options.workspaceRoot
    this.maxSteps = options.maxSteps ?? 25
    this.memoryExtraction = options.memoryExtraction ?? 'regex'
    this.permissionMode = options.permissionMode ?? 'ask'
    this.toolRegistry = new ToolRegistry()
    this.orchestrator = new ToolOrchestrator(this.toolRegistry)
    this.toolSearchManager = new ToolSearchManager()

    if (options.customProvider) {
      this.provider = options.customProvider
    } else if (options.providerConfig) {
      this.provider = createProvider(options.providerConfig)
    } else {
      this.provider = new MockLLMProvider()
    }

    this.memoryManager = new MemoryManager({
      workspaceRoot: this.workspaceRoot,
      customMemoryDir: options.customMemoryDir
    })
    this.projectInstructions = new ProjectInstructions(this.workspaceRoot)
    this.compactor = new ContextCompactor({
      llmProvider: this.provider
    })
    this.memoryExtractor = this.buildMemoryExtractor({
      memoryManager: this.memoryManager,
      llmProvider: this.provider,
      onMemoryUpdated: (item) => {
        this.emitEvent({
          type: 'memory_updated',
          filename: item.filename,
          name: item.name,
          memoryType: item.type
        })
      }
    })

    this.permissionEngine = new PermissionEngine({
      rules: options.permissionRules
    })
    this.sandboxGuard = new SandboxGuard({
      workspaceRoot: this.workspaceRoot
    })
    this.fileHistoryTracker = new FileHistoryTracker(this.workspaceRoot)
    this.docConflict = options.docConflict
    this.slashDispatcher = new SlashCommandDispatcher(this)

    this.initSystemPrompt()
  }

  public setPermissionMode(mode: PermissionMode): void {
    // Defense in depth: normalize legacy/unknown values at the API boundary,
    // not just at the IPC/preload layer (review finding).
    this.permissionMode = normalizePermissionMode(mode)
    logger.info('AgentEngine', `Permission mode updated to: ${this.permissionMode}`)
  }

  public getPermissionMode(): PermissionMode {
    return this.permissionMode
  }

  private getBaseSystemPrompt(): string {
    return `You are an expert autonomous AI Software Engineer and Pair Programmer running inside an Electron desktop app.
Your mission is to understand user requirements, inspect code, run terminal commands, write and edit files, and verify all changes with tests.

Guidelines:
1. Always view files before modifying them to understand their context and structure.
2. For small to medium edits in existing files, prefer "Edit" over "Write" to preserve undamaged code.
3. Verify your work using "Bash" (e.g. running test suites, builds, or linting).
4. Be concise and direct. Explain what you did and show the results clearly.
5. When executing any tool, provide a concise Chinese intention summary in "toolAction" (e.g. "检查了客户端会话请求节流实现", "排查登录状态加载异常", "检索超时配置用法") so the user can easily track progress in the UI.
6. When dealing with Microsoft Word (.docx) documents, ALWAYS use the dedicated docx tools:
  - "docx_read": Inspect document structure, outline, and live block indices.
  - "docx_modify_block": Surgical modification or rewrite of paragraphs/headings; supports multi-block range replacements with "startBlockIndex", "endBlockIndex", and "html"; supports "trackChanges: true".
  - "docx_apply_ops": Atomic batch formatting and structure operations (setFont, setParagraphFormat, findReplace, setMatchedFont, setHeadingLevel, setList, deleteBlocks) directly on the live Word canvas.
  - "docx_append_content", "docx_insert_table", "docx_delete_block": Structural additions and deletions (supports trackChanges).
  - "docx_read_revisions", "docx_accept_revisions", "docx_reject_revisions": Full Track Changes review lifecycle.
  - "docx_create": Generate new .docx documents from scratch.
7. WORD INTENT RESOLUTION & BEST PRACTICES:
  - Consultation vs Modification: If the user is asking questions, requesting statistics (word/character counts), or asking for writing advice, answer directly in chat without invoking document modification tools. Use the "Full-text stats" and block skeleton in the prompt context directly.
  - Multi-Block Replacement: When modifying multiple contiguous blocks, NEVER replace only the first block! ALWAYS invoke "docx_modify_block" with "startBlockIndex", "endBlockIndex", and the full "html" payload.
  - Batch Formatting & Styling: Use "docx_apply_ops" for font styles, paragraph formats (line spacing, indentation), and word replacements without rewriting entire blocks.
  - Navigation Citations: In your responses and modification summaries, ALWAYS cite target blocks using in-app navigation protocol: [👉 查看改动位置 (第 X-Y 块)](docnav://block/X) or [👉 查看改动位置 (第 X 块)](docnav://block/X). Users click these links to smoothly scroll the Word canvas directly to the modified block and trigger a glowing pulse highlight.
CRITICAL RULE FOR WORD: NEVER use "Bash" (formerly run_command) or Python scripts (such as python-docx or PowerShell) to parse or modify .docx files. ALWAYS call the dedicated docx tools directly. Direct docx tool calls drive the live UI canvas editor with real-time visual highlights and track changes in place, providing an instant GenOffice experience.`
  }

  public async refreshSystemPrompt(): Promise<void> {
    try {
      const instructionsPrompt = await this.projectInstructions.loadInstructionsPrompt()
      const memoryPrompt = this.memoryManager.buildMemoryPrompt()

      const sections = [
        this.getBaseSystemPrompt(),
        instructionsPrompt,
        memoryPrompt
      ].filter(Boolean)

      const fullPrompt = sections.join('\n\n---\n\n')

      if (this.conversationHistory.length > 0 && this.conversationHistory[0].role === 'system') {
        this.conversationHistory[0].content = fullPrompt
      } else {
        this.conversationHistory.unshift({ role: 'system', content: fullPrompt })
      }
    } catch (err) {
      logger.warn('AgentEngine', 'Failed to refresh dynamic system prompt:', err)
    }
  }

  private initSystemPrompt() {
    this.conversationHistory = [
      {
        role: 'system',
        content: this.getBaseSystemPrompt()
      }
    ]
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  getOrchestrator(): ToolOrchestrator {
    return this.orchestrator
  }

  getStatus(): AgentStatus {
    return this.status
  }

  public getFileHistoryTracker(): FileHistoryTracker {
    return this.fileHistoryTracker
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  public getConversationHistory(): LLMMessage[] {
    return [...this.conversationHistory]
  }

  public setConversationHistory(history: LLMMessage[]): void {
    const hasSystem = history.some((m) => m.role === 'system')
    if (hasSystem) {
      this.conversationHistory = sanitizeConversationHistory([...history])
    } else {
      const systemMsg = this.conversationHistory.find((m) => m.role === 'system')
      this.conversationHistory = sanitizeConversationHistory(
        systemMsg ? [systemMsg, ...history] : [...history]
      )
    }
  }

  private setStatus(status: AgentStatus, message?: string) {
    this.status = status
    this.emitEvent({ type: 'status_change', status, message })
  }

  private emitEvent(event: AgentEvent) {
    this.emit('event', event)
  }

  private buildMemoryExtractor(args: {
    memoryManager: MemoryManager
    llmProvider?: ILLMProvider
    onMemoryUpdated?: (item: { filename: string; name: string; type: string }) => void
  }) {
    return new MemoryExtractor({ ...args, mode: this.memoryExtraction })
  }

  setProvider(provider: ILLMProvider) {
    this.provider = provider
    this.compactor = new ContextCompactor({
      llmProvider: this.provider
    })
    this.memoryExtractor = this.buildMemoryExtractor({
      memoryManager: this.memoryManager,
      llmProvider: this.provider,
      onMemoryUpdated: (item) => {
        this.emitEvent({
          type: 'memory_updated',
          filename: item.filename,
          name: item.name,
          memoryType: item.type
        })
      }
    })
  }

  setWorkspaceRoot(root: string) {
    this.workspaceRoot = root
    this.memoryManager = new MemoryManager({ workspaceRoot: root })
    this.projectInstructions = new ProjectInstructions(root)
    this.sandboxGuard = new SandboxGuard({ workspaceRoot: root })
    this.memoryExtractor = this.buildMemoryExtractor({
      memoryManager: this.memoryManager,
      llmProvider: this.provider,
      onMemoryUpdated: (item) => {
        this.emitEvent({
          type: 'memory_updated',
          filename: item.filename,
          name: item.name,
          memoryType: item.type
        })
      }
    })
  }

  public getProvider(): ILLMProvider {
    return this.provider
  }

  public getSlashDispatcher(): SlashCommandDispatcher {
    return this.slashDispatcher
  }

  public getMemoryManager(): MemoryManager {
    return this.memoryManager
  }

  public getProjectInstructions(): ProjectInstructions {
    return this.projectInstructions
  }

  public getCompactor(): ContextCompactor {
    return this.compactor
  }

  public getMemoryExtractor(): MemoryExtractor {
    return this.memoryExtractor
  }

  public getPermissionEngine(): PermissionEngine {
    return this.permissionEngine
  }

  public getSandboxGuard(): SandboxGuard {
    return this.sandboxGuard
  }

  public getToolSearchManager(): ToolSearchManager {
    return this.toolSearchManager
  }

  abort() {
    logger.warn('AgentEngine', 'Agent execution aborted by user')
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = undefined
    }
    // Reject any pending approvals
    for (const [id, item] of this.pendingApprovals.entries()) {
      item.resolve({ approved: false })
      this.pendingApprovals.delete(id)
    }
    this.earlyResponses.clear()
    this.setStatus('idle', 'Agent execution was aborted.')
  }

  respondApproval(
    requestId: string,
    approved: boolean,
    reason?: string,
    updatedInput?: Record<string, unknown>
  ) {
    const pending = this.pendingApprovals.get(requestId)
    if (pending) {
      pending.rejectReason = reason
      pending.resolve({ approved, updatedInput })
      this.pendingApprovals.delete(requestId)
    } else {
      this.earlyResponses.set(requestId, { approved, updatedInput })
    }
  }

  private async handleApprovalRequired(request: ApprovalRequest): Promise<ApprovalVerdict> {
    if (this.permissionMode === 'bypass') {
      return { approved: true }
    }
    const early = this.earlyResponses.get(request.id)
    if (early) {
      this.earlyResponses.delete(request.id)
      return early
    }
    return new Promise<ApprovalVerdict>((resolve) => {
      this.pendingApprovals.set(request.id, { resolve })
    })
  }

  async run(
    userPrompt: string,
    options?: {
      sessionId?: string
      initialMessages?: LLMMessage[]
    }
  ): Promise<QueryTerminal> {
    if (this.status === 'awaiting_confirmation') {
      logger.warn('AgentEngine', 'Agent was awaiting confirmation, auto-aborting previous turn to accept new prompt')
      this.abort()
    } else if (this.status !== 'idle' && this.status !== 'completed' && this.status !== 'error') {
      throw new Error(`Agent is already busy with status: ${this.status}`)
    }

    // Intercept slash commands
    if (userPrompt.trim().startsWith('/')) {
      const slashRes = await this.slashDispatcher.dispatch(userPrompt)
      if (slashRes.handled) {
        const reply = slashRes.output || ''
        this.conversationHistory.push({ role: 'user', content: userPrompt })
        this.conversationHistory.push({ role: 'assistant', content: reply })
        this.emitEvent({ type: 'message_delta', delta: reply })
        this.setStatus('completed', 'Command executed.')
        return {
          reason: 'completed',
          messages: this.conversationHistory
        }
      }
    }

    logger.info('AgentEngine', `Starting turn for user prompt: "${userPrompt.slice(0, 100)}" (${userPrompt.length} chars)`)

    this.currentAbortController = new AbortController()
    const signal = this.currentAbortController.signal

    await this.refreshSystemPrompt()

    if (options?.initialMessages && options.initialMessages.length > 0) {
      this.setConversationHistory(options.initialMessages)
    }

    this.conversationHistory.push({
      role: 'user',
      content: userPrompt
    })

    this.conversationHistory = sanitizeConversationHistory(this.conversationHistory)

    // Two-stage Token Budget Compaction (1:1 with Claude Code)
    // Stage 1: Fast zero-LLM microcompaction of historical tool outputs
    if (this.compactor.needsCompaction(this.conversationHistory)) {
      const microRes = this.compactor.microcompactToolResults(this.conversationHistory)
      if (microRes.compacted) {
        this.conversationHistory = microRes.messages
        logger.info('AgentEngine', `Microcompaction cleared ${microRes.clearedCount} tool results, saved ~${microRes.savedTokens} tokens`)
        this.emitEvent({ type: 'compacted', savedTokens: microRes.savedTokens })
      }
    }

    // Stage 2: Full LLM macro-compaction if still above threshold
    if (this.compactor.needsCompaction(this.conversationHistory)) {
      const compactRes = await this.compactor.compactHistory(this.conversationHistory)
      if (compactRes.compacted) {
        this.conversationHistory = compactRes.messages
        logger.info('AgentEngine', `Conversation compacted, saved ~${compactRes.savedTokens} tokens`)
        this.emitEvent({ type: 'compacted', savedTokens: compactRes.savedTokens })
      }
    }

    const queryStream = query({
      messages: this.conversationHistory,
      toolRegistry: this.toolRegistry,
      orchestrator: this.orchestrator,
      provider: this.provider,
      workspaceRoot: this.workspaceRoot,
      sessionId: options?.sessionId,
      toolSearchManager: this.toolSearchManager,
      fileHistoryTracker: this.fileHistoryTracker,
      permissionMode: this.permissionMode,
      permissionEngine: this.permissionEngine,
      sandboxGuard: this.sandboxGuard,
      docConflict: this.docConflict,
      maxTurns: this.maxSteps,
      signal,
      onApprovalRequired: (req) => this.handleApprovalRequired(req),
      onTerminalOutput: (chunk) => {
        this.emitEvent({ type: 'terminal_output', chunk })
      }
    })

    let terminal: QueryTerminal = {
      reason: 'error',
      messages: this.conversationHistory,
      error: 'Query terminated unexpectedly'
    }

    try {
      while (true) {
        const next = await queryStream.next()
        if (next.done) {
          terminal = next.value
          break
        }

        const event = next.value
        if (event.type === 'status_change') {
          this.status = event.status
        }
        this.emitEvent(event)
      }

      this.conversationHistory = terminal.messages

      if (terminal.reason === 'completed') {
        logger.info('AgentEngine', 'Turn completed successfully')
        this.setStatus('completed', 'Task finished successfully.')

        // Trigger background memory extraction (non-blocking)
        this.memoryExtractor.extractFromTurn(terminal.messages).catch((err) => {
          logger.warn('AgentEngine', `Background memory extraction error: ${err?.message || err}`)
        })
      } else if (terminal.reason === 'aborted') {
        logger.warn('AgentEngine', 'Turn was aborted')
        this.setStatus('idle', 'Execution cancelled.')
      } else if (terminal.reason === 'max_turns') {
        logger.warn('AgentEngine', `Agent reached maximum step limit (${this.maxSteps})`)
        this.setStatus('error', `Agent reached maximum step limit (${this.maxSteps}). Halting.`)
      } else if (terminal.reason === 'error') {
        logger.error('AgentEngine', `Turn encountered error: ${terminal.error}`)
        this.setStatus('error', terminal.error || 'Agent encountered an error.')
      }

      // Record file history snapshot for rollback/undo (1:1 with Claude Code fileHistory)
      this.fileHistoryTracker.createSnapshot()

      return terminal
    } catch (err: any) {
      if (signal.aborted) {
        logger.warn('AgentEngine', 'Turn execution cancelled mid-flight')
        this.setStatus('idle', 'Execution cancelled.')
        return { reason: 'aborted', messages: this.conversationHistory }
      } else {
        logger.error('AgentEngine', `Agent run encountered unhandled error: ${err?.message || String(err)}`, err)
        this.setStatus('error', err?.message || String(err))
        this.emitEvent({ type: 'error', message: err?.message || String(err) })
        return { reason: 'error', messages: this.conversationHistory, error: err?.message || String(err) }
      }
    } finally {
      this.currentAbortController = undefined
    }
  }
}
