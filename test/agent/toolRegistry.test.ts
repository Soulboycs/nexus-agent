import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, AgentTool, ToolContext } from '../../src/main/agent/tools/ToolRegistry'

describe('ToolRegistry - Prompt Cache Sorting, Aliases & Pipeline', () => {
  let registry: ToolRegistry
  const mockContext: ToolContext = { workspaceRoot: '/test/workspace' }

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('orders built-in tools as contiguous stable prefix before MCP tools for prompt cache stability', () => {
    const mcpToolB: AgentTool = {
      name: 'mcp__zebra__tool',
      description: 'Zebra MCP',
      isMcp: true,
      parameters: z.object({}),
      execute: async () => 'z'
    }

    const mcpToolA: AgentTool = {
      name: 'mcp__alpha__tool',
      description: 'Alpha MCP',
      isMcp: true,
      parameters: z.object({}),
      execute: async () => 'a'
    }

    const builtInZ: AgentTool = {
      name: 'write_file',
      description: 'Write file',
      parameters: z.object({}),
      execute: async () => 'write'
    }

    const builtInA: AgentTool = {
      name: 'read_file',
      description: 'Read file',
      parameters: z.object({}),
      execute: async () => 'read'
    }

    // Register in mixed order
    registry.registerTool(mcpToolB)
    registry.registerTool(builtInZ)
    registry.registerTool(mcpToolA)
    registry.registerTool(builtInA)

    const allTools = registry.getAllTools()
    const names = allTools.map((t) => t.name)

    // Built-ins MUST be sorted alphabetically as the contiguous prefix!
    // Then MCP tools follow, sorted alphabetically.
    expect(names).toEqual([
      'read_file',
      'write_file',
      'mcp__alpha__tool',
      'mcp__zebra__tool'
    ])
  })

  it('resolves tools by deprecated aliases cleanly', () => {
    const toolWithAliases: AgentTool = {
      name: 'task_stop',
      aliases: ['kill_shell', 'stop_task'],
      description: 'Stop a running task',
      parameters: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => `Stopped ${taskId}`
    }

    registry.registerTool(toolWithAliases)

    // Can resolve by canonical name
    expect(registry.getTool('task_stop')).toBe(toolWithAliases)

    // Can resolve by alias 1
    expect(registry.getTool('kill_shell')).toBe(toolWithAliases)

    // Can resolve by alias 2
    expect(registry.getTool('stop_task')).toBe(toolWithAliases)
  })

  it('blocks tool execution when validateInput semantic check fails', async () => {
    const validatingTool: AgentTool = {
      name: 'validated_action',
      description: 'Action with semantic validation',
      parameters: z.object({ count: z.number() }),
      validateInput: async ({ count }) => {
        if (count <= 0) {
          return { result: false, message: 'Count must be positive integer' }
        }
        return { result: true }
      },
      execute: async ({ count }) => `Executed with ${count}`
    }

    registry.registerTool(validatingTool)

    const failRes = await registry.executeTool('validated_action', { count: -5 }, mockContext)
    expect(failRes.isError).toBe(true)
    expect(failRes.error).toContain('Count must be positive integer')

    const successRes = await registry.executeTool('validated_action', { count: 10 }, mockContext)
    expect(successRes.isError).toBe(false)
    expect(successRes.output).toBe('Executed with 10')
  })

  it('runs complete lifecycle hooks through ToolRegistry.executeTool', async () => {
    const simpleTool: AgentTool = {
      name: 'echo_tool',
      description: 'Echoes message',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `Echo: ${msg}`
    }

    registry.registerTool(simpleTool)

    // Attach pre-hook to transform input
    registry.getHooks().registerPreToolHook(async (name, input) => {
      return {
        decision: 'allow',
        updatedInput: { msg: (input.msg as string).toUpperCase() }
      }
    })

    // Attach post-hook to append footer
    registry.getHooks().registerPostToolHook(async (name, input, output) => {
      return {
        modifiedOutput: output + ' [VERIFIED]'
      }
    })

    const res = await registry.executeTool('echo_tool', { msg: 'hello' }, mockContext)
    expect(res.isError).toBe(false)
    expect(res.output).toBe('Echo: HELLO [VERIFIED]')
  })
})
