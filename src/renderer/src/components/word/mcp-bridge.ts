import type { Editor } from '@tiptap/react'
import { normalizeKeyPath } from '@shared/paths'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { McpCommandMessage, McpEditorCommand } from '../shared/ipc'
import { executeTool, markDocSeen } from './ai/tools'
import type { AiCommentsAccess, AiDocExtras, AiHeaderFooterAccess } from './ai/tools'
import type { AiNotesAccess } from './ai/note-ops'
import type { AiPageSetupAccess } from './ai/page-setup'
import { findNumId, type NumIds } from './ai/protocol'
import { save, type FileActionContext } from './file-actions'

/**
 * MCP bridge (renderer half).
 *
 * The shell main process pushes editor commands over `docs:mcp-command`; this
 * module runs them against the *live* Tiptap editor so an external agent drives
 * the same visible editor the built-in agent does, then reports the outcome
 * back on `docs:mcp-result`. Command execution is serialized so a burst cannot
 * interleave two edits into one document.
 *
 * The executors are the built-in agent's own (`executeTool`), so external edits
 * inherit the same parsing, atomicity, formatting rules and stale-index guard.
 */

export interface McpBridgeDeps {
  /** live file-action context (refreshed every render by App) */
  getCtx: () => FileActionContext
  /** document-level stores the R8 tool surface needs; wired by App, read lazily per command */
  getComments?: () => AiCommentsAccess | undefined
  getNotes?: () => AiNotesAccess | undefined
  getHf?: () => AiHeaderFooterAccess | undefined
  getPageSetup?: () => AiPageSetupAccess | undefined
  getExtras?: () => AiDocExtras | undefined
}

function numIdsFor(ctx: FileActionContext): NumIds {
  const blocks = ctx.doc?.parsed.blocks ?? []
  const isBlank = ctx.doc?.isBlank === true
  return {
    bullet: findNumId(blocks, 'bullet') ?? (isBlank ? BLANK_BULLET_NUM_ID : null),
    ordered: findNumId(blocks, 'ordered') ?? (isBlank ? BLANK_ORDERED_NUM_ID : null),
  }
}

/** the payload shapes this bridge accepts per command (validated by the executors) */
interface InsertContentInput {
  html: string
  afterBlockIndex?: number
  trackChanges?: boolean
  author?: string
}
interface ReplaceBlocksInput {
  startBlockIndex: number
  endBlockIndex: number
  html: string
  trackChanges?: boolean
  author?: string
}
interface ApplyOpsInput {
  ops: unknown[]
  dryRun?: boolean
  trackChanges?: boolean
  author?: string
}

/** mirror of AiPanel's clearAiHighlights: auto-accept the external edit, keeping undo history */
function clearAiChangedFlags(editor: Editor): void {
  const view = editor.view
  let tr = view.state.tr
  let touched = false
  view.state.doc.forEach((node, offset) => {
    if (node.attrs.aiChanged) {
      tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
      touched = true
    }
  })
  if (!touched) return
  tr = tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  markDocSeen(editor)
}

let clearHighlightTimer: ReturnType<typeof setTimeout> | null = null

function scheduleClearAiHighlights(editor: Editor, delayMs = 10_000): void {
  if (clearHighlightTimer) clearTimeout(clearHighlightTimer)
  clearHighlightTimer = setTimeout(() => {
    try {
      if (!editor.isDestroyed) {
        clearAiChangedFlags(editor)
      }
    } catch {}
  }, delayMs)
}

/**
 * The executors are shared with the in-app agent, whose tool set includes
 * `get_document_context`. That name does not exist on the MCP surface, where the
 * same readout is `read_document` — so hinting at it would send an external
 * agent chasing a tool it cannot call. Rename the reference on the way out.
 */
function mcpErrorText(output: string): string {
  return output.replaceAll('get_document_context', 'read_document')
}

/** bridge-only payload fields the shared executors do not know */
const TRACK_KEYS = new Set(['trackChanges', 'author'])

function toolInputOf(payload: unknown): Record<string, unknown> {
  const raw = (payload ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!TRACK_KEYS.has(k)) out[k] = v
  return out
}

