import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export interface EntrypointTruncation {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

const IS_WINDOWS = process.platform === 'win32'

/**
 * Normalizes a workspace path into a canonical form for stable hashing:
 * - Forward slashes
 * - Lowercased on Windows (case-insensitive filesystem)
 * - Trailing slashes removed
 */
export function normalizeCanonicalPath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/').trim()
  if (normalized.endsWith('/') && normalized.length > 1 && !normalized.match(/^[a-zA-Z]:\/$/)) {
    normalized = normalized.slice(0, -1)
  }
  if (IS_WINDOWS) {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

/**
 * Computes a stable project hash for directory routing.
 */
export function getProjectHash(projectPath: string): string {
  const canonical = normalizeCanonicalPath(projectPath)
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Resolves the persistent memory directory for a workspace.
 */
export function getAutoMemPath(
  workspaceRoot: string,
  options?: { customDir?: string }
): string {
  if (options?.customDir) {
    return options.customDir
  }
  if (process.env.NEXUS_MEMORY_DIR) {
    return process.env.NEXUS_MEMORY_DIR
  }

  const hash = getProjectHash(workspaceRoot)
  return path.join(os.homedir(), '.nexus', 'projects', hash, 'memory')
}

/**
 * Validates a memory target path to prevent directory traversal or unsafe system roots.
 * If an allowedBaseDir is provided, ensures the resolved target path is strictly contained within it.
 */
export function validateMemoryPath(targetPath: string, allowedBaseDir?: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false
  if (targetPath.includes('\0')) return false

  // Disallow UNC network shares
  if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) return false

  // Disallow relative traversal
  if (targetPath.includes('../') || targetPath.includes('..\\')) return false

  const normalized = targetPath.replace(/\\/g, '/').trim()

  // Disallow filesystem roots
  if (normalized === '/' || normalized === '/a' || normalized.match(/^[a-zA-Z]:\/?$/)) {
    return false
  }

  if (allowedBaseDir) {
    const resolvedBase = path.resolve(allowedBaseDir)
    const resolvedTarget = path.resolve(targetPath)
    const rel = path.relative(resolvedBase, resolvedTarget)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false
    }
  }

  return true
}

/**
 * Truncates MEMORY.md content to line AND byte caps (1:1 with Claude Code),
 * appending a warning if truncated.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed ? trimmed.split('\n') : []
  const lineCount = contentLines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf-8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated: false,
      wasByteTruncated: false
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (Buffer.byteLength(truncated, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    // Cut at the last newline before byte limit
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`

  const warning = `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`

  return {
    content: truncated + warning,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated
  }
}
