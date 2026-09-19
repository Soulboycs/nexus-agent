import { ToolRegistry } from '../tools/ToolRegistry'
import { ToolOrchestrator } from '../../../agent/core/ToolOrchestrator'
import { query } from '../../../agent/core/query'
import type { ILLMProvider, LLMMessage } from '../providers/LLMProvider'
import { READ_ONLY_TOOLS } from '../permissions/PermissionEngine'
import type { PermissionEngine } from '../permissions/PermissionEngine'
import type { SandboxGuard } from '../sandbox/SandboxGuard'
import type { ApprovalRequest, ApprovalVerdict, PermissionMode } from '@shared/types'
import type { SubagentRunResult, SubagentType } from './types'

export interface SubagentEngineOptions {
  subagentType: SubagentType
  workspaceRoot: string
  provider: ILLMProvider
  parentToolRegistry: ToolRegistry
  maxTurns?: number
  /** Parent's permission mode (threaded from ToolContext). Defaults to 'ask'. */
  permissionMode?: PermissionMode
  permissionEngine?: PermissionEngine
  sandboxGuard?: SandboxGuard
  /**
   * Parent's approval callback. Subagents cannot show UI themselves — when
   * absent, every ask FAILS CLOSED (auto-deny), mirroring Claude Code's
   * shouldAvoidPermissionPrompts for background agents.
   */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean | ApprovalVerdict>
}

export class SubagentEngine {
  private subagentType: SubagentType
  private workspaceRoot: string
  private provider: ILLMProvider
  private toolRegistry: ToolRegistry
  private orchestrator: ToolOrchestrator
  private conversationHistory: LLMMessage[] = []
  private maxTurns: number
  private permissionMode: PermissionMode
  private permissionEngine?: PermissionEngine
  private sandboxGuard?: SandboxGuard
  private onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean | ApprovalVerdict>

  constructor(options: SubagentEngineOptions) {
    this.subagentType = options.subagentType
    this.workspaceRoot = options.workspaceRoot
    this.provider = options.provider
    this.maxTurns = options.maxTurns ?? 15
    this.permissionMode = options.permissionMode ?? 'ask'
    this.permissionEngine = options.permissionEngine
    this.sandboxGuard = options.sandboxGuard
    this.onApprovalRequired = options.onApprovalRequired
    this.toolRegistry = new ToolRegistry()

    // Filter tools based on subagent capability
    const allTools = options.parentToolRegistry.getAllTools()
    for (const tool of allTools) {
      if (this.subagentType === 'Explore' || this.subagentType === 'Plan') {
        if (READ_ONLY_TOOLS.has(tool.name)) {
          this.toolRegistry.registerTool(tool)
        }
      } else {
        this.toolRegistry.registerTool(tool)
      }
    }

    this.orchestrator = new ToolOrchestrator(this.toolRegistry)
    this.initSystemPrompt()
  }

  public getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  public getSystemPrompt(): string {
    return this.conversationHistory[0]?.content || ''
  }

  public getConversationHistory(): LLMMessage[] {
    return [...this.conversationHistory]
  }

  private initSystemPrompt(): void {
    let prompt = ''
    if (this.subagentType === 'Explore') {
      prompt = `You are an expert codebase exploration subagent.
Your mission is to thoroughly navigate, grep, find, and inspect files to answer queries.

CRITICAL CONSTRAINT: READ-ONLY EXPLORATION
You strictly have read-only inspection tools. You cannot write or mutate files.
Gather all relevant context and deliver a clear, concise final summary of your findings.`
    } else if (this.subagentType === 'Plan') {
      prompt = `You are a software architect and implementation planning subagent.
Your mission is to analyze codebase requirements and produce a structured Implementation Plan.
Review existing code patterns, list dependencies, edge cases, and step-by-step verification milestones.`
    } else {
      prompt = `You are an autonomous subagent executing a dedicated task.
Focus exclusively on the delegated instructions and provide a complete summary of your results.`
    }

    this.conversationHistory = [
      {
        role: 'system',
        content: prompt
      }
    ]
  }

  /**
   * Runs the subagent loop in isolation from the parent session.
   */
  public async run(taskPrompt: string): Promise<SubagentRunResult> {
    this.conversationHistory.push({
      role: 'user',
      content: taskPrompt
    })

    const queryStream = query({
      messages: this.conversationHistory,
      toolRegistry: this.toolRegistry,
      orchestrator: this.orchestrator,
      provider: this.provider,
      workspaceRoot: this.workspaceRoot,
      // Inherit the parent's gate context instead of blanket bypass: the
      // restricted registry scopes Explore/Plan, and every ask still reaches
      // the parent's approval flow (or auto-denies when none exists).
      permissionMode: this.permissionMode,
      permissionEngine: this.permissionEngine,
      sandboxGuard: this.sandboxGuard,
      onApprovalRequired:
        this.onApprovalRequired ?? (async () => false),
      maxTurns: this.maxTurns
    })

    let terminal: any
    while (true) {
      const next = await queryStream.next()
      if (next.done) {
        terminal = next.value
        break
      }
    }

    this.conversationHistory = terminal.messages

    // Extract the final assistant message content
    const lastAssistant = [...terminal.messages].reverse().find((m: LLMMessage) => m.role === 'assistant' && m.content)
    const summary = lastAssistant?.content || 'Subagent completed task with no textual summary.'

    return {
      reason: terminal.reason === 'max_turns' ? 'error' : terminal.reason,
      summary
    }
  }
}
