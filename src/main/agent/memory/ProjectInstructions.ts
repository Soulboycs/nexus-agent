import * as fs from 'fs'
import * as path from 'path'

export const CANDIDATE_INSTRUCTION_FILES = [
  'NEXUS.md',
  'AGENTS.md',
  'CLAUDE.md'
]

export const MAX_INSTRUCTION_BYTES = 32_768 // 32KB cap

export class ProjectInstructions {
  private workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  /**
   * Discovers and loads project instructions from the workspace directory.
   */
  public async loadInstructionsPrompt(): Promise<string> {
    if (!this.workspaceRoot || !fs.existsSync(this.workspaceRoot)) {
      return ''
    }

    let primaryFile: string | null = null
    let primaryContent = ''

    for (const candidate of CANDIDATE_INSTRUCTION_FILES) {
      const candidatePath = path.join(this.workspaceRoot, candidate)
      if (fs.existsSync(candidatePath)) {
        try {
          const raw = fs.readFileSync(candidatePath, 'utf-8').trim()
          if (raw) {
            primaryFile = candidate
            primaryContent = raw
            break
          }
        } catch {
          // ignore read error
        }
      }
    }

    if (!primaryFile) {
      return ''
    }

    // Check for developer-local companion file (e.g. NEXUS.local.md)
    let localContent = ''
    const baseName = primaryFile.replace(/\.md$/, '')
    const localPath = path.join(this.workspaceRoot, `${baseName}.local.md`)
    if (fs.existsSync(localPath)) {
      try {
        const raw = fs.readFileSync(localPath, 'utf-8').trim()
        if (raw) {
          localContent = raw
        }
      } catch {
        // ignore
      }
    }

    let merged = primaryContent
    if (localContent) {
      merged += `\n\n## Developer Local Preferences (${baseName}.local.md)\n` + localContent
    }

    if (Buffer.byteLength(merged, 'utf-8') > MAX_INSTRUCTION_BYTES) {
      merged = merged.slice(0, MAX_INSTRUCTION_BYTES) + '\n\n> WARNING: Project instructions truncated to 32KB.'
    }

    return [
      `# Project Instructions (from ${primaryFile})`,
      'The following project-specific guidelines were discovered in the repository:',
      '',
      merged,
      ''
    ].join('\n')
  }
}