/**
 * Generic passthrough for the R8 tool surface: run one built-in agent tool by
 * its AGENT_TOOLS name against the live editor, wired with the same document
 * stores the in-app panel hands over (comments, header/footer, page setup,
 * styles/watermark, notes). Payload may carry the bridge-level
 * trackChanges/author pair, stripped before the call.
 */
async function runAgentTool(
  deps: McpBridgeDeps,
  name: string,
  payload: unknown,
): Promise<{ summary: string; output: string; mutated: boolean }> {
  const ctx = deps.getCtx()
  const editor = ctx.editor
  if (!editor || !ctx.doc) throw new Error('the document is not ready')
  const raw = (payload ?? {}) as Record<string, unknown>
  const track =
    raw.trackChanges === true
      ? { author: typeof raw.author === 'string' && raw.author ? raw.author : 'Nexus Agent' }
      : undefined
  const outcome = await executeTool(
    editor,
    { id: 'mcp', name, input: toolInputOf(payload) },
    numIdsFor(ctx),
    track,
    undefined,
    null,
    deps.getComments?.(),
    deps.getHf?.(),
    undefined,
    deps.getPageSetup?.(),
    deps.getExtras?.(),
    deps.getNotes?.(),
  )
  if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
  return { summary: outcome.summary, output: outcome.output, mutated: outcome.mutated }
}

async function runCommand(
  deps: McpBridgeDeps,
  command: McpEditorCommand,
  payload: unknown,
): Promise<unknown> {
  const ctx = deps.getCtx()
  const editor = ctx.editor
  if (!editor || !ctx.doc) throw new Error('the document is not ready')

  switch (command) {
    case 'insert_content': {
      const input = (payload ?? {}) as InsertContentInput
      if (typeof input.html !== 'string') throw new Error('insert_content requires "html"')
      if (input.afterBlockIndex !== undefined) {
        const last = editor.state.doc.childCount - 1
        if (!Number.isInteger(input.afterBlockIndex) || input.afterBlockIndex < -1) {
          throw new Error(`afterBlockIndex must be an integer >= -1 (got ${input.afterBlockIndex})`)
        }
        if (input.afterBlockIndex > last) {
          throw new Error(
            `afterBlockIndex ${input.afterBlockIndex} is out of range (valid: -1..${last}); ` +
              'call read_document for fresh block indexes',
          )
        }
      }
      const track = input.trackChanges ? { author: input.author || 'Nexus Agent' } : undefined
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'insert_content', input: { ...input } },
        numIdsFor(ctx),
        track,
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      if (!input.trackChanges) {
        scheduleClearAiHighlights(editor)
      }
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'replace_blocks': {
      const input = (payload ?? {}) as ReplaceBlocksInput
      if (typeof input.html !== 'string') throw new Error('replace_blocks requires "html"')
      const track = input.trackChanges ? { author: input.author || 'Nexus Agent' } : undefined
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'replace_blocks', input: { ...input } },
        numIdsFor(ctx),
        track,
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      if (!input.trackChanges) {
        scheduleClearAiHighlights(editor)
      }
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'apply_ops': {
      const input = (payload ?? {}) as ApplyOpsInput
      const outcome = await executeTool(
        editor,
        {
          id: 'mcp',
          name: 'apply_ops',
          input: { ops: input.ops, ...(input.dryRun === true ? { dryRun: true } : {}) },
        },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      if (input.dryRun !== true) {
        scheduleClearAiHighlights(editor)
      }
      return { summary: outcome.summary, output: outcome.output, mutated: outcome.mutated }
    }

    case 'read_document': {
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'get_document_context', input: {} },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      return { text: outcome.output }
    }

    case 'save_document': {
      const input = (payload ?? {}) as { path?: string; overwrite?: boolean }
      if (typeof input.path !== 'string' || !input.path) {
        throw new Error('save_document requires an absolute "path"')
      }
      let reason = ''
      const ok = await save(ctx, false, true, undefined, {
        path: input.path,
        overwrite: input.overwrite === true,
        onError: (message) => (reason = message),
      })
      if (!ok) throw new Error(reason || 'the document could not be saved')
      return { ok: true, path: input.path }
    }

    // R8: every remaining sync tool of the built-in catalog runs through the
    // same executeTool passthrough — validation, staleness guard and error
    // texts are the executors' own (1:1 with the in-app agent).
    case 'read_revisions':
    case 'accept_changes':
    case 'reject_changes':
    case 'read_blocks':
    case 'replace_selection':
    case 'read_comments':
    case 'reply_comment':
    case 'resolve_comment':
    case 'add_comment':
    case 'delete_comment':
    case 'insert_footnote':
    case 'insert_endnote':
    case 'delete_note':
    case 'read_notes':
    case 'insert_chart':
    case 'edit_chart':
    case 'set_header_footer':
    case 'set_page_setup':
    case 'insert_section_break':
    case 'define_style':
    case 'list_styles':
    case 'set_watermark':
    case 'insert_text_box':
    case 'insert_picture': {
      const input = (payload ?? {}) as Record<string, unknown>
      const result = await runAgentTool(deps, command, payload)
      if (result.mutated && input.trackChanges !== true) {
        scheduleClearAiHighlights(editor)
      }
      return result
    }

    default: {
      const unreachable: never = command
      throw new Error(`unknown MCP command: ${String(unreachable)}`)
    }
  }
}

