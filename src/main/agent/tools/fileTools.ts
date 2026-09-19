import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

function resolvePath(filePath: string, workspaceRoot: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath)
  }
  return path.normalize(path.join(workspaceRoot, filePath))
}

// 1. view_file Tool
export const viewFileTool: AgentTool = {
  name: 'view_file',
  aliases: ['read_file', 'cat'],
  description: 'View file content with line numbers. Supports slice notation with StartLine and EndLine (1-indexed).',
  searchHint: 'view file content with line numbers',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  alwaysLoad: true,
  // 1:1 with Claude Code: Infinity prevents circular Read -> Persist -> Read loops
  maxResultSizeChars: Infinity,
  getActivityDescription: (args) => args?.filePath ? `Reading ${args.filePath}` : 'Reading file',
  getToolUseSummary: (args) => args?.filePath ? `Read ${args.filePath}` : null,
  parameters: z.object({
    filePath: z.string().describe('Relative or absolute path to the file to view'),
    startLine: z.number().int().positive().optional().describe('Start line number (1-indexed, inclusive)'),
    endLine: z.number().int().positive().optional().describe('End line number (1-indexed, inclusive)')
  }),
  execute: async ({ filePath, startLine, endLine }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const stats = await fs.stat(fullPath)
      if (stats.isDirectory()) {
        throw new Error(`Path "${filePath}" is a directory, not a file. Use list_directory instead.`)
      }

      const content = await fs.readFile(fullPath, 'utf-8')
      const lines = content.split(/\r?\n/)
      const totalLines = lines.length

      const start = startLine ? Math.max(1, startLine) : 1
      const end = endLine ? Math.min(totalLines, endLine) : Math.min(totalLines, start + 799)

      if (start > totalLines) {
        return `File: ${filePath} (Total Lines: ${totalLines})\n[Start line ${start} exceeds total lines in file]`
      }

      const selectedLines = lines.slice(start - 1, end).map((line, idx) => {
        const lineNum = (start + idx).toString().padStart(4, ' ')
        return `${lineNum}: ${line}`
      })

      let result = `File: ${filePath} (Lines ${start}-${end} of ${totalLines})\n`
      result += selectedLines.join('\n')
      if (end < totalLines && !endLine) {
        result += `\n... [${totalLines - end} more lines. Use startLine=${end + 1} to read more]`
      }
      return result
    } catch (err: any) {
      throw new Error(`Failed to view file "${filePath}": ${err.message}`)
    }
  }
}

// 2. write_to_file Tool
export const writeToFileTool: AgentTool = {
  name: 'write_to_file',
  aliases: ['write_file', 'create_file'],
  description: 'Create a new file or completely overwrite an existing file with the given content.',
  searchHint: 'create new file or overwrite entire file content',
  isDestructive: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.filePath ? `Writing ${args.filePath}` : 'Writing file',
  getToolUseSummary: (args) => args?.filePath ? `Write ${args.filePath}` : null,
  parameters: z.object({
    filePath: z.string().describe('Relative or absolute path to the file to create'),
    content: z.string().describe('Code/text content to write to the file'),
    overwrite: z.boolean().default(true).describe('Whether to overwrite if file already exists')
  }),
  // Fallback-path defense (no permissionEngine contexts): sensitive credentials
  // ask before overwrite. With an engine present the built-in sensitive-write
  // rule in PermissionEngine handles this identically.
  requiresApproval: ({ filePath }: any) => {
    const lower = String(filePath || '').toLowerCase()
    return lower.includes('.env') || lower.includes('credentials')
  },
  execute: async ({ filePath, content, overwrite }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false)

      if (exists && !overwrite) {
        throw new Error(`File "${filePath}" already exists and overwrite is set to false.`)
      }

      // Track file edit before mutation for rollback/undo (1:1 with Claude Code fileHistory)
      if (context.fileHistoryTracker) {
        await context.fileHistoryTracker.trackEdit(fullPath, context.workspaceRoot)
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content, 'utf-8')
      return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to "${filePath}".`
    } catch (err: any) {
      throw new Error(`Failed to write file "${filePath}": ${err.message}`)
    }
  }
}

// 3. replace_file_content Tool
export const replaceFileContentTool: AgentTool = {
  name: 'replace_file_content',
  aliases: ['edit_file', 'str_replace'],
  description: 'Precisely replace a target block of text with replacement content in an existing file.',
  searchHint: 'replace exact matching chunk of text in file',
  isDestructive: () => false,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.filePath ? `Editing ${args.filePath}` : 'Editing file',
  getToolUseSummary: (args) => args?.filePath ? `Edit ${args.filePath}` : null,
  parameters: z.object({
    filePath: z.string().describe('Relative or absolute path to the target file to modify'),
    targetContent: z.string().describe('The exact text block to be replaced (must match existing file content exactly)'),
    replacementContent: z.string().describe('The replacement text'),
    allowMultiple: z.boolean().default(false).describe('Allow replacing multiple occurrences if true')
  }),
  execute: async ({ filePath, targetContent, replacementContent, allowMultiple }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      // Track file edit before mutation for rollback/undo (1:1 with Claude Code fileHistory)
      if (context.fileHistoryTracker) {
        await context.fileHistoryTracker.trackEdit(fullPath, context.workspaceRoot)
      }

      const content = await fs.readFile(fullPath, 'utf-8')
      const isCrlf = content.includes('\r\n')

      // Normalize line endings for reliable matching
      const normalizedContent = content.replace(/\r\n/g, '\n')
      const normalizedTarget = targetContent.replace(/\r\n/g, '\n')
      const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n')

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
        throw new Error(
          `targetContent not found in "${filePath}". Ensure exact whitespace, indentations and line breaks match.`
        )
      }

      if (count > 1 && !allowMultiple) {
        throw new Error(
          `targetContent matches ${count} locations in "${filePath}". Provide more surrounding context lines to ensure uniqueness or set allowMultiple: true.`
        )
      }

      let updated = allowMultiple
        ? normalizedContent.replaceAll(actualTarget, normalizedReplacement)
        : normalizedContent.replace(actualTarget, normalizedReplacement)

      // Preserve CRLF if original file had Windows line endings
      if (isCrlf) {
        updated = updated.replace(/\n/g, '\r\n')
      }

      await fs.writeFile(fullPath, updated, 'utf-8')
      return `Successfully replaced ${count} occurrence(s) of content in "${filePath}".`
    } catch (err: any) {
      throw new Error(`Failed to replace content in "${filePath}": ${err.message}`)
    }
  }
}

// 4. list_directory Tool
export const listDirectoryTool: AgentTool = {
  name: 'list_directory',
  aliases: ['list_dir', 'ls', 'dir'],
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
          results.push(`📁 [DIR]  ${entry.name}/`)
        } else {
          try {
            const stat = await fs.stat(entryPath)
            results.push(`📄 [FILE] ${entry.name} (${stat.size} bytes)`)
          } catch {
            results.push(`📄 [FILE] ${entry.name}`)
          }
        }
      }

      return `Directory: ${dirPath}\nTotal items: ${results.length}\n` + results.join('\n')
    } catch (err: any) {
      throw new Error(`Failed to list directory "${dirPath}": ${err.message}`)
    }
  }
}
