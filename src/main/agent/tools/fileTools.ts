import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'
import {
  recordFileRead,
  assertReadBeforeWrite,
  findSimilarFile,
} from './fileState'

function resolvePath(filePath: string, workspaceRoot: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath)
  }
  return path.normalize(path.join(workspaceRoot, filePath))
}

/** 旧参数名 → cc 参数名归一（R7 参数名对齐的兼容层） */
function normalizeLegacyFields(args: Record<string, any>): Record<string, any> {
  const out = { ...args }
  if (out.filePath !== undefined && out.file_path === undefined) out.file_path = out.filePath
  if (out.targetContent !== undefined && out.old_string === undefined) out.old_string = out.targetContent
  if (out.replacementContent !== undefined && out.new_string === undefined) out.new_string = out.replacementContent
  if (out.allowMultiple !== undefined && out.replace_all === undefined) out.replace_all = out.allowMultiple
  if (out.startLine !== undefined && out.offset === undefined) out.offset = out.startLine
  if (out.endLine !== undefined) {
    // 旧 endLine（结束行号）→ limit（数量）：仅在未显式给 limit 时映射
    if (out.limit === undefined) {
      const start = Number(out.offset) || 1
      const end = Number(out.endLine)
      if (Number.isFinite(end) && end >= start) out.limit = end - start + 1
    }
  }
  return out
}

/** 二进制扩展名拦截（1:1 cc hasBinaryExtension，图片/PDF 由专用路径处理） */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.sqlite', '.db', '.class', '.jar', '.wasm',
])

// 1. Read Tool（1:1 cc FileReadTool 语义：cat -n 行格式 / offset+limit 数量窗口 /
//    256KB+25K token 双上限 / 二进制拦截 / Did-you-mean 自诊 / read-first 记录）
export const viewFileTool: AgentTool = {
  name: 'Read', // 1:1 cc 命名（R5）；旧名 view_file/read_file/cat 保留为别名
  aliases: ['view_file', 'read_file', 'cat'],
  description:
    'Reads a file from the local filesystem. Returns content in cat -n format (line number + tab + line). Reads the full file by default, capped at 256KB / 25000 tokens; use offset (start line) and limit (number of lines) for large files.',
  searchHint: 'view file content with line numbers',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  alwaysLoad: true,
  // 1:1 with Claude Code: Infinity prevents circular Read -> Persist -> Read loops
  maxResultSizeChars: Infinity,
  getActivityDescription: (args) => args?.file_path ? `Reading ${args.file_path}` : 'Reading file',
  getToolUseSummary: (args) => args?.file_path ? `Read ${args.file_path}` : null,
  parameters: z.object({
    file_path: z.string().describe('Relative or absolute path to the file to read'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Start line number (1-indexed). Omit to read from the beginning'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of lines to read. Omit to read to the end of the file (subject to size caps)'),
  }),
  execute: async (rawArgs, context) => {
    const args = normalizeLegacyFields(rawArgs)
    const filePath = String(args.file_path)
    const offset = args.offset ? Math.max(1, Number(args.offset)) : 1
    const limit = args.limit ? Number(args.limit) : undefined
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const stats = await fs.stat(fullPath)
      if (stats.isDirectory()) {
        throw new Error(`Path "${filePath}" is a directory, not a file. Use the LS tool instead.`)
      }

      const ext = path.extname(fullPath).toLowerCase()
      if (BINARY_EXTENSIONS.has(ext)) {
        throw new Error(
          `Binary file "${filePath}" cannot be displayed as text (extension ${ext}). Use Bash with an appropriate tool to inspect it.`
        )
      }

      const raw = await fs.readFile(fullPath, 'utf-8')
      if (Buffer.byteLength(raw, 'utf-8') > 256 * 1024) {
        throw new Error(
          `File content (${Buffer.byteLength(raw, 'utf-8')} bytes) exceeds maximum allowed size (262144 bytes). Use offset and limit parameters to read specific portions of the file.`
        )
      }

      const lines = raw.split(/\r?\n/)
      const totalLines = lines.length

      if (offset > totalLines) {
        return `File: ${filePath} (${totalLines} lines)\n<system-reminder>The file is shorter than the provided offset (${offset}). It has ${totalLines} lines — read from line 1.</system-reminder>`
      }

      const end = limit ? Math.min(totalLines + 1, offset + limit - 1) : totalLines
      const selected = lines.slice(offset - 1, end)

      // cat -n 紧凑格式（1:1 cc）：行号 + TAB + 原始行（保留缩进）
      const body = selected.map((line, idx) => `${offset + idx}\t${line}`).join('\n')

      let estimatedTokens = Math.ceil(body.length / 4)
      if (estimatedTokens > 25000) {
        throw new Error(
          `File content (~${estimatedTokens} tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file.`
        )
      }

      // 空文件 reminder（1:1 cc）
      if (raw.trim() === '') {
        return `<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>`
      }

      // 记录 read-first 状态（mtime），供 Write/Edit 陈旧写检测
      recordFileRead(fullPath, (await fs.stat(fullPath)).mtimeMs)

      let result = `${body}`
      if (end < totalLines && !limit) {
        result += `\n\n[${totalLines - end} more lines in file. Use offset=${end + 1} to read more]`
      }
      return result
    } catch (err: any) {
      if (String(err?.message).includes('ENOENT')) {
        const similar = await findSimilarFile(fullPath)
        const hint = similar ? ` Did you mean ${similar}?` : ''
        throw new Error(`File does not exist.${hint} Note: your current working directory is ${context.workspaceRoot}.`)
      }
      if (String(err?.message).includes('exceeds maximum')) throw err
      throw new Error(`Failed to read file "${filePath}": ${err.message}`)
    }
  }
}

