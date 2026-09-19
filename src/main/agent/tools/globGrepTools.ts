import { z } from 'zod'
import { AgentTool } from './ToolRegistry'
import fs from 'node:fs/promises'
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
  name: 'GlobTool',
  aliases: ['glob', 'find_files', 'find_by_name'],
  description: 'Search for files by name pattern or wildcard (e.g. "*.ts", "src/**/*.tsx").',
  searchHint: 'fast file search by pattern wildcard glob',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.pattern ? `Searching files "${args.pattern}"` : 'Searching files',
  getToolUseSummary: (args) => args?.pattern ? `Glob: ${args.pattern}` : null,
  parameters: z.object({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z.string().optional().describe('The directory to search in. Defaults to workspace root.')
  }),
  execute: async ({ pattern, path: searchPath }, context) => {
    const rootPath = searchPath ? resolvePath(searchPath, context.workspaceRoot) : context.workspaceRoot
    try {
      const regex = patternToRegex(pattern)
      const results: string[] = []
      let count = 0

      for await (const fullPath of walkDirectory(rootPath)) {
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
        if (regex.test(relPath) || regex.test(path.basename(fullPath))) {
          results.push(relPath)
          count++
          if (count > 200) {
            results.push('... (truncated)')
            break
          }
        }
      }
      if (results.length === 0) return 'No files found'
      return results.join('\n')
    } catch (err: any) {
      throw new Error(`GlobTool failed: ${err.message}`)
    }
  }
}

export const grepTool: AgentTool = {
  name: 'GrepTool',
  aliases: ['grep', 'search_text', 'grep_search'],
  description: 'Search file contents with regex. Returns matching lines and line numbers.',
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
    globPattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts")')
  }),
  execute: async ({ pattern, path: searchPath, globPattern }, context) => {
    const rootPath = searchPath ? resolvePath(searchPath, context.workspaceRoot) : context.workspaceRoot
    const regex = new RegExp(pattern, 'g')
    const filterRegex = globPattern ? patternToRegex(globPattern) : null

    try {
      const results: string[] = []
      let matchCount = 0

      for await (const fullPath of walkDirectory(rootPath)) {
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
        if (filterRegex && !filterRegex.test(relPath) && !filterRegex.test(path.basename(fullPath))) {
          continue
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          if (content.indexOf('\0') !== -1) continue // Skip binary files

          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i])) {
              results.push(`${relPath}:${i + 1}:${lines[i].trim()}`)
              matchCount++
              if (matchCount > 300) {
                results.push('... (truncated)')
                return results.join('\n')
              }
            }
          }
        } catch {
          // ignore unreadable files
        }
      }

      if (results.length === 0) return 'No matches found'
      return results.join('\n')
    } catch (err: any) {
      throw new Error(`GrepTool failed: ${err.message}`)
    }
  }
}
