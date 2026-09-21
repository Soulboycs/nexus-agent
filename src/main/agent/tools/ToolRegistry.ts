import { z } from 'zod'
import { ToolResultPayload, ApprovalRequest, ApprovalVerdict, PermissionMode } from '@shared/types'
import type { ToolDescriptionContext } from '../utils/toolSchemas'
import type { PermissionEngine } from '../permissions/PermissionEngine'
import type { SandboxGuard } from '../sandbox/SandboxGuard'
import { ToolHookRegistry } from './ToolHooks'
import { processToolResult } from './ToolResultStorage'

export interface ToolContext {
  workspaceRoot: string
  sessionId?: string
  toolCallId?: string
  /** True when the user edited the tool input in the approval dialog (1:1 Claude Code userModified). */
  userModified?: boolean
  fileHistoryTracker?: any
  emitTerminalOutput?: (chunk: string) => void
  onProgress?: (chunk: string) => void
  signal?: AbortSignal
  // Permission/sandbox/approval context (subagents thread these into their own
  // query loop — 1:1 Claude Code canUseTool propagation through createSubagentContext).
  permissionMode?: PermissionMode
  /** Read current mode (PlanMode tools switch modes from inside a tool). */
  getPermissionMode?: () => PermissionMode
  setPermissionMode?: (mode: PermissionMode) => void
  permissionEngine?: PermissionEngine
  sandboxGuard?: SandboxGuard
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean | ApprovalVerdict>
  /** Surfaces AgentEvents from nested execution (e.g. subagent approvals) into the host loop. */
  emitAgentEvent?: (event: import('@shared/types').AgentEvent) => void
}

export interface ValidationResult {
  result: boolean
  message?: string
  errorCode?: number
}

export interface AgentTool<TArgs = any> {
  name: string
  /** Static text, or a function resolved per-request (P3 dynamic descriptions). */
  description: string | ((ctx: ToolDescriptionContext) => string)
  parameters: z.ZodType<TArgs>
  
  // Aliases for backwards compatibility and deprecation migration
  aliases?: string[]
  // Short capability hint for ToolSearch keyword matching (3-10 words)
  searchHint?: string
  // When true, deferred until discovered via tool_search
  shouldDefer?: boolean
  // When true, never deferred even if deferred search is active
  alwaysLoad?: boolean
  // Maximum size in characters before spilling to disk (default: 50,000; Infinity: never persist)
  maxResultSizeChars?: number
  
  // Safety, scheduling and behavioral flags
  requiresApproval?: (args: TArgs) => boolean
  /** 1:1 cc requiresUserInteraction: the tool needs the user in the loop to complete. */
  requiresUserInteraction?: boolean
  isReadOnly?: (args?: TArgs) => boolean
  isConcurrencySafe?: (args?: TArgs) => boolean
  isDestructive?: (args?: TArgs) => boolean
  interruptBehavior?: () => 'cancel' | 'block'
  
  // UI & observability metadata
  userFacingName?: (args?: Partial<TArgs>) => string
  getActivityDescription?: (args?: Partial<TArgs>) => string | null
  getToolUseSummary?: (args?: Partial<TArgs>) => string | null
  toAutoClassifierInput?: (args: TArgs) => unknown
  
  // Tool-specific semantic validation before execution
  validateInput?: (args: TArgs, context: ToolContext) => Promise<ValidationResult>

  // Tool-level permission semantics (1:1 Claude Code Tool.checkPermissions):
  // deny short-circuits with a structured error; ask forces HITL approval;
  // allow may carry updatedInput (the permission layer rewrites the input —
  // e.g. path normalization — applied after a sandbox re-check).
  checkPermissions?: (
    args: TArgs,
    context: ToolContext
  ) => Promise<{
    behavior: 'allow' | 'deny' | 'ask'
    message?: string
    updatedInput?: Record<string, unknown>
  }>
  
  // MCP protocol metadata
  isMcp?: boolean
  mcpInfo?: { serverName: string; toolName: string }
  
  execute: (args: TArgs, context: ToolContext) => Promise<string>
}

