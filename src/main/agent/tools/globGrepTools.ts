import { z } from 'zod'
import { AgentTool } from './ToolRegistry'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

function resolvePath(filePath: string, workspaceRoot: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath)
  }
  return path.normalize(path.join(workspaceRoot, filePath))
}

/**
 * Robust cross-platform recursive directory walker compatible with all Node/Electron versions.
 */
async function* walkDirectory(
  dir: string,
  maxDepth = 8,
  currentDepth = 0
): AsyncGenerator<string> {
  if (currentDepth > maxDepth) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'out' ||
      entry.name === '.next'
    ) {
      continue
    }

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDirectory(fullPath, maxDepth, currentDepth + 1)
    } else if (entry.isFile()) {
      yield fullPath
    }
  }
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export const globTool: AgentTool = {
  name: 'Glob', // 1:1 cc 命名（R5）；旧名合并为别名
  aliases: ['GlobTool', 'glob', 'find_files', 'find_by_name'],
  description:
    'Search for files by name pattern or wildcard (e.g. "*.ts", "src/**/*.tsx"). Returns matching file paths sorted by modification time (newest first).',
  searchHint: 'fast file search by pattern wildcard glob',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.pattern ? `Searching files "${args.pattern}"` : 'Searching files',
  getToolUseSummary: (args) => args?.pattern ? `Glob: ${args.pattern}` : null,
  parameters: z.object({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe('The directory to search in. Defaults to workspace root. DO NOT enter "undefined" or "null"'),
  }),
  execute: async ({ pattern, path: searchPath }, context) => {
    const rootPath = searchPath ? resolvePath(searchPath, context.workspaceRoot) : context.workspaceRoot
    try {
      if (!fsSync.existsSync(rootPath)) {
        throw new Error(`Search path does not exist: ${rootPath}`)
      }
      const regex = patternToRegex(pattern)
      const matches: Array<{ relPath: string; mtimeMs: number }> = []

      for await (const fullPath of walkDirectory(rootPath)) {
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
        if (regex.test(relPath) || regex.test(path.basename(fullPath))) {
          let mtimeMs = 0
          try {
            mtimeMs = (await fs.stat(fullPath)).mtimeMs
          } catch {
            // stat 失败按最旧处理
          }
          matches.push({ relPath, mtimeMs })
        }
      }

      // 1:1 cc --sort=modified：按修改时间降序（最新优先）
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs)

      if (matches.length === 0) return 'No files found'

      const results = matches.slice(0, 100).map((m) => m.relPath)
      if (matches.length > 100) {
        results.push('(Results are truncated. Consider using a more specific path or pattern.)')
      }
      return results.join('\n')
    } catch (err: any) {
      if (String(err.message).includes('does not exist')) throw err
      throw new Error(`GlobTool failed: ${err.message}`)
    }
  }
}

