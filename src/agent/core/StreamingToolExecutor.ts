import { ToolRegistry } from '../../main/agent/tools/ToolRegistry'
import { AgentEvent, ToolResultPayload } from '../../shared/types'
import { ToolContext } from '../tools/ToolTypes'
import { ToolCallSpec } from './ToolOrchestrator'

type ToolState = 'queued' | 'executing' | 'completed' | 'yielded'

interface TrackedTool {
  spec: ToolCallSpec
  status: ToolState
  isConcurrencySafe: boolean
  promise?: Promise<ToolResultPayload>
  result?: ToolResultPayload
}

/**
 * Verdict returned by the per-tool gate (1:1 with Claude Code runToolUse's
 * validation→permissions pipeline, which runs inside streaming execution).
 * - allowed + optional args replacement (approval-time input editing)
 * - denied → the executor completes with the given synthetic result
 */
export type GateVerdict =
  | { allowed: true; args?: Record<string, unknown>; userModified?: boolean }
  | { allowed: false; result: ToolResultPayload }

export interface StreamingExecutorHooks {
  /** Runs before registry.executeTool; enforces deferred-hint / sandbox / permission / HITL gates. */
  gate?: (spec: ToolCallSpec, args: Record<string, unknown>, ctx: ToolContext) => Promise<GateVerdict>
  /** Surfaces gate-emitted AgentEvents (tool_call_start / approval_required / ...) immediately. */
  onEvent?: (event: AgentEvent) => void
  /** Fired whenever a tool settles — wakes consumer loops draining results. */
  onSettled?: () => void
}

export const MAX_CONCURRENT_STREAMING_TOOLS = 10

/**
 * 1:1 with Claude Code getMaxToolUseConcurrency: env override for the tool
 * concurrency pool ceiling.
 */
export function getMaxConcurrentStreamingTools(): number {
  const parsed = parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_CONCURRENT_STREAMING_TOOLS
}

