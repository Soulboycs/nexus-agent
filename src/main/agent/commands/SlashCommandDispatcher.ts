import type { AgentEngine } from '../core/AgentEngine'

export interface SlashCommandResult {
  handled: boolean
  output?: string
}

export class SlashCommandDispatcher {
  constructor(private engine: AgentEngine) {}

  /**
   * Evaluates input for slash commands (/clear, /memory, /compact, /help).
   */
  public async dispatch(input: string): Promise<SlashCommandResult> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) {
      return { handled: false }
    }

    const parts = trimmed.split(/\s+/)
    const command = parts[0].toLowerCase()

    switch (command) {
      case '/clear': {
        this.engine.setConversationHistory([])
        return {
          handled: true,
          output: 'Conversation cleared. Context reset to initial system state.'
        }
      }

      case '/memory': {
        const memManager = this.engine.getMemoryManager()
        const items = await memManager.listMemories()
        const entrypoint = memManager.getEntrypointContent()

        let report = '### Persistent Project Memory (`~/.nexus/projects/{hash}/memory/`)\n\n'
        report += `**Active Index (` + memManager.getEntrypointPath() + `)**:\n`
        report += (entrypoint || '*(Index is currently empty)*') + '\n\n'

        if (items.length > 0) {
          report += '#### Stored Memory Items (' + items.length + '):\n'
          for (const it of items) {
            report += `- **[${it.type}] ${it.name}** (\`${it.filename}\`): ${it.description}\n`
          }
        } else {
          report += '*(No topic memory files stored yet. Facts will be extracted as you converse.)*\n'
        }

        return {
          handled: true,
          output: report
        }
      }

      case '/compact': {
        const history = this.engine.getConversationHistory()
        const compactor = this.engine.getCompactor()

        // 1. Run microcompaction first
        const microRes = compactor.microcompactToolResults(history)
        let currentHistory = history
        let totalSaved = 0

        if (microRes.compacted) {
          currentHistory = microRes.messages
          totalSaved += microRes.savedTokens
        }

        // 2. Force macro-compaction if requested
        const res = await compactor.compactHistory(currentHistory, { force: true })
        if (res.compacted) {
          totalSaved += res.savedTokens
          this.engine.setConversationHistory(res.messages)
          return {
            handled: true,
            output: `Conversation successfully compacted! Saved approximately ~${totalSaved} tokens.`
          }
        }

        if (microRes.compacted) {
          this.engine.setConversationHistory(currentHistory)
          return {
            handled: true,
            output: `Microcompaction cleared ${microRes.clearedCount} historical tool output(s)! Saved approximately ~${totalSaved} tokens.`
          }
        }

        return {
          handled: true,
          output: 'Conversation is already compact (insufficient earlier rounds to compress).'
        }
      }

      case '/undo': {
        const tracker = this.engine.getFileHistoryTracker()
        if (!tracker || !tracker.canRewind()) {
          return {
            handled: true,
            output: 'No file modifications available to undo.'
          }
        }

        const res = await tracker.rewindLastSnapshot(this.engine.getWorkspaceRoot())
        const total = res.restored.length + res.deleted.length
        if (total === 0) {
          return {
            handled: true,
            output: 'No file modifications found in the most recent snapshot.'
          }
        }

        const lines = [`Successfully reverted ${total} file modification(s):`]
        for (const f of res.restored) {
          lines.push(`- Restored: \`${f}\``)
        }
        for (const f of res.deleted) {
          lines.push(`- Removed created file: \`${f}\``)
        }
        return {
          handled: true,
          output: lines.join('\n')
        }
      }

      case '/help': {
        return {
          handled: true,
          output: [
            '### Available Slash Commands',
            '- `/clear`: Clear conversation history and reset context.',
            '- `/memory`: Inspect active persistent memory index and saved items.',
            '- `/compact`: Manually compress earlier conversation turns into a compact summary.',
            '- `/undo`: Revert file modifications made during the most recent turn.'
          ].join('\n')
        }
      }

      default:
        return { handled: false }
    }
  }
}