// 2. Write Tool（1:1 cc FileWriteTool：read-before-write + 陈旧检测）
export const writeToFileTool: AgentTool = {
  name: 'Write', // 1:1 cc 命名（R5）
  aliases: ['write_to_file', 'write_file', 'create_file'],
  description: 'Create a new file or completely overwrite an existing file. If the file already exists you MUST Read it first — blind overwrites are rejected.',
  searchHint: 'create new file or overwrite entire file content',
  isDestructive: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.file_path ? `Writing ${args.file_path}` : 'Writing file',
  getToolUseSummary: (args) => args?.file_path ? `Write ${args.file_path}` : null,
  parameters: z.object({
    file_path: z.string().describe('Relative or absolute path to the file to create'),
    content: z.string().describe('Code/text content to write to the file'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Legacy parameter (default true). Overwrite protection is now enforced via read-before-write'),
  }),
  // Fallback-path defense (no permissionEngine contexts): sensitive credentials
  // ask before overwrite. With an engine present the built-in sensitive-write
  // rule in PermissionEngine handles this identically.
  requiresApproval: ({ file_path, filePath }: any) => {
    const lower = String(file_path || filePath || '').toLowerCase()
    return lower.includes('.env') || lower.includes('credentials')
  },
  execute: async (rawArgs, context) => {
    const args = normalizeLegacyFields(rawArgs)
    const filePath = String(args.file_path)
    const content = String(args.content)
    const overwrite = args.overwrite === undefined ? true : Boolean(args.overwrite)
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false)

      if (exists && !overwrite) {
        throw new Error(`File "${filePath}" already exists and overwrite is set to false.`)
      }

      // R7 read-before-write（1:1 cc readFileState）：存在即必须先 Read，
      // 且 mtime 未漂移——防盲写覆盖用户/linter 的修改
      let currentMtime: number | undefined
      if (exists) {
        currentMtime = (await fs.stat(fullPath)).mtimeMs
        assertReadBeforeWrite(fullPath, exists, currentMtime)
      }

      // Track file edit before mutation for rollback/undo (1:1 with Claude Code fileHistory)
      if (context.fileHistoryTracker) {
        await context.fileHistoryTracker.trackEdit(fullPath, context.workspaceRoot)
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content, 'utf-8')
      recordFileRead(fullPath, (await fs.stat(fullPath)).mtimeMs)
      return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to "${filePath}".`
    } catch (err: any) {
      if (String(err?.message).includes('has not been read yet') || String(err?.message).includes('modified since read')) throw err
      throw new Error(`Failed to write file "${filePath}": ${err.message}`)
    }
  }
}

// 3. Edit Tool（1:1 cc FileEditTool：old_string/new_string/replace_all +
//    read-before-write + 陈旧检测 + old==new/唯一性/回显自诊文案）
export const replaceFileContentTool: AgentTool = {
  name: 'Edit', // 1:1 cc 命名（R5）
  aliases: ['replace_file_content', 'edit', 'edit_file', 'str_replace'],
  description:
    'Replace an exact block of text in an existing file. old_string must match the file content exactly (including whitespace) and be unique unless replace_all is true. The file must have been Read first.',
  searchHint: 'replace exact matching chunk of text in file',
  isDestructive: () => false,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.file_path ? `Editing ${args.file_path}` : 'Editing file',
  getToolUseSummary: (args) => args?.file_path ? `Edit ${args.file_path}` : null,
  parameters: z.object({
    file_path: z.string().describe('Relative or absolute path to the target file to modify'),
    old_string: z.string().describe('The exact text to be replaced (must be unique unless replace_all is true)'),
    new_string: z
      .string()
      .describe('The replacement text (must be different from old_string)'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace all occurrences of old_string (default false)'),
  }),
  execute: async (rawArgs, context) => {
    const args = normalizeLegacyFields(rawArgs)
    const filePath = String(args.file_path)
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')
    const replaceAll = Boolean(args.replace_all)
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        throw new Error(`File does not exist. Note: your current working directory is ${context.workspaceRoot}.`)
      }

      // R7 read-before-write + 陈旧检测（1:1 cc readFileState error 6/7）
      const currentMtime = (await fs.stat(fullPath)).mtimeMs
      assertReadBeforeWrite(fullPath, true, currentMtime)

      if (oldString === newString) {
        throw new Error('No changes to make: old_string and new_string are exactly the same.')
      }

      // Track file edit before mutation for rollback/undo (1:1 with Claude Code fileHistory)
      if (context.fileHistoryTracker) {
        await context.fileHistoryTracker.trackEdit(fullPath, context.workspaceRoot)
      }

      const content = await fs.readFile(fullPath, 'utf-8')
      const isCrlf = content.includes('\r\n')

      // Normalize line endings for reliable matching
      const normalizedContent = content.replace(/\r\n/g, '\n')
      const normalizedTarget = oldString.replace(/\r\n/g, '\n')
      const normalizedReplacement = newString.replace(/\r\n/g, '\n')

      let count = normalizedContent.split(normalizedTarget).length - 1
      let actualTarget = normalizedTarget

      // Smart quote normalization tolerance (1:1 with Claude Code findActualString)
      if (count === 0) {
        const normalizeQuotes = (str: string) =>
          str.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
        const quoteNormContent = normalizeQuotes(normalizedContent)
        const quoteNormTarget = normalizeQuotes(normalizedTarget)
        const quoteCount = quoteNormContent.split(quoteNormTarget).length - 1
        if (quoteCount > 0) {
          const idx = quoteNormContent.indexOf(quoteNormTarget)
          actualTarget = normalizedContent.substring(idx, idx + normalizedTarget.length)
          count = quoteCount
        }
      }

      if (count === 0) {
        // 1:1 cc 文案：回显原串便于模型自查
        throw new Error(
          `String to replace not found in file.\nString: ${oldString}`
        )
      }

      if (count > 1 && !replaceAll) {
        // 1:1 cc 文案：教模型用 replace_all
        throw new Error(
          `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`
        )
      }

      let updated = replaceAll
        ? normalizedContent.replaceAll(actualTarget, normalizedReplacement)
        : normalizedContent.replace(actualTarget, normalizedReplacement)

      // Preserve CRLF if original file had Windows line endings
      if (isCrlf) {
        updated = updated.replace(/\n/g, '\r\n')
      }

      await fs.writeFile(fullPath, updated, 'utf-8')
      recordFileRead(fullPath, (await fs.stat(fullPath)).mtimeMs)
      return replaceAll
        ? `The file ${filePath} has been updated successfully. All occurrences were successfully replaced.`
        : `The file ${filePath} has been updated successfully.`
    } catch (err: any) {
      if (
        String(err?.message).includes('has not been read yet') ||
        String(err?.message).includes('modified since read') ||
        String(err?.message).includes('No changes to make') ||
        String(err?.message).includes('String to replace not found') ||
        String(err?.message).includes('matches of the string') ||
        String(err?.message).includes('File does not exist')
      ) {
        throw err
      }
      throw new Error(`Failed to replace content in "${filePath}": ${err.message}`)
    }
  }
}

// 4. LS Tool
export const listDirectoryTool: AgentTool = {
  name: 'LS', // 1:1 cc 风格命名（R5）
  aliases: ['list_directory', 'list_dir', 'ls', 'dir'],
  description: 'List files and subdirectories in a directory with item count and file sizes.',
  searchHint: 'list files and subdirectories in folder with sizes',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.dirPath ? `Listing ${args.dirPath}` : 'Listing directory',
  parameters: z.object({
    dirPath: z.string().default('.').describe('Relative or absolute path to the directory to inspect')
  }),
  execute: async ({ dirPath }, context) => {
    const fullPath = resolvePath(dirPath, context.workspaceRoot)
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true })
      const results: string[] = []

      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name)
        if (entry.isDirectory()) {
          results.push(`[DIR]  ${entry.name}/`)
        } else {
          try {
            const stat = await fs.stat(entryPath)
            results.push(`[FILE] ${entry.name} (${stat.size} bytes)`)
          } catch {
            results.push(`[FILE] ${entry.name}`)
          }
        }
      }

      return `Directory: ${dirPath}\nTotal items: ${results.length}\n` + results.join('\n')
    } catch (err: any) {
      throw new Error(`Failed to list directory "${dirPath}": ${err.message}`)
    }
  }
}
