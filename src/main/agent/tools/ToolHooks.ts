import { ToolContext } from './ToolRegistry'

export interface PreToolUseResult {
  decision: 'allow' | 'block'
  reason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export interface PostToolUseResult {
  modifiedOutput?: string
  additionalContext?: string
}

export interface PostToolUseFailureResult {
  recoveredOutput?: string
  sanitizedError?: string
}

export type PreToolUseHookFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolContext
) => Promise<PreToolUseResult | void> | PreToolUseResult | void

export type PostToolUseHookFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  context: ToolContext
) => Promise<PostToolUseResult | void> | PostToolUseResult | void

export type PostToolUseFailureHookFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  error: Error,
  context: ToolContext
) => Promise<PostToolUseFailureResult | void> | PostToolUseFailureResult | void

/**
 * 1:1 with Claude Code src/services/tools/toolHooks.ts:
 * Central lifecycle hook pipeline allowing decoupled interception, input transformation,
 * audit logging, security boundary enforcement, and post-call recovery.
 */
export class ToolHookRegistry {
  private preHooks: PreToolUseHookFn[] = []
  private postHooks: PostToolUseHookFn[] = []
  private failureHooks: PostToolUseFailureHookFn[] = []

  registerPreToolHook(hook: PreToolUseHookFn): () => void {
    this.preHooks.push(hook)
    return () => {
      this.preHooks = this.preHooks.filter((h) => h !== hook)
    }
  }

  registerPostToolHook(hook: PostToolUseHookFn): () => void {
    this.postHooks.push(hook)
    return () => {
      this.postHooks = this.postHooks.filter((h) => h !== hook)
    }
  }

  registerFailureHook(hook: PostToolUseFailureHookFn): () => void {
    this.failureHooks.push(hook)
    return () => {
      this.failureHooks = this.failureHooks.filter((h) => h !== hook)
    }
  }

  async executePreToolHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: ToolContext
  ): Promise<PreToolUseResult> {
    let currentInput = { ...toolInput }
    let accumulatedContext = ''

    for (const hook of this.preHooks) {
      const res = await hook(toolName, currentInput, context)
      if (!res) continue

      if (res.decision === 'block') {
        return {
          decision: 'block',
          reason: res.reason || `Execution blocked by PreToolUse hook for "${toolName}"`,
          updatedInput: currentInput,
          additionalContext: accumulatedContext || undefined
        }
      }

      if (res.updatedInput) {
        currentInput = { ...currentInput, ...res.updatedInput }
      }

      if (res.additionalContext) {
        accumulatedContext += (accumulatedContext ? '\n' : '') + res.additionalContext
      }
    }

    return {
      decision: 'allow',
      updatedInput: currentInput,
      additionalContext: accumulatedContext || undefined
    }
  }

  async executePostToolHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    context: ToolContext
  ): Promise<PostToolUseResult> {
    let currentOutput = toolOutput
    let accumulatedContext = ''

    for (const hook of this.postHooks) {
      const res = await hook(toolName, toolInput, currentOutput, context)
      if (!res) continue

      if (res.modifiedOutput !== undefined) {
        currentOutput = res.modifiedOutput
      }

      if (res.additionalContext) {
        accumulatedContext += (accumulatedContext ? '\n' : '') + res.additionalContext
      }
    }

    return {
      modifiedOutput: currentOutput !== toolOutput ? currentOutput : undefined,
      additionalContext: accumulatedContext || undefined
    }
  }

  async executeFailureHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: Error,
    context: ToolContext
  ): Promise<PostToolUseFailureResult> {
    let recoveredOutput: string | undefined
    let sanitizedError: string | undefined

    for (const hook of this.failureHooks) {
      const res = await hook(toolName, toolInput, error, context)
      if (!res) continue

      if (res.recoveredOutput !== undefined) {
        recoveredOutput = res.recoveredOutput
      }
      if (res.sanitizedError !== undefined) {
        sanitizedError = res.sanitizedError
      }
    }

    return {
      recoveredOutput,
      sanitizedError
    }
  }

  clear(): void {
    this.preHooks = []
    this.postHooks = []
    this.failureHooks = []
  }
}

// Global default singleton for convenience
export const globalToolHooks = new ToolHookRegistry()
