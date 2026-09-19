import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  ToolSearchManager,
  buildSchemaNotSentHint,
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME
} from '../../src/main/agent/tools/ToolSearchTool'
import { ToolRegistry, AgentTool } from '../../src/main/agent/tools/ToolRegistry'

describe('ToolSearch & Deferred Loading - Context Budget Preservation', () => {
  let registry: ToolRegistry
  let manager: ToolSearchManager

  const mockTool1: AgentTool = {
    name: 'mcp__github__create_issue',
    aliases: ['create_issue', 'new_issue'],
    description: 'Create a new issue on GitHub repository.',
    searchHint: 'create github issue ticket bug report',
    shouldDefer: true,
    parameters: z.object({ title: z.string(), body: z.string() }),
    execute: async () => 'Issue created'
  }

  const mockTool2: AgentTool = {
    name: 'mcp__github__list_pull_requests',
    aliases: ['list_prs'],
    description: 'List pull requests for a repository.',
    searchHint: 'github pull requests review prs',
    shouldDefer: true,
    parameters: z.object({ repo: z.string() }),
    execute: async () => 'PRs listed'
  }

  const baseTool: AgentTool = {
    name: 'read_file',
    description: 'Read file content.',
    alwaysLoad: true,
    parameters: z.object({ path: z.string() }),
    execute: async () => 'file content'
  }

  beforeEach(() => {
    registry = new ToolRegistry()
    manager = new ToolSearchManager({
      autoEnablePercentage: 10,
      contextWindowTokens: 1000
    })

    registry.registerTool(mockTool1)
    registry.registerTool(mockTool2)
    registry.registerTool(baseTool)
  })

  it('calculates token overhead and determines if auto-enable is triggered', () => {
    const tokens = manager.estimateToolTokens(registry.getAllTools())
    expect(tokens).toBeGreaterThan(0)

    // With a tiny 50-token threshold, auto-enable should be true
    const sensitiveManager = new ToolSearchManager({
      autoEnablePercentage: 5,
      contextWindowTokens: 500 // threshold = 25 tokens
    })
    expect(sensitiveManager.shouldAutoEnableToolSearch(registry.getAllTools())).toBe(true)
  })

  it('searches tools by keywords and matches name, aliases, searchHint, and description', () => {
    const res = manager.search('ticket bug', registry.getAllTools())
    expect(res.matches.length).toBeGreaterThanOrEqual(1)
    expect(res.matches[0].name).toBe('mcp__github__create_issue')
    expect(manager.isDiscovered('mcp__github__create_issue')).toBe(true)
  })

  it('selects tool directly using "select:<tool_name>" syntax', () => {
    const res = manager.search('select:mcp__github__list_pull_requests', registry.getAllTools())
    expect(res.exactSelect).toBe(true)
    expect(res.matches.length).toBe(1)
    expect(res.matches[0].name).toBe('mcp__github__list_pull_requests')
    expect(manager.isDiscovered('mcp__github__list_pull_requests')).toBe(true)
  })

  it('builds schema-not-sent hint when an un-discovered deferred tool is called', () => {
    // Before discovery
    const hint = buildSchemaNotSentHint(mockTool1, manager.discoveredToolNames)
    expect(hint).not.toBeNull()
    expect(hint).toContain('This tool\'s schema was not sent to the API')
    expect(hint).toContain(`select:${mockTool1.name}`)

    // Non-deferred or alwaysLoad tools return null
    expect(buildSchemaNotSentHint(baseTool, manager.discoveredToolNames)).toBeNull()

    // Once discovered, hint returns null
    manager.markDiscovered(mockTool1.name)
    expect(buildSchemaNotSentHint(mockTool1, manager.discoveredToolNames)).toBeNull()
  })

  it('ToolSearchTool activates discovered tools and returns informative confirmation', async () => {
    const searchTool = createToolSearchTool(registry, manager)
    expect(searchTool.name).toBe(TOOL_SEARCH_TOOL_NAME)
    expect(searchTool.alwaysLoad).toBe(true)

    const output = await searchTool.execute({ query: 'pull requests' }, { workspaceRoot: '/test' })
    expect(output).toContain('mcp__github__list_pull_requests')
    expect(manager.isDiscovered('mcp__github__list_pull_requests')).toBe(true)

    // Now getActiveTools includes the discovered tool
    const activeTools = registry.getActiveTools(manager.discoveredToolNames)
    const activeNames = activeTools.map((t) => t.name)
    expect(activeNames).toContain('mcp__github__list_pull_requests')
    expect(activeNames).toContain('read_file') // alwaysLoad
    expect(activeNames).not.toContain('mcp__github__create_issue') // still deferred
  })
})