export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private siblingAbort = new AbortController()
  private isDiscarded = false
  /** Description of the tool whose error triggered sibling cancellation (cc erroredToolDescription). */
  private erroredToolDescription = ''

  constructor(
    private registry: ToolRegistry,
    private baseContext: ToolContext,
    private onProgress?: (id: string, chunk: string) => void,
    private hooks?: StreamingExecutorHooks
  ) {
    // Chain to the query-level signal so a user abort kills running tools
    // (1:1 with Claude Code createChildAbortController(toolUseContext.abortController)).
    baseContext.signal?.addEventListener('abort', () => this.siblingAbort.abort(), { once: true })
  }

  /**
   * Discards all pending and executing tools (1:1 with Claude Code StreamingToolExecutor.discard)
   */
  discard(): void {
    this.isDiscarded = true
    this.siblingAbort.abort()
    for (const tool of this.tools) {
      if (tool.status === 'queued') {
        tool.status = 'completed'
        tool.result = {
          toolCallId: tool.spec.id,
          name: tool.spec.name,
          error: 'Execution cancelled (streaming discarded)',
          isError: true
        }
      }
    }
  }

  addTool(spec: ToolCallSpec): void {
    if (this.isDiscarded) {
      this.tools.push({
        spec,
        status: 'completed',
        isConcurrencySafe: true,
        result: {
          toolCallId: spec.id,
          name: spec.name,
          error: 'Execution cancelled (streaming discarded)',
          isError: true
        }
      })
      return
    }

    const tool = this.registry.getTool(spec.name) as any
    let parsedArgs = spec.arguments
    if (typeof spec.arguments === 'string') {
      try {
        parsedArgs = JSON.parse(spec.arguments)
      } catch {
        parsedArgs = {}
      }
    }

    const isConcurrencySafe = Boolean(
      tool?.isConcurrencySafe?.(parsedArgs) ?? tool?.isReadOnly?.(parsedArgs)
    )

    const tracked: TrackedTool = {
      spec,
      status: 'queued',
      isConcurrencySafe,
    }
    this.tools.push(tracked)
    void this.processQueue()
  }

  private canExecute(isConcurrencySafe: boolean): boolean {
    const running = this.tools.filter((t) => t.status === 'executing')
    if (running.length === 0) return true
    if (running.length >= getMaxConcurrentStreamingTools()) return false
    return isConcurrencySafe && running.every((t) => t.isConcurrencySafe)
  }

  private async processQueue(): Promise<void> {
    if (this.isDiscarded) return

    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecute(tool.isConcurrencySafe)) {
        this.execute(tool)
      } else {
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  /**
   * 1:1 cc createSyntheticErrorMessage('sibling_error'): queued siblings are
   * completed with a synthetic error instead of being started. In-flight tools
   * receive the siblingAbort signal and are expected to honour it.
   */
  private cancelQueuedForSiblingError(): void {
    if (this.isDiscarded) return
    const msg = this.erroredToolDescription
      ? `Cancelled: parallel tool call ${this.erroredToolDescription} errored`
      : 'Cancelled: parallel tool call errored'
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue
      tool.status = 'completed'
      tool.result = {
        toolCallId: tool.spec.id,
        name: tool.spec.name,
        error: msg,
        isError: true,
      }
    }
  }

  private describeTool(spec: ToolCallSpec): string {
    const args = this.parseArgs(spec) as Record<string, unknown>
    const summary = args?.command ?? args?.filePath ?? args?.dirPath ?? args?.pattern ?? ''
    const truncated =
      typeof summary === 'string' && summary.length > 0
        ? summary.length > 40
          ? summary.slice(0, 40) + '…'
          : summary
        : ''
    return truncated ? `${spec.name}(${truncated})` : spec.name
  }

  private parseArgs(spec: ToolCallSpec): Record<string, unknown> {
    if (typeof spec.arguments === 'string') {
      try {
        return JSON.parse(spec.arguments)
      } catch {
        return {}
      }
    }
    const args = (spec.arguments as Record<string, unknown>) || {}
    // Provider JSON-parse fallbacks hand lenient tools { raw: "<garbage>" } as
    // parsed args ( AnthropicProvider et al catch → { raw: argsStr } ). Recover
    // the JSON when possible; otherwise execute with empty args instead of
    // feeding the raw string to z.record(z.any())-style schemas.
    if (
      Object.keys(args).length === 1 &&
      typeof args.raw === 'string'
    ) {
      try {
        const recovered = JSON.parse(args.raw)
        if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
          return recovered
        }
      } catch {
        // not JSON — fall through to {}
      }
      return {}
    }
    return args
  }

  private execute(tool: TrackedTool): void {
    tool.status = 'executing'

    const childSignal = this.siblingAbort.signal
    const ctx: ToolContext = {
      ...this.baseContext,
      toolCallId: tool.spec.id,
      signal: childSignal,
      emitTerminalOutput: this.baseContext.emitTerminalOutput,
      onProgress: (chunk) => this.onProgress?.(tool.spec.id, chunk),
      // Routes nested-execution events (subagent approvals) into the host loop.
      emitAgentEvent: (event) => this.hooks?.onEvent?.(event),
    }

    tool.promise = (async () => {
      let finalArgs = this.parseArgs(tool.spec)

      if (this.hooks?.gate) {
        const verdict = await this.hooks.gate(tool.spec, finalArgs, ctx)
        if (this.isDiscarded) {
          return {
            toolCallId: tool.spec.id,
            name: tool.spec.name,
            error: 'Execution cancelled (streaming discarded)',
            isError: true,
          } as ToolResultPayload
        }
        if (!verdict.allowed) {
          return verdict.result
        }
        if (verdict.args) finalArgs = verdict.args
        if (verdict.userModified) ctx.userModified = true
      }

      if (this.isDiscarded) {
        return {
          toolCallId: tool.spec.id,
          name: tool.spec.name,
          error: 'Execution cancelled (streaming discarded)',
          isError: true,
        } as ToolResultPayload
      }

      const res = await this.registry.executeTool(tool.spec.name, finalArgs, ctx)
      res.toolCallId = tool.spec.id

      // Sibling cascading abort on critical command failure
      // (1:1 cc: record the failing tool's description so queued siblings get
      // a synthetic "Cancelled: parallel tool call X errored" instead of starting).
      if (res.isError && tool.spec.name === 'run_command') {
        this.erroredToolDescription = this.describeTool(tool.spec)
        this.cancelQueuedForSiblingError()
        this.siblingAbort.abort()
      }
      return res
    })()
      .then((res) => {
        tool.result = res
        tool.status = 'completed'
        return res
      })
      .catch((err) => {
        const errorRes: ToolResultPayload = {
          toolCallId: tool.spec.id,
          name: tool.spec.name,
          error: String(err?.message || err),
          isError: true,
        }
        tool.result = errorRes
        tool.status = 'completed'
        return errorRes
      })
      .finally(() => {
        this.hooks?.onSettled?.()
        void this.processQueue()
      })
  }

  *getCompleted(): Generator<ToolResultPayload, void> {
    for (const tool of this.tools) {
      if (tool.status === 'yielded') continue
      if (tool.status === 'completed' && tool.result) {
        tool.status = 'yielded'
        yield tool.result
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        // Preserve result order: a non-concurrent-safe tool blocks yields of
        // everything behind it (1:1 with Claude Code getCompletedResults break).
        break
      }
    }
  }

  hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== 'yielded')
  }

  async *drainRemaining(): AsyncGenerator<ToolResultPayload, void> {
    while (this.tools.some((t) => t.status !== 'yielded')) {
      if (this.isDiscarded) {
        for (const tool of this.tools) {
          if (tool.status !== 'yielded') {
            tool.status = 'yielded'
            yield tool.result || {
              toolCallId: tool.spec.id,
              name: tool.spec.name,
              error: 'Execution cancelled (streaming discarded)',
              isError: true
            }
          }
        }
        break
      }

      await this.processQueue()
      for (const res of this.getCompleted()) {
        yield res
      }

      const running = this.tools
        .filter((t) => t.status === 'executing' && t.promise)
        .map((t) => t.promise!)

      if (running.length > 0) {
        await Promise.race(running)
      }
    }
  }
}
