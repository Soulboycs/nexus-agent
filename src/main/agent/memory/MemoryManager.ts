import * as fs from 'fs'
import * as path from 'path'
import {
  ENTRYPOINT_NAME,
  getAutoMemPath,
  truncateEntrypointContent,
  validateMemoryPath
} from './paths'
import {
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryItem,
  type MemoryType
} from './types'

export interface MemoryManagerOptions {
  workspaceRoot: string
  customMemoryDir?: string
  disabled?: boolean
}

export class MemoryManager {
  private workspaceRoot: string
  private memoryDir: string
  private disabled: boolean

  constructor(options: MemoryManagerOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.disabled = options.disabled || process.env.NEXUS_DISABLE_AUTO_MEMORY === '1'
    this.memoryDir = getAutoMemPath(this.workspaceRoot, {
      customDir: options.customMemoryDir
    })
  }

  public isDisabled(): boolean {
    return this.disabled
  }

  public getMemoryDir(): string {
    return this.memoryDir
  }

  public getEntrypointPath(): string {
    return path.join(this.memoryDir, ENTRYPOINT_NAME)
  }

  /**
   * Ensures the memory directory and MEMORY.md index file exist.
   */
  public async ensureMemoryDir(): Promise<void> {
    if (this.disabled) return
    if (!validateMemoryPath(this.memoryDir)) {
      throw new Error(`Invalid or dangerous memory path: ${this.memoryDir}`)
    }

    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }

    const entrypoint = this.getEntrypointPath()
    if (!fs.existsSync(entrypoint)) {
      fs.writeFileSync(
        entrypoint,
        '# Memory Index\n\n' +
        'This file indexes persistent project memories across 4 categories (user, feedback, project, reference).\n' +
        'Entries are maintained automatically or via memory tools.\n\n',
        'utf-8'
      )
    }
  }

  /**
   * Reads raw MEMORY.md content.
   */
  public getEntrypointContent(): string {
    const entrypoint = this.getEntrypointPath()
    if (!fs.existsSync(entrypoint)) {
      return ''
    }
    return fs.readFileSync(entrypoint, 'utf-8')
  }

  /**
   * Saves or updates a memory item file and updates the MEMORY.md index.
   */
  public async saveMemory(item: MemoryItem): Promise<void> {
    if (this.disabled) return
    await this.ensureMemoryDir()

    if (!item.filename || typeof item.filename !== 'string' || item.filename.includes('..') || path.isAbsolute(item.filename)) {
      throw new Error(`Invalid memory target filename: ${item.filename}`)
    }

    const targetFile = path.join(this.memoryDir, item.filename)
    if (!validateMemoryPath(targetFile, this.memoryDir)) {
      throw new Error(`Invalid memory target file: ${item.filename}`)
    }

    const content = serializeMemoryFile(item)
    fs.writeFileSync(targetFile, content, 'utf-8')

    // Update MEMORY.md index
    await this.updateEntrypointIndex(item)
  }

  /**
   * Updates or appends a link entry in MEMORY.md.
   */
  private async updateEntrypointIndex(item: MemoryItem): Promise<void> {
    const entrypoint = this.getEntrypointPath()
    let current = ''
    if (fs.existsSync(entrypoint)) {
      current = fs.readFileSync(entrypoint, 'utf-8')
    }

    const linkRegex = new RegExp(`^- \\[[^\\]]+\\]\\(${item.filename}\\).*$`, 'm')
    const newLine = `- [${item.name}](${item.filename}) — ${item.description}`

    let updated: string
    if (linkRegex.test(current)) {
      updated = current.replace(linkRegex, newLine)
    } else {
      updated = current.trimEnd() + '\n' + newLine + '\n'
    }

    fs.writeFileSync(entrypoint, updated, 'utf-8')
  }

  /**
   * Reads a memory item by filename.
   */
  public async readMemory(filename: string): Promise<MemoryItem | null> {
    if (!filename || typeof filename !== 'string' || filename.includes('..') || path.isAbsolute(filename)) {
      return null
    }
    const filePath = path.join(this.memoryDir, filename)
    if (!validateMemoryPath(filePath, this.memoryDir) || !fs.existsSync(filePath)) {
      return null
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    return parseMemoryFile(content, filename)
  }

  /**
   * Lists all memory items stored in the memory directory.
   */
  public async listMemories(): Promise<MemoryItem[]> {
    if (!fs.existsSync(this.memoryDir)) {
      return []
    }

    const files = fs.readdirSync(this.memoryDir)
    const items: MemoryItem[] = []

    for (const file of files) {
      if (file.endsWith('.md') && file !== ENTRYPOINT_NAME) {
        const item = await this.readMemory(file)
        if (item) {
          items.push(item)
        }
      }
    }

    return items
  }

  /**
   * Deletes a memory item and removes its reference in MEMORY.md.
   */
  public async deleteMemory(filename: string): Promise<boolean> {
    if (!filename || typeof filename !== 'string' || filename.includes('..') || path.isAbsolute(filename)) {
      return false
    }
    const targetFile = path.join(this.memoryDir, filename)
    if (!validateMemoryPath(targetFile, this.memoryDir)) {
      return false
    }
    let removed = false

    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile)
      removed = true
    }

    const entrypoint = this.getEntrypointPath()
    if (fs.existsSync(entrypoint)) {
      const current = fs.readFileSync(entrypoint, 'utf-8')
      const linkRegex = new RegExp(`^- \\[[^\\]]+\\]\\(${filename}\\).*\\r?\\n?`, 'm')
      const updated = current.replace(linkRegex, '')
      fs.writeFileSync(entrypoint, updated, 'utf-8')
    }

    return removed
  }

  /**
   * Builds the formatted prompt section to inject into the LLM system prompt.
   */
  public buildMemoryPrompt(): string {
    if (this.disabled) return ''

    const rawIndex = this.getEntrypointContent()
    const indexTruncation = truncateEntrypointContent(rawIndex)

    return [
      '# Auto Memory',
      `You have a persistent file-based memory system located at: "${this.memoryDir}".`,
      'This directory already exists. It allows you to maintain continuous awareness across multiple user sessions.',
      '',
      '## Types of memory',
      'Memories are strictly organized into 4 taxonomies capturing context NOT derivable from the repository code:',
      '- `user`: Information about user role, experience, tech stack preferences, and communication style.',
      '- `feedback`: Guidance the user gave you — both what to avoid (corrections) and what validated decisions to repeat (affirmations).',
      '- `project`: Non-obvious project goals, deadlines, merge freezes, and external initiatives.',
      '- `reference`: Pointers to external systems (Linear boards, Grafana metrics, internal docs).',
      '',
      '## What NOT to save',
      '- Code architecture, file structure, or git history (these are derivable via grep/file tools).',
      '- Ephemeral debugging steps or already resolved syntax errors.',
      '- Information already documented in project instruction files (e.g. CLAUDE.md/NEXUS.md).',
      '',
      '## How to save memories',
      'When learning durable facts worthy of retention:',
      '1. Write a markdown file in the memory directory with YAML frontmatter (name, description, type).',
      '2. Update MEMORY.md with a one-line index link: `- [Title](filename.md) — One-line description`.',
      '',
      '## Current MEMORY.md Index',
      indexTruncation.content || '(Currently empty)',
      ''
    ].join('\n')
  }
}
