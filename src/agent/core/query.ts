import { ToolRegistry } from '../../main/agent/tools/ToolRegistry'
import { ILLMProvider, LLMMessage } from '../../main/agent/providers/LLMProvider'
import { StreamingToolExecutor } from './StreamingToolExecutor'
import type { ToolOrchestrator } from './ToolOrchestrator'
import {
  AgentEvent,
  ApprovalRequest,
  ApprovalVerdict,
  PermissionMode,
  ToolCallPayload,
  ToolResultPayload
} from '../../shared/types'
import { sanitizeConversationHistory } from '../../main/agent/utils/messageSanitizer'
import { resolveToolDescription } from '../../main/agent/utils/toolSchemas'
import type { PermissionEngine } from '../../main/agent/permissions/PermissionEngine'
import type { SandboxGuard } from '../../main/agent/sandbox/SandboxGuard'
import type { DocConflictDetector } from '../../main/agent/utils/docConflictDetector'
import { ToolSearchManager, buildSchemaNotSentHint } from '../../main/agent/tools/ToolSearchTool'
import { isCommandToolName } from '../../main/agent/utils/toolSchemas'
import * as nodePath from 'path'
import * as nodeOs from 'os'

export { sanitizeConversationHistory }

export interface QueryParams {
  messages: LLMMessage[]
  docConflict?: DocConflictDetector
  toolRegistry: ToolRegistry
  /** @deprecated Tool execution now runs through StreamingToolExecutor; kept for callers that still construct one. */
  orchestrator?: ToolOrchestrator
  provider: ILLMProvider
  workspaceRoot: string
  sessionId?: string
  toolSearchManager?: ToolSearchManager
  fileHistoryTracker?: any
  permissionMode?: PermissionMode
  /** Mode read/write threading for in-tool mode switches (EnterPlanMode/ExitPlanMode). */
  getPermissionMode?: () => PermissionMode
  setPermissionMode?: (mode: PermissionMode) => void
  permissionEngine?: PermissionEngine
  sandboxGuard?: SandboxGuard
  maxTurns?: number
  signal?: AbortSignal
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean | ApprovalVerdict>
  onTerminalOutput?: (chunk: string) => void
  onToolProgress?: (toolCallId: string, chunk: string) => void
}

export type QueryState = {
  messages: LLMMessage[]
  turnCount: number
  transition?: string
}

export type QueryTerminal = {
  reason: 'completed' | 'aborted' | 'max_turns' | 'error'
  messages: LLMMessage[]
  error?: string
}

/**
 * 1:1 with Claude Code yieldMissingToolResultBlocks:
 * Ensures all tool_calls produced by an assistant message have matching tool_results.
 * Prevents downstream API 400 errors (dangling tool_use) if execution was aborted mid-stream.
 */
export function compensateMissingToolResults(
  toolCalls: Array<{ id: string; name: string }>,
  completedToolCallIds: Set<string>,
  errorMessage = 'Execution cancelled by user.'
): { syntheticMessages: LLMMessage[]; syntheticEvents: AgentEvent[] } {
  const syntheticMessages: LLMMessage[] = []
  const syntheticEvents: AgentEvent[] = []

  for (const tc of toolCalls) {
    if (!completedToolCallIds.has(tc.id)) {
      const payload: ToolResultPayload = {
        toolCallId: tc.id,
        name: tc.name,
        error: errorMessage,
        isError: true,
      }
      syntheticEvents.push({
        type: 'tool_call_complete',
        result: payload,
      })
      syntheticMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      })
      completedToolCallIds.add(tc.id)
    }
  }

  return { syntheticMessages, syntheticEvents }
}

/**
 * Backfills path-ish fields for OBSERVERS only (1:1 Claude Code
 * backfillObservableInput): tool_call_start events, the approval card and
 * permission rule matching see expanded absolute paths, so users approve
 * exactly what will be touched. Execution keeps the model's original input —
 * tools resolve paths against the workspace themselves and their result
 * strings stay stable.
 */
const OBSERVABLE_PATH_KEYS = ['filePath', 'dirPath', 'TargetFile', 'AbsolutePath', 'path']