/**
 * A fresh tab boots asynchronously (`newFile()` calls setContent, then setDoc),
 * so a command that lands before `doc` exists would be wiped by that blank
 * reset. Wait for the loaded document before announcing readiness.
 *
 * The wait never stops retrying, only slows down: a tab that gave up while its
 * renderer was still booting would look fine in the UI yet stay unaddressable
 * over MCP for the rest of its life, because readiness is announced exactly
 * once and never re-derived.
 */
const READY_POLL_MS = 50
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

async function announceWhenLoaded(
  deps: McpBridgeDeps,
  signal: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (isCancelled()) return
    const ctx = deps.getCtx()
    if (ctx?.editor && ctx.doc) {
      signal()
      return
    }
    const slow = Date.now() - startedAt > READY_FAST_WINDOW_MS
    await new Promise((resolve) => setTimeout(resolve, slow ? READY_SLOW_POLL_MS : READY_POLL_MS))
  }
}

/** Subscribe the live editor to MCP commands. Returns the unsubscribe function. */
export function installMcpBridge(deps: McpBridgeDeps): () => void {
  const desktop = window.desktop
  if (!desktop?.onMcpCommand || !desktop.reportMcpResult) return () => {}
  let cancelled = false
  let queue: Promise<void> = Promise.resolve()
  const currentOwnPath = () => normalizeKeyPath(deps.getCtx()?.doc?.filePath ?? '')
  const unsubscribe = desktop.onMcpCommand((message: McpCommandMessage & { targetPath?: string }) => {
    if (!message || typeof message.requestId !== 'string') return
    // R11 实例端过滤:命令带 targetPath 且与自身文档不一致 → 立即回错误,不执行
    // (消灭多实例广播双写;main 收到失败后走离线分支)
    if (typeof message.targetPath === 'string') {
      const own = currentOwnPath()
      if (own !== message.targetPath) {
        desktop.reportMcpResult?.({
          requestId: message.requestId,
          ok: false,
          error: '__path_mismatch__',
        })
        return
      }
    }
    queue = queue.then(async () => {
      try {
        const result = await runCommand(deps, message.command, message.payload)
        desktop.reportMcpResult?.({ requestId: message.requestId, ok: true, result })
      } catch (error) {
        desktop.reportMcpResult?.({
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })
  // Let the shell know this tab can accept commands (device for targeted routing).
  // 携带当前文档路径(R11):main 建 path→实例 注册表,按路径寻址命令。
  // 就绪后持续守望:实例内切换文档时重报新路径(注册表自愈),路径变化即报。
  void announceWhenLoaded(
    deps,
    () => desktop.signalMcpReady?.({ path: currentOwnPath() || null }),
    () => cancelled,
  )
  void (async () => {
    let last: string | null = null
    for (;;) {
      if (cancelled) return
      await new Promise((r) => setTimeout(r, 1500))
      if (cancelled) return
      const cur = currentOwnPath() || null
      if (cur !== last) {
        last = cur
        desktop.signalMcpReady?.({ path: cur })
      }
    }
  })()
  return () => {
    cancelled = true
    unsubscribe()
  }
}
