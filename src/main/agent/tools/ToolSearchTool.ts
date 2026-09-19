import { z } from 'zod'
import { AgentTool, ToolRegistry, ToolContext } from './ToolRegistry'
import { resolveToolDescription } from '../utils/toolSchemas'

export const TOOL_SEARCH_TOOL_NAME = 'tool_search'

export interface ToolSearchManagerOptions {
  autoEnablePercentage?: number // Default: 10%
  contextWindowTokens?: number  // Default: 128,000 tokens
}

/**
 * 1:1 with Claude Code src/utils/toolSearch.ts:
 * Dynamic tool search & deferred loading manager.
 * Preserves LLM context budget by deferring complex/MCP tool schemas until
 * specifically searched and discovered by the model.
 */
export class ToolSearchManager {
  public discoveredToolNames = new Set<string>()
  private autoEnablePercentage: number
  private contextWindowTokens: number

  constructor(options?: ToolSearchManagerOptions) {
    this.autoEnablePercentage = options?.autoEnablePercentage ?? 10
    this.contextWindowTokens = options?.contextWindowTokens ?? 128_000
  }

  /**
   * Approximate token count for tool definitions (3.5 chars per token estimate)
   */
  estimateToolTokens(tools: AgentTool[]): number {
    let totalChars = 0
    for (const tool of tools) {
      totalChars += tool.name.length + resolveToolDescription(tool).length
      if (tool.searchHint) totalChars += tool.searchHint.length
      // Approximate serialized JSON Schema representation
      try {
        const shape = (tool.parameters as any)._def?.shape?.() || (tool.parameters as any)._def?.shape
        if (shape) {
          totalChars += Object.keys(shape).join(',').length * 20
        }
      } catch {}
    }
    return Math.ceil(totalChars / 3.5)
  }

  /**
   * Determine if tool search should automatically activate based on tool schema token overhead
   */
  shouldAutoEnableToolSearch(tools: AgentTool[]): boolean {
    const thresholdTokens = Math.floor(this.contextWindowTokens * (this.autoEnablePercentage / 100))
    const currentTokens = this.estimateToolTokens(tools)
    return currentTokens > thresholdTokens
  }

  /**
   * Search tools by keyword or select by exact name ('select:<name>')
   */
  search(query: string, allTools: AgentTool[]): { matches: AgentTool[]; exactSelect: boolean } {
    const trimmed = query.trim()
    if (trimmed.startsWith('select:')) {
      const targetName = trimmed.slice(7).trim()
      const exact = allTools.find((t) => t.name === targetName || t.aliases?.includes(targetName))
      if (exact) {
        this.discoveredToolNames.add(exact.name)
        return { matches: [exact], exactSelect: true }
      }
      return { matches: [], exactSelect: true }
    }

    const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
    const scored: Array<{ tool: AgentTool; score: number }> = []

    for (const tool of allTools) {
      let score = 0
      const nameLower = tool.name.toLowerCase()
      const descLower = resolveToolDescription(tool).toLowerCase()
      const hintLower = (tool.searchHint || '').toLowerCase()
      const aliasesLower = (tool.aliases || []).map((a) => a.toLowerCase())

      for (const term of terms) {
        if (nameLower === term) score += 50
        else if (nameLower.includes(term)) score += 20

        if (aliasesLower.some((a) => a === term)) score += 30
        else if (aliasesLower.some((a) => a.includes(term))) score += 15

        if (hintLower.includes(term)) score += 15
        if (descLower.includes(term)) score += 5
      }

      if (score > 0) {
        scored.push({ tool, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    const matches = scored.slice(0, 8).map((s) => s.tool)
    for (const m of matches) {
      this.discoveredToolNames.add(m.name)
    }

    return { matches, exactSelect: false }
  }

  markDiscovered(toolName: string): void {
    this.discoveredToolNames.add(toolName)
  }

  isDiscovered(toolName: string): boolean {
    return this.discoveredToolNames.has(toolName)
  }

  reset(): void {
    this.discoveredToolNames.clear()
  }
}

/**
 * 1:1 with Claude Code buildSchemaNotSentHint:
 * When a model attempts to call a deferred tool without discovering it first,
 * returns a helpful guiding hint instead of a cryptic schema validation error.
 */
export function buildSchemaNotSentHint(tool: AgentTool, discoveredNames: Set<string>): string | null {
  if (!tool.shouldDefer) return null
  if (tool.alwaysLoad) return null
  if (discoveredNames.has(tool.name)) return null

  return (
    `\n\nThis tool's schema was not sent to the API — it is currently deferred to preserve context. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}

/**
 * Factory to create the ToolSearchTool
 */
export function createToolSearchTool(
  registry: ToolRegistry,
  manager: ToolSearchManager
): AgentTool<{ query: string }> {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description: 'Search for available deferred or specialized tools by keyword, or activate a tool using "select:<tool_name>".',
    searchHint: 'search and discover deferred specialized tools',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    alwaysLoad: true,
    parameters: z.object({
      query: z.string().describe('Search terms (e.g. "github issue", "jupyter notebook") or "select:<tool_name>" to load a specific tool')
    }),
    execute: async ({ query }: { query: string }, _context: ToolContext) => {
      const allTools = registry.getAllTools()
      const { matches, exactSelect } = manager.search(query, allTools)

      if (matches.length === 0) {
        return `No matching tools found for query: "${query}". Call list_directory or view_file to check project structure.`
      }

      let res = exactSelect
        ? `Successfully activated tool "${matches[0].name}". Full schema is now loaded in your context.\n`
        : `Found ${matches.length} matching tool(s). They are now activated in your session:\n`

      for (const t of matches) {
        res += `\n- **${t.name}**: ${resolveToolDescription(t)}`
        if (t.searchHint) {
          res += ` (Capabilities: ${t.searchHint})`
        }
      }

      res += '\n\nYou may now invoke any of the above tools directly in subsequent steps.'
      return res
    }
  }
}