export function expandObservablePath(value: string, workspaceRoot: string): string {
  if (!value || typeof value !== 'string') return value
  if (/^[a-z]+:\/\//i.test(value)) return value // URLs are not filesystem paths
  const TILDE_SLASH = '~/' // prettier-ignore
  if (value === '~' || value.startsWith(TILDE_SLASH) || value.startsWith('~' + String.fromCharCode(92))) {
    const rest = value.slice(1).replace(new RegExp('^[\\\\/]'), '')
    return rest ? nodePath.join(nodeOs.homedir(), rest) : nodeOs.homedir()
  }
  if (nodePath.isAbsolute(value)) return value
  return nodePath.resolve(workspaceRoot, value)
}

export function buildObservableArgs(
  args: Record<string, unknown>,
  workspaceRoot: string
): Record<string, unknown> {
  if (!args || typeof args !== 'object') return args
  let changed = false
  const out: Record<string, unknown> = { ...args }
  for (const key of OBSERVABLE_PATH_KEYS) {
    const v = out[key]
    if (typeof v === 'string' && v.length > 0) {
      const expanded = expandObservablePath(v, workspaceRoot)
      if (expanded !== v) {
        out[key] = expanded
        changed = true
      }
    }
  }
  return changed ? out : args
}

/**
 * query(): The core Agent iterative state machine (1:1 with Claude Code src/query.ts).
 * Driven by an AsyncGenerator while(true) loop with state = next assignments instead of recursion.
 *
 * Since P1 the tool phase runs through StreamingToolExecutor: tool_use blocks that
 * complete mid-stream (content_block_stop / response.output_item.done) start
 * executing while the model is still generating, with results yielded in arrival
 * order. The four gates (deferred-tool hint → sandbox → permission engine → HITL)
 * run inside the executor via the per-tool `gate` hook.
 */
export async function* query(params: QueryParams): AsyncGenerator<AgentEvent, QueryTerminal> {
  const maxTurns = params.maxTurns ?? 25
  const signal = params.signal

  let state: QueryState = {
    messages: sanitizeConversationHistory([...params.messages]),
    turnCount: 1,
    transition: undefined,
  }

  while (true) {
    if (signal?.aborted) {
      return { reason: 'aborted', messages: state.messages }
    }

    const { messages, turnCount } = state

    if (turnCount > maxTurns) {
      yield {
        type: 'error',
        message: `Agent reached maximum step limit (${maxTurns}). Halting.`,
      }
      return { reason: 'max_turns', messages }
    }

    yield {
      type: 'status_change',
      status: 'thinking',
      message: `Turn ${turnCount}/${maxTurns}: Analyzing and generating response...`,
    }

    const activeTools = params.toolSearchManager
      ? params.toolRegistry.getActiveTools(params.toolSearchManager.discoveredToolNames)
      : params.toolRegistry.getAllTools()

    // --- Streaming turn plumbing: event queue + wake (1:1 with Claude Code's
    // race-loop between stream chunks, tool completions and permission requests) ---
    const eventQueue: AgentEvent[] = []
    let wakeResolve: (() => void) | undefined
    const wake = () => {
      const r = wakeResolve
      wakeResolve = undefined
      r?.()
    }
    const waitForWake = () => new Promise<void>((resolve) => { wakeResolve = resolve })
    const pushEvent = (event: AgentEvent) => {
      eventQueue.push(event)
      wake()
    }
    const onAbort = () => wake()
    signal?.addEventListener('abort', onAbort)

    const toolResultMessages: LLMMessage[] = []
    const completedToolCallIds = new Set<string>()
    const addedToolCallIds = new Set<string>()
    const addedSpecs = new Map<string, { id: string; name: string }>()
    let forwardedThinkingChars = 0
    let forwardedContentChars = 0
    let streamedContent = ''
    let emittedToolExecuting = false
    let executionError: string | undefined

    const recordResult = (res: ToolResultPayload) => {
      completedToolCallIds.add(res.toolCallId)
      // 1:1 Claude Code modifiedNote: teach the model its input was user-edited.
      // Exactly once on each side: the event payload (UI) gets it appended here;
      // the model-facing message is built from the pre-append value.
      const modifiedNote = userModifiedIds.has(res.toolCallId)
        ? '\n[Note: user modified the tool input during approval]'
        : ''
      const modelSideContent = res.isError
        ? res.error || 'Unknown error'
        : res.output || 'Success'
      if (modifiedNote && !res.isError && res.output) {
        res.output += modifiedNote
      }
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: res.toolCallId,
        content: modelSideContent + modifiedNote,
      })
    }

    const markAdded = (id: string, name: string) => {
      addedToolCallIds.add(id)
      addedSpecs.set(id, { id, name })
    }
    const userModifiedIds = new Set<string>()

    /**
     * The pre-execution gates, moved inside streaming execution (P1).
     * P2b: tool-level checkPermissions (deny/ask) + approval-time updatedInput
     * with a defense-in-depth sandbox re-check on the edited arguments.
     * R3: observers (events, approval card, permission matching) see
     * backfilled absolute paths (1:1 Claude Code backfillObservableInput) while
     * execution keeps the model's original input.
     */
    const runGate = async (
      spec: { id: string; name: string },
      callArgs: Record<string, unknown>
    ): Promise<
      | { allowed: true; args?: Record<string, unknown>; userModified?: boolean }
      | { allowed: false; result: ToolResultPayload }
    > => {
      const tool = params.toolRegistry.getTool(spec.name)
      // Observable copy: expand path-ish fields for display & matching only.
      const observableArgs = buildObservableArgs(callArgs, params.workspaceRoot)
      const emitStart = (requiresApproval: boolean) => {
        const toolPayload: ToolCallPayload = {
          id: spec.id,
          name: spec.name,
          arguments: observableArgs,
          requiresApproval,
          description: tool ? resolveToolDescription(tool) : undefined,
        }
        pushEvent({ type: 'tool_call_start', toolCall: toolPayload })
      }

      // -1. Existence check (1:1 with Claude Code runToolUse step 0): a
      // hallucinated tool name must fail fast — asking the user to approve a
      // nonexistent tool both hangs the turn and leaks a bogus prompt.
      if (!tool) {
        emitStart(false)
        return {
          allowed: false,
          result: {
            toolCallId: spec.id,
            name: spec.name,
            error: `Error: No such tool available: ${spec.name}`,
            isError: true,
          },
        }
      }

      // 0. Deferred Tool Discovery Check (1:1 with Claude Code buildSchemaNotSentHint)
      if (params.toolSearchManager) {
        const hint = buildSchemaNotSentHint(tool, params.toolSearchManager.discoveredToolNames)
        if (hint) {
          emitStart(false)
          return {
            allowed: false,
            result: {
              toolCallId: spec.id,
              name: spec.name,
              error: `Error: Tool schema not sent.${hint}`,
              isError: true,
            },
          }
        }
      }

      // 1. Sandbox Guard check (matches on the backfilled absolute paths)
      if (params.sandboxGuard) {
        let sandboxResult = { passed: true } as any
        if (isCommandToolName(spec.name)) {
          sandboxResult = params.sandboxGuard.validateCommand((observableArgs.CommandLine || observableArgs.command || '') as string)
        } else {
          // NOTE: our file/docx tools use `filePath` and list_directory uses
          // `dirPath` — they MUST stay in this chain. Before P1 the gate only
          // read TargetFile/AbsolutePath/path, which silently disabled the
          // sandbox path jail for every file tool.
          const fileTarget = (
            observableArgs.filePath ||
            observableArgs.dirPath ||
            observableArgs.TargetFile ||
            observableArgs.AbsolutePath ||
            observableArgs.path
          ) as string
          if (fileTarget) {
            sandboxResult = params.sandboxGuard.validateFileTarget(fileTarget)
          }
        }

        if (!sandboxResult.passed) {
          emitStart(false)
          return {
            allowed: false,
            result: {
              toolCallId: spec.id,
              name: spec.name,
              error: `Tool execution blocked by sandbox guard: ${sandboxResult.reason} [${sandboxResult.violation}]`,
              isError: true,
            },
          }
        }
      }

      // 1.2 Document conflict gate(计划 §6.2 规则5):docx 系工具目标文档若正被
      // 其他会话 in-flight 修改 → 拒绝执行并明确报错(agent 可告知用户/稍后重试)。
      // 实现说明:相比计划中的"审批确认"采用直接拒绝——复用审批链路需要跨层
      // 改造 promptMessage 组装;拒绝同样达成"不静默覆盖"的安全目标(偏差已记录)。
      if (params.docConflict && spec.name.startsWith('docx_')) {
        const conflictTarget = (observableArgs.filePath || observableArgs.path) as string | undefined
        if (conflictTarget) {
          const other = params.docConflict.findOther(params.sessionId || '', conflictTarget)
          if (other) {
            emitStart(false)
            return {
              allowed: false,
              result: {
                toolCallId: spec.id,
                name: spec.name,
                error: `DOC_CONFLICT: the document is currently being modified by another session (${other}). Wait for it to finish, then retry.`,
                isError: true,
              },
            }
          }
          params.docConflict.registerCall(spec.id, params.sessionId || '', conflictTarget)
        }
      }

      // 1.5 Tool-level permission semantics (1:1 Claude Code Tool.checkPermissions):
      // deny short-circuits; ask forces HITL even when the engine would allow.
      let requiresApprovalFromTool = false
      if (tool.checkPermissions) {
        const cp = await tool.checkPermissions(callArgs as never, {
          workspaceRoot: params.workspaceRoot,
          sessionId: params.sessionId,
          toolCallId: spec.id,
        })
        if (cp.behavior === 'deny') {
          emitStart(false)
          return {
            allowed: false,
            result: {
              toolCallId: spec.id,
              name: spec.name,
              error: `Tool denied by its own permission policy${cp.message ? `: ${cp.message}` : ''}`,
              isError: true,
            },
          }
        }
        if (cp.behavior === 'ask') {
          requiresApprovalFromTool = true
        }
        // 1:1 cc toolExecution: a permission-layer allow may rewrite the input
        // (permissionDecision.updatedInput). Applied after a sandbox re-check;
        // NOT flagged userModified — that marker is reserved for human edits.
        if (cp.behavior === 'allow' && cp.updatedInput) {
          const edited = cp.updatedInput
          if (params.sandboxGuard) {
            let sandboxResult = { passed: true } as any
            if (isCommandToolName(spec.name)) {
              sandboxResult = params.sandboxGuard.validateCommand(
                (edited.CommandLine || edited.command || '') as string
              )
            } else {
              const fileTarget = (
                edited.filePath || edited.dirPath || edited.TargetFile || edited.AbsolutePath || edited.path
              ) as string
              if (fileTarget) {
                sandboxResult = params.sandboxGuard.validateFileTarget(fileTarget)
              }
            }
            if (!sandboxResult.passed) {
              emitStart(false)
              return {
                allowed: false,
                result: {
                  toolCallId: spec.id,
                  name: spec.name,
                  error: `Permission-layer updatedInput blocked by sandbox guard: ${sandboxResult.reason} [${sandboxResult.violation}]`,
                  isError: true,
                },
              }
            }
          }
          return { allowed: true, args: edited }
        }
      }

      // 2. Permission Engine check (rule matching sees backfilled paths)
      let requiresApproval = requiresApprovalFromTool
      if (params.permissionEngine) {
        const evalRes = params.permissionEngine.evaluate(spec.name, observableArgs, params.permissionMode)
        if (!evalRes.allowed) {
          emitStart(evalRes.requiresApproval)
          return {
            allowed: false,
            result: {
              toolCallId: spec.id,
              name: spec.name,
              error: evalRes.reason || `Tool execution denied by policy`,
              isError: true,
            },
          }
        }
        requiresApproval = evalRes.requiresApproval
      } else {
        const rawRequiresApproval = tool?.requiresApproval ? tool.requiresApproval(observableArgs) : false
        requiresApproval = params.permissionMode === 'bypass' ? false : rawRequiresApproval
      }
      // Tool-level ask wins over mode/engine defaults. In bypass mode the
      // engine's handleApprovalRequired still auto-approves instantly, so this
      // can never hang — it only ensures tool-ask is never silently skipped.
      if (requiresApprovalFromTool) {
        requiresApproval = true
      }

      emitStart(requiresApproval)

      // 3. Human-in-the-Loop check
      // Fail-closed (1:1 Claude Code shouldAvoidPermissionPrompts): an ask that
      // cannot reach a user (background agents, subagents, misconfigured host)
      // must deny — never silently execute.
      if (requiresApproval && !params.onApprovalRequired) {
        return {
          allowed: false,
          result: {
            toolCallId: spec.id,
            name: spec.name,
            error: `Tool "${spec.name}" requires approval but no approval handler is available in this context. Execution denied (fail-closed).`,
            isError: true,
          },
        }
      }
      if (requiresApproval && params.onApprovalRequired) {
        pushEvent({
          type: 'status_change',
          status: 'awaiting_confirmation',
          message: `Awaiting user confirmation for ${spec.name}...`,
        })

        const approvalReq: ApprovalRequest = {
          id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          toolCallId: spec.id,
          toolName: spec.name,
          arguments: observableArgs,
          promptMessage: `Tool "${spec.name}" requires your authorization.`,
          timestamp: Date.now(),
        }

        pushEvent({ type: 'approval_required', request: approvalReq })
        const verdict = await params.onApprovalRequired(approvalReq)
        const approved = typeof verdict === 'boolean' ? verdict : verdict.approved
        const updatedInput =
          typeof verdict === 'object' && verdict.updatedInput ? verdict.updatedInput : undefined

        if (!approved) {
          return {
            allowed: false,
            result: {
              toolCallId: spec.id,
              name: spec.name,
              error: 'Execution cancelled by user.',
              isError: true,
            },
          }
        }

        if (updatedInput) {
          // Defense in depth (1:1 Claude Code: approval-supplied input is still
          // policy-checked): re-run the sandbox gate on the user-edited args.
          if (params.sandboxGuard) {
            let sandboxResult = { passed: true } as any
            if (isCommandToolName(spec.name)) {
              sandboxResult = params.sandboxGuard.validateCommand(
                (updatedInput.CommandLine || updatedInput.command || '') as string
              )
            } else {
              const fileTarget = (
                updatedInput.filePath ||
                updatedInput.dirPath ||
                updatedInput.TargetFile ||
                updatedInput.AbsolutePath ||
                updatedInput.path
              ) as string
              if (fileTarget) {
                sandboxResult = params.sandboxGuard.validateFileTarget(fileTarget)
              }
            }
            if (!sandboxResult.passed) {
              return {
                allowed: false,
                result: {
                  toolCallId: spec.id,
                  name: spec.name,
                  error: `User-edited input blocked by sandbox guard: ${sandboxResult.reason} [${sandboxResult.violation}]`,
                  isError: true,
                },
              }
            }
          }
          userModifiedIds.add(spec.id)
          return { allowed: true, args: updatedInput, userModified: true }
        }
      }

      return { allowed: true }
    }

    const executor = new StreamingToolExecutor(
      params.toolRegistry,
      {
        workspaceRoot: params.workspaceRoot,
        sessionId: params.sessionId,
        fileHistoryTracker: params.fileHistoryTracker,
        signal,
        emitTerminalOutput: params.onTerminalOutput,
        // Gate context threading (subagent approvals 1:1 Claude Code canUseTool
        // propagation): the Agent tool reads these from ctx to forward the
        // parent's permission engine / sandbox / approval callback into the
        // subagent's own query loop.
        onApprovalRequired: params.onApprovalRequired,
        permissionEngine: params.permissionEngine,
        sandboxGuard: params.sandboxGuard,
        permissionMode: params.permissionMode,
        getPermissionMode: params.getPermissionMode,
        setPermissionMode: params.setPermissionMode,
      },
      (id, chunk) => params.onToolProgress?.(id, chunk),
      {
        gate: (spec, args) => runGate(spec, args),
        onEvent: pushEvent,
        onSettled: wake,
      }
    )

    let streamResult: Awaited<ReturnType<ILLMProvider['chatStream']>> | undefined
    let streamError: unknown
    let streamDone = false
    let postStreamFed = false

    const streamPromise = params.provider
      .chatStream(
        messages,
        activeTools as any,
        (chunk) => {
          if (chunk.thinking) {
            forwardedThinkingChars += chunk.thinking.length
            pushEvent({ type: 'thinking_delta', delta: chunk.thinking })
          }
          if (chunk.content) {
            forwardedContentChars += chunk.content.length
            streamedContent += chunk.content
            pushEvent({ type: 'message_delta', delta: chunk.content })
          }
          if (chunk.completedToolCalls) {
            for (const block of chunk.completedToolCalls) {
              if (addedToolCallIds.has(block.id)) continue
              markAdded(block.id, block.name)
              if (!emittedToolExecuting) {
                emittedToolExecuting = true
                pushEvent({
                  type: 'status_change',
                  status: 'tool_executing',
                  message: 'Executing tool call(s)...',
                })
              }
              executor.addTool({ id: block.id, name: block.name, arguments: block.arguments })
            }
          }
        },
        signal
      )
      .then(
        (r) => { streamResult = r },
        (e) => { streamError = e }
      )
      .finally(() => {
        streamDone = true
        wake()
      })

    const emitToolExecutingStatus = (count: number) => {
      if (emittedToolExecuting) return
      emittedToolExecuting = true
      pushEvent({
        type: 'status_change',
        status: 'tool_executing',
        message: `Executing ${count} tool call(s)...`,
      })
    }

    try {
      while (true) {
        // Drain pending events (order preserved) then completed results (arrival order)
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!
        }
        for (const res of executor.getCompleted()) {
          params.docConflict?.releaseCall(res.toolCallId)
          recordResult(res)
          yield { type: 'tool_call_complete', result: res }
        }

        const workRemaining =
          !streamDone || executor.hasUnfinishedTools() || eventQueue.length > 0

        if (!workRemaining && !postStreamFed && !streamError && streamResult) {
          // Stream finished: flush any tail text a provider failed to chunk,
          // then feed tool calls that never signaled block-level completion.
          postStreamFed = true
          if (streamResult.fullThinking.length > forwardedThinkingChars) {
            yield { type: 'thinking_delta', delta: streamResult.fullThinking.slice(forwardedThinkingChars) }
          }
          if (streamResult.fullContent.length > forwardedContentChars) {
            yield { type: 'message_delta', delta: streamResult.fullContent.slice(forwardedContentChars) }
          }
          if (streamResult.toolCalls.length > 0) {
            emitToolExecutingStatus(streamResult.toolCalls.length)
          }
          for (const tc of streamResult.toolCalls) {
            if (addedToolCallIds.has(tc.id)) continue
            markAdded(tc.id, tc.name)
            executor.addTool({ id: tc.id, name: tc.name, arguments: tc.arguments })
          }
          continue
        }

        if (!workRemaining) break
        if (signal?.aborted) break

        // Race only while the stream is pending. Racing an already-resolved
        // streamPromise would spin the loop on microtasks alone, starving
        // macrotask timers (e.g. the user-abort setTimeout) — a real hang.
        if (streamDone) {
          await waitForWake()
        } else {
          await Promise.race([streamPromise, waitForWake()])
        }
      }
    } catch (err: any) {
      executionError = err?.message || String(err)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }

    // User abort: discard in-flight tools, keep completed pairs, compensate the rest
    if (signal?.aborted) {
      executor.discard()
      for (const res of executor.getCompleted()) {
        params.docConflict?.releaseCall(res.toolCallId)
        recordResult(res)
        yield { type: 'tool_call_complete', result: res }
      }
      const { syntheticMessages, syntheticEvents } = compensateMissingToolResults(
        Array.from(addedSpecs.values()),
        completedToolCallIds,
        'Execution cancelled by user.'
      )
      for (const evt of syntheticEvents) {
        yield evt
      }
      toolResultMessages.push(...syntheticMessages)

      yield { type: 'status_change', status: 'idle', message: 'Execution cancelled by user.' }
      const abortedAssistant: LLMMessage = streamResult
        ? {
            role: 'assistant',
            content: streamResult.fullContent ?? '',
            tool_calls:
              streamResult.toolCalls.length > 0
                ? streamResult.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                  }))
                : undefined,
          }
        : // Stream never resolved: keep the partial text already streamed to the
          // UI so replayed history matches what the user saw.
          { role: 'assistant', content: streamedContent }
      return {
        reason: 'aborted',
        messages: sanitizeConversationHistory([...messages, abortedAssistant, ...toolResultMessages]),
      }
    }

    if (streamError) {
      executor.discard()
      const err = streamError as any
      yield { type: 'error', message: err?.message || String(err) }
      return { reason: 'error', messages, error: err?.message || String(err) }
    }

    if (executionError) {
      executor.discard()
      const toolCallsForCompensation = streamResult?.toolCalls ?? Array.from(addedSpecs.values())
      const { syntheticMessages, syntheticEvents } = compensateMissingToolResults(
        toolCallsForCompensation,
        completedToolCallIds,
        executionError
      )
      for (const evt of syntheticEvents) {
        yield evt
      }
      toolResultMessages.push(...syntheticMessages)

      yield { type: 'error', message: executionError }
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: streamResult?.fullContent ?? '',
        tool_calls: toolCallsForCompensation.length > 0
          ? toolCallsForCompensation.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify((tc as any).arguments ?? {}) },
            }))
          : undefined,
      }
      return {
        reason: 'error',
        messages: sanitizeConversationHistory([...messages, assistantMsg, ...toolResultMessages]),
        error: executionError,
      }
    }

    const assistantMsg: LLMMessage = {
      role: 'assistant',
      content: streamResult!.fullContent ?? '',
      tool_calls:
        streamResult!.toolCalls.length > 0
          ? streamResult!.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            }))
          : undefined,
    }

    // If no tools requested, completion exit
    if (streamResult!.toolCalls.length === 0) {
      yield { type: 'status_change', status: 'completed', message: 'Task finished successfully.' }
      return {
        reason: 'completed',
        messages: sanitizeConversationHistory([...messages, assistantMsg]),
      }
    }

    // Atomic State transition for next iteration
    state = {
      messages: sanitizeConversationHistory([...messages, assistantMsg, ...toolResultMessages]),
      turnCount: turnCount + 1,
      transition: 'next_turn',
    }
  }
}