function normalizeRawArgs(schema: z.ZodType<any>, rawArgs: Record<string, unknown>): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== 'object') return rawArgs
  const result: Record<string, unknown> = { ...rawArgs }
  const shape = (schema as any)._def?.shape?.() || (schema as any)._def?.shape
  if (!shape) return result

  for (const [key, val] of Object.entries(result)) {
    let s = shape[key]
    if (!s) continue
    while (s?._def?.innerType || s?._def?.schema) {
      s = s._def.innerType || s._def.schema
    }
    const typeName = s?._def?.typeName
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (typeName === 'ZodBoolean') {
        if (trimmed.toLowerCase() === 'true') result[key] = true
        if (trimmed.toLowerCase() === 'false') result[key] = false
      } else if (typeName === 'ZodNumber') {
        const num = Number(trimmed)
        if (!isNaN(num)) result[key] = num
      } else if (typeName === 'ZodArray' || typeName === 'ZodObject') {
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
          try {
            result[key] = JSON.parse(trimmed)
          } catch {}
        }
      }
    }
  }
  return result
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()
  private aliasMap = new Map<string, string>()
  private hooks = new ToolHookRegistry()

  getHooks(): ToolHookRegistry {
    return this.hooks
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
    if (tool.aliases && Array.isArray(tool.aliases)) {
      for (const alias of tool.aliases) {
        this.aliasMap.set(alias, tool.name)
      }
    }
  }

  getTool(name: string): AgentTool | undefined {
    const direct = this.tools.get(name)
    if (direct) return direct
    const canonicalName = this.aliasMap.get(name)
    if (canonicalName) {
      return this.tools.get(canonicalName)
    }
    return undefined
  }

  /**
   * 1:1 with Claude Code Prompt Cache stability:
   * Partition tools into [builtIn, mcp] and sort each group alphabetically.
   * Built-in tools remain a contiguous stable prefix to maximize LLM cache hit rate!
   */
  getAllTools(options?: { stableSort?: boolean }): AgentTool[] {
    const all = Array.from(this.tools.values())
    if (options?.stableSort === false) {
      return all
    }
    const builtIn: AgentTool[] = []
    const mcp: AgentTool[] = []

    for (const t of all) {
      if (t.isMcp) {
        mcp.push(t)
      } else {
        builtIn.push(t)
      }
    }

    const byName = (a: AgentTool, b: AgentTool) => a.name.localeCompare(b.name)
    return [...builtIn.sort(byName), ...mcp.sort(byName)]
  }

  /**
   * Filter active tools for prompt injection, accounting for deferred loading.
   */
  getActiveTools(discoveredNames?: Set<string>): AgentTool[] {
    const all = this.getAllTools()
    return all.filter((tool) => {
      if (!tool.shouldDefer) return true
      if (tool.alwaysLoad) return true
      return discoveredNames?.has(tool.name) ?? false
    })
  }

  async executeTool(
    name: string,
    rawArgs: Record<string, unknown> | string,
    context: ToolContext
  ): Promise<ToolResultPayload> {
    const tool = this.getTool(name)
    if (!tool) {
      return {
        toolCallId: context.toolCallId || '',
        name,
        error: `Tool "${name}" is not registered. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
        isError: true
      }
    }

    if (context.signal?.aborted) {
      return {
        toolCallId: context.toolCallId || '',
        name,
        error: `Tool execution aborted before invocation`,
        isError: true
      }
    }

    let parsedRaw: Record<string, unknown> = {}
    if (typeof rawArgs === 'string') {
      try {
        parsedRaw = JSON.parse(rawArgs)
      } catch {
        parsedRaw = {}
      }
    } else {
      parsedRaw = rawArgs || {}
    }

    try {
      let normalizedArgs = normalizeRawArgs(tool.parameters, parsedRaw)

      // 1. PreToolUse Hook execution
      const preRes = await this.hooks.executePreToolHooks(name, normalizedArgs, context)
      if (preRes.decision === 'block') {
        return {
          toolCallId: context.toolCallId || '',
          name,
          error: preRes.reason || `Execution blocked by PreToolUse hook for "${name}"`,
          isError: true
        }
      }

      if (preRes.updatedInput) {
        normalizedArgs = normalizeRawArgs(tool.parameters, preRes.updatedInput)
      }

      const parsedArgs = tool.parameters.parse(normalizedArgs)

      // 2. Semantic validation hook if defined
      if (tool.validateInput) {
        const validation = await tool.validateInput(parsedArgs, context)
        if (!validation.result) {
          return {
            toolCallId: context.toolCallId || '',
            name,
            error: validation.message || `Validation failed for tool "${name}"`,
            isError: true
          }
        }
      }

      // 3. Main execution
      let output = await tool.execute(parsedArgs, context)

      // 4. PostToolUse Hook execution
      const postRes = await this.hooks.executePostToolHooks(name, parsedArgs, output, context)
      if (postRes.modifiedOutput !== undefined) {
        output = postRes.modifiedOutput
      }

      // 5. Tool Result Storage & Disk Spillover (persists large output to disk if > 50K chars and not Infinity)
      const storageRes = await processToolResult(tool, output, context.toolCallId || '', {
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId
      })
      output = storageRes.output

      return {
        toolCallId: context.toolCallId || '',
        name,
        output,
        isError: false
      }
    } catch (err: any) {
      // 6. PostToolUseFailure Hook execution
      const failureRes = await this.hooks.executeFailureHooks(name, parsedRaw, err, context)
      if (failureRes.recoveredOutput !== undefined) {
        return {
          toolCallId: context.toolCallId || '',
          name,
          output: failureRes.recoveredOutput,
          isError: false
        }
      }

      const errorMsg = failureRes.sanitizedError || (
        err instanceof z.ZodError
          ? `Invalid tool arguments for ${name}: ${JSON.stringify(err.format())}`
          : err?.message || String(err)
      )
      return {
        toolCallId: context.toolCallId || '',
        name,
        error: errorMsg,
        isError: true
      }
    }
  }
}
