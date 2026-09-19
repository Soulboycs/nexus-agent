import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { ToolOrchestrator } from '../src/agent/core/ToolOrchestrator'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { query } from '../src/agent/core/query'
import { AgentEvent } from '../src/shared/types'
import { z } from 'zod'

describe('Query AsyncGenerator State Machine Tests', () => {
  it('iterates through tool call and completes naturally with no recursion', async () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      name: 'echo_test',
      description: 'Echo test',
      parameters: z.object({ text: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async ({ text }: { text: string }) => `Echo: ${text}`,
    } as any)

    const orchestrator = new ToolOrchestrator(registry)
    const mockProvider = new MockLLMProvider()

    // Turn 1: Model calls tool
    mockProvider.queueResponse({
      thinking: 'Calling echo tool',
      toolCalls: [
        {
          id: 'call_1',
          name: 'echo_test',
          arguments: { text: 'Hello Bun!' },
        },
      ],
    })

    // Turn 2: Model finishes task
    mockProvider.queueResponse({
      thinking: 'Done',
      content: 'Echo finished successfully!',
    })

    const events: AgentEvent[] = []
    const q = query({
      messages: [{ role: 'user', content: 'Say hello' }],
      toolRegistry: registry,
      orchestrator,
      provider: mockProvider,
      workspaceRoot: '.',
    })

    for await (const event of q) {
      events.push(event)
    }

    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('status_change')
    expect(eventTypes).toContain('thinking_delta')
    expect(eventTypes).toContain('tool_call_start')
    expect(eventTypes).toContain('tool_call_complete')
    expect(eventTypes).toContain('message_delta')

    // Find final completion status
    const completedEvent = events.find(
      (e) => e.type === 'status_change' && e.status === 'completed'
    )
    expect(completedEvent).toBeDefined()
  })

  it('pauses and awaits user confirmation for dangerous actions', async () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      name: 'rm_danger',
      description: 'Dangerous remove tool',
      parameters: z.object({ target: z.string() }),
      requiresApproval: () => true,
      execute: async () => 'deleted',
    } as any)

    const orchestrator = new ToolOrchestrator(registry)
    const mockProvider = new MockLLMProvider()

    mockProvider.queueResponse({
      toolCalls: [
        {
          id: 'call_danger',
          name: 'rm_danger',
          arguments: { target: 'system32' },
        },
      ],
    })

    mockProvider.queueResponse({
      content: 'Finished after confirmation',
    })

    let approvalHandled = false
    const q = query({
      messages: [{ role: 'user', content: 'Delete system' }],
      toolRegistry: registry,
      orchestrator,
      provider: mockProvider,
      workspaceRoot: '.',
      onApprovalRequired: async () => {
        approvalHandled = true
        return true // User approved
      },
    })

    for await (const _ of q) {
      // drain
    }

    expect(approvalHandled).toBe(true)
  })

  it('safely compensates missing tool results when aborted mid-flight (preventing API 400)', async () => {
    const registry = new ToolRegistry()
    const abortController = new AbortController()

    registry.registerTool({
      name: 'slow_task_1',
      description: 'Slow task 1',
      parameters: z.object({ id: z.number() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        // Abort during first tool execution
        abortController.abort()
        return 'done_1'
      },
    } as any)

    registry.registerTool({
      name: 'slow_task_2',
      description: 'Slow task 2',
      parameters: z.object({ id: z.number() }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => 'done_2',
    } as any)

    const orchestrator = new ToolOrchestrator(registry)
    const mockProvider = new MockLLMProvider()

    // Model outputs 2 tool calls
    mockProvider.queueResponse({
      toolCalls: [
        { id: 'call_1', name: 'slow_task_1', arguments: { id: 1 } },
        { id: 'call_2', name: 'slow_task_2', arguments: { id: 2 } },
      ],
    })

    const q = query({
      messages: [{ role: 'user', content: 'Run both tasks' }],
      toolRegistry: registry,
      orchestrator,
      provider: mockProvider,
      workspaceRoot: '.',
      signal: abortController.signal,
    })

    const events: AgentEvent[] = []
    let terminalResult: any
    while (true) {
      const next = await q.next()
      if (next.done) {
        terminalResult = next.value
        break
      }
      events.push(next.value)
    }

    expect(terminalResult.reason).toBe('aborted')
    // Messages must contain the assistant message and matching tool results for both call_1 and call_2
    const messages = terminalResult.messages
    const assistantMsg = messages.find((m: any) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.tool_calls?.length).toBe(2)

    const toolMessages = messages.filter((m: any) => m.role === 'tool')
    expect(toolMessages.length).toBe(2)
    const toolCallIds = toolMessages.map((m: any) => m.tool_call_id)
    expect(toolCallIds).toContain('call_1')
    expect(toolCallIds).toContain('call_2')

    // call_2 was not run before abort, so its result must be compensated as cancelled
    const call2Msg = toolMessages.find((m: any) => m.tool_call_id === 'call_2')
    expect(call2Msg.content).toContain('cancelled')
  })

  it('safely halts when reaching maxTurns limit', async () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      name: 'loop_tool',
      description: 'Loop tool',
      parameters: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => 'loop',
    } as any)

    const orchestrator = new ToolOrchestrator(registry)
    const mockProvider = new MockLLMProvider()

    // Model keeps calling tool endlessly
    for (let i = 0; i < 10; i++) {
      mockProvider.queueResponse({
        toolCalls: [{ id: `call_${i}`, name: 'loop_tool', arguments: {} }],
      })
    }

    const q = query({
      messages: [{ role: 'user', content: 'Loop forever' }],
      toolRegistry: registry,
      orchestrator,
      provider: mockProvider,
      workspaceRoot: '.',
      maxTurns: 3,
    })

    let terminalResult: any
    while (true) {
      const next = await q.next()
      if (next.done) {
        terminalResult = next.value
        break
      }
    }

    expect(terminalResult.reason).toBe('max_turns')
  })
})
