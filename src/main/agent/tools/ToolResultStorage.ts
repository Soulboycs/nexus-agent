import fs from 'fs/promises'
import path from 'path'

// Default character threshold for tool result persistence (50,000 characters)
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

// Preview size in bytes/characters for the reference message
export const PREVIEW_SIZE_BYTES = 2_000

// XML tags used to wrap persisted output messages (1:1 with Claude Code)
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'
export const TOOL_RESULTS_SUBDIR = 'tool-results'

export interface PersistedToolResult {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

export interface ProcessToolResultOptions {
  workspaceRoot: string
  sessionId?: string
  maxResultSizeChars?: number
}

export function formatFileSize(charsOrBytes: number): string {
  if (charsOrBytes < 1024) {
    return `${charsOrBytes} B`
  } else if (charsOrBytes < 1024 * 1024) {
    return `${(charsOrBytes / 1024).toFixed(1)} KB`
  }
  return `${(charsOrBytes / (1024 * 1024)).toFixed(1)} MB`
}

export function getToolResultsDir(workspaceRoot: string, sessionId?: string): string {
  if (sessionId) {
    return path.join(workspaceRoot, '.nexus', 'sessions', sessionId, TOOL_RESULTS_SUBDIR)
  }
  return path.join(workspaceRoot, '.nexus', 'temp', TOOL_RESULTS_SUBDIR)
}

export async function ensureToolResultsDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err: any) {
    if (err.code !== 'EEXIST') {
      throw err
    }
  }
}

export function generatePreview(content: string, maxBytes: number = PREVIEW_SIZE_BYTES): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }
  return {
    preview: content.slice(0, maxBytes),
    hasMore: true
  }
}

export function buildLargeToolResultMessage(result: PersistedToolResult): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
  message += result.preview
  message += result.hasMore ? '\n...\n' : '\n'
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}

export async function persistToolResult(
  content: string,
  toolCallId: string,
  options: ProcessToolResultOptions
): Promise<PersistedToolResult> {
  const dir = getToolResultsDir(options.workspaceRoot, options.sessionId)
  await ensureToolResultsDir(dir)

  let isJson = false
  const trimmed = content.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      isJson = true
    } catch {}
  }

  const safeId = (toolCallId || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, '_')
  const filename = `${safeId}.${isJson ? 'json' : 'txt'}`
  const filepath = path.join(dir, filename)

  // Write content to disk
  await fs.writeFile(filepath, content, 'utf-8')

  const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES)
  return {
    filepath,
    originalSize: content.length,
    isJson,
    preview,
    hasMore
  }
}

/**
/**
 * 1:1 with Claude Code isToolResultContentEmpty:
 * True when a tool_result's content is empty or whitespace-only.
 */
export function isToolResultContentEmpty(content: string | undefined | null): boolean {
  if (!content) return true
  return content.trim() === ''
}

/**
 * 1:1 with Claude Code processToolResultBlock:
 * Checks tool output against maxResultSizeChars.
 * If output exceeds threshold, writes output to disk and returns a concise preview
 * with file path, preventing context window explosion.
 * Also handles inc-4586 (empty tool results stop-token prevention).
 *
 * NOTE: Tools with maxResultSizeChars === Infinity (e.g. view_file) are never persisted,
 * preventing recursive Read -> Persist -> Read infinite loops.
 */
export async function processToolResult(
  tool: { name: string; maxResultSizeChars?: number },
  output: string,
  toolCallId: string,
  options: ProcessToolResultOptions
): Promise<{ output: string; persisted?: PersistedToolResult }> {
  // inc-4586 (Claude Code parity): Empty tool_result content causes models
  // to emit stop sequence and end turn with zero output.
  // Inject a short marker so the model always has something to react to.
  if (isToolResultContentEmpty(output)) {
    return {
      output: `(${tool.name} completed with no output)`
    }
  }

  // Hard opt-out for tools like view_file / read_file
  if (tool.maxResultSizeChars === Infinity || !Number.isFinite(tool.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS)) {
    return { output }
  }

  const threshold = tool.maxResultSizeChars ?? options.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS

  if (output.length <= threshold) {
    return { output }
  }

  try {
    const persisted = await persistToolResult(output, toolCallId, options)
    const formatted = buildLargeToolResultMessage(persisted)
    return {
      output: formatted,
      persisted
    }
  } catch (err: any) {
    // If persistence fails (e.g. disk permission), fallback to in-memory truncation with warning
    const truncated = output.slice(0, threshold) + `\n... [Output truncated at ${threshold} characters due to disk write error: ${err.message}]`
    return { output: truncated }
  }
}