export const grepTool: AgentTool = {
  name: 'Grep', // 1:1 cc 命名（R5）；旧名合并为别名
  aliases: ['GrepTool', 'grep', 'search_text', 'grep_search'],
  description:
    'Search file contents with regex. Defaults to listing files with matches (files_with_matches); use output_mode "content" for matching lines with optional context lines, or "count" for match counts per file.',
  searchHint: 'fast regex search across file contents',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.pattern ? `Grep "${args.pattern}"` : 'Searching contents',
  getToolUseSummary: (args) => args?.pattern ? `Grep: ${args.pattern}` : null,
  parameters: z.object({
    pattern: z.string().describe('The regular expression pattern to search for'),
    path: z.string().optional().describe('Directory to search in. Defaults to workspace root.'),
    glob: z
      .string()
      .optional()
      .describe('Glob pattern to filter files (e.g. "*.ts"); legacy alias globPattern accepted'),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe('Output mode: files_with_matches (default) | content (matching lines) | count (matches per file)'),
    '-i': z.boolean().optional().describe('Case-insensitive search'),
    '-n': z.boolean().optional().describe('Show line numbers in content mode (default true)'),
    '-B': z.number().int().nonnegative().optional().describe('Lines of context before each match'),
    '-A': z.number().int().nonnegative().optional().describe('Lines of context after each match'),
    '-C': z.number().int().nonnegative().optional().describe('Lines of context before and after each match'),
    head_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max entries to return (0 = unlimited; default 250)'),
    offset: z.number().int().nonnegative().optional().describe('Skip the first N entries before returning results'),
  }),
  execute: async (rawArgs, context) => {
    // 兼容旧参数名 globPattern
    const args: any = { ...rawArgs }
    if (args.globPattern !== undefined && args.glob === undefined) args.glob = args.globPattern
    const {
      pattern,
      path: searchPath,
      glob,
      output_mode = 'files_with_matches',
      '-i': flagI,
      '-n': flagN = true,
      '-B': before,
      '-A': after,
      '-C': ctxBoth,
      head_limit = 250,
      offset = 0,
    } = args
    const rootPath = searchPath ? resolvePath(searchPath, context.workspaceRoot) : context.workspaceRoot
    const contextBefore = ctxBoth ?? before ?? 0
    const contextAfter = ctxBoth ?? after ?? 0
    const regex = new RegExp(pattern, flagI ? 'gi' : 'g')
    const filterRegex = glob ? patternToRegex(glob) : null

    try {
      const outFiles: Array<{ relPath: string; mtimeMs: number }> = []
      const contentChunks: string[] = []
      const countEntries: string[] = []
      let totalMatches = 0
      let truncated = false

      for await (const fullPath of walkDirectory(rootPath)) {
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
        if (filterRegex && !filterRegex.test(relPath) && !filterRegex.test(path.basename(fullPath))) {
          continue
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          if (content.indexOf('\0') !== -1) continue // Skip binary files

          const lines = content.split(/\r?\n/)
          const fileMatches: Array<{ lineNo: number; text: string }> = []

          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i])) {
              totalMatches++
              fileMatches.push({ lineNo: i + 1, text: lines[i] })
            }
          }

          if (fileMatches.length === 0) continue

          if (output_mode === 'files_with_matches') {
            let mtimeMs = 0
            try {
              mtimeMs = (await fs.stat(fullPath)).mtimeMs
            } catch {
              // 按 cc：files 模式 mtime 降序（文件名 tiebreak）
            }
            outFiles.push({ relPath, mtimeMs })
          } else if (output_mode === 'count') {
            countEntries.push(`${relPath}:${fileMatches.length}`)
          } else {
            // content 模式（1:1 cc）：保留原始缩进；行超 500 列截断；支持上下文行
            const emitted = new Set<number>()
            for (const fm of fileMatches) {
              if (emitted.has(fm.lineNo)) continue
              const start = Math.max(1, fm.lineNo - contextBefore)
              const end = Math.min(lines.length, fm.lineNo + contextAfter)
              if (contextBefore + contextAfter > 0 && (start < fm.lineNo || end > fm.lineNo)) {
                contentChunks.push(`${relPath}-${fm.lineNo}-`)
              }
              for (let ln = start; ln <= end; ln++) {
                if (emitted.has(ln)) continue
                emitted.add(ln)
                let text = lines[ln - 1]
                if (text.length > 500) text = text.slice(0, 500) + ' [truncated]'
                if (flagN) {
                  contentChunks.push(`${relPath}:${ln}:${text}`)
                } else {
                  contentChunks.push(text)
                }
              }
            }
          }
        } catch {
          // ignore unreadable files
        }
      }

      // 组装输出（head_limit/offset 分页语义 1:1 cc）
      if (output_mode === 'files_with_matches') {
        outFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath))
        let entries = outFiles.map((f) => f.relPath)
        if (offset > 0) entries = entries.slice(offset)
        let sliced = entries.slice(0, head_limit > 0 ? head_limit : entries.length)
        if (entries.length > sliced.length) {
          sliced = [...sliced, '(Results are truncated. Consider using a more specific path or pattern.)']
        }
        if (sliced.length === 0) return 'No files found'
        return sliced.join('\n')
      }

      if (output_mode === 'count') {
        let entries = offset > 0 ? countEntries.slice(offset) : countEntries
        if (head_limit > 0) entries = entries.slice(0, head_limit)
        if (countEntries.length === 0) return 'No matches found'
        const total = countEntries.reduce((sum, e) => sum + Number(e.split(':').pop() ?? 0), 0)
        return `${entries.join('\n')}\n\nFound ${total} total occurrences across ${countEntries.length} files.`
      }

      // content
      let chunks = offset > 0 ? contentChunks.slice(offset) : contentChunks
      if (head_limit > 0 && chunks.length > head_limit) {
        chunks = chunks.slice(0, head_limit)
        truncated = true
      }
      if (contentChunks.length === 0) return 'No matches found'
      const prefix = `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'}:\n`
      return prefix + chunks.join('\n') + (truncated ? '\n... (truncated)' : '')
    } catch (err: any) {
      throw new Error(`GrepTool failed: ${err.message}`)
    }
  }
}
