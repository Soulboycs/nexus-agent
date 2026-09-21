import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { query } from '../src/agent/core/query'
import { ILLMProvider, LLMMessage, LLMStreamChunk, AgentTool } from '../src/main/agent/providers/LLMProvider'
import { AgentEvent, ToolResultPayload } from '../src/shared/types'
import { z } from 'zod'

/**
 * P1 回归：query 循环接入 StreamingToolExecutor 后的流式执行语义。
 * 覆盖：真实增量转发（非整轮一次性）、块级提前执行（流未结束工具已开跑）、
 * 到达序执行（非并发安全工具等待前面的并发工具）、门禁在 executor 内生效、
 * run_command 失败的兄弟级联 abort。
 */

class DelayedStreamProvider implements ILLMProvider {
  streamEndedAt = 0
  toolStartedAt = 0

  constructor(private script: (onChunk: (c: LLMStreamChunk) => void) => void) {}

  async chatStream(
    _messages: LLMMessage[],
    _tools: AgentTool[],
    onChunk: (chunk: LLMStreamChunk) => void
  ) {
    this.script(onChunk)
    await new Promise((r) => setTimeout(r, 120))
    this.streamEndedAt = Date.now()
    return { fullThinking: '', fullContent: '', toolCalls: [] }
  }
}

async function collect(q: AsyncGenerator<AgentEvent, any>) {
  const events: AgentEvent[] = []
  while (true) {
    const next = await q.next()
    if (next.done) return { events, terminal: next.value }
    events.push(next.value)
  }
}

describe('P1 流式工具执行 — query × StreamingToolExecutor', () => {
  it('转发真实增量：每个 content chunk 成为独立 message_delta 事件（回归：曾是整轮一次性）', async () => {
    const registry = new ToolRegistry()
    const provider = new DelayedStreamProvider((onChunk) => {
      onChunk({ content: 'Hello ' })
      onChunk({ content: 'streaming ' })
      onChunk({ content: 'world' })
    })
    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'hi' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )
    const deltas = events.filter((e) => e.type === 'message_delta').map((e) => (e as any).delta)
    expect(deltas).toEqual(['Hello ', 'streaming ', 'world'])
  })

  it('块级提前执行：completedToolCalls 在流结束前即开跑（startedAt < streamEndedAt）', async () => {
    const registry = new ToolRegistry()
    const provider = new DelayedStreamProvider((onChunk) => {
      onChunk({ content: 'thinking aloud...' })
      onChunk({ completedToolCalls: [{ id: 'c1', name: 'early_probe', arguments: '{}' }] })
    })
    let toolStartedAt = 0
    registry.registerTool({
      name: 'early_probe',
      description: 'probe',
      parameters: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        toolStartedAt = Date.now()
        return 'probed'
      },
    } as any)

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    expect(toolStartedAt).toBeGreaterThan(0)
    expect(toolStartedAt).toBeLessThan(provider.streamEndedAt)
    const completes = events.filter((e) => e.type === 'tool_call_complete') as any[]
    expect(completes.map((e) => e.result.name)).toContain('early_probe')
    expect(completes[0].result.isError ?? false).toBe(false)
  })

  it('到达序执行：非并发安全工具等待前面的并发工具完成（完成顺序 = 到达顺序）', async () => {
    const registry = new ToolRegistry()
    const provider = new DelayedStreamProvider((onChunk) => {
      onChunk({
        completedToolCalls: [
          { id: 'a', name: 'slow_read', arguments: '{}' },
          { id: 'b', name: 'write_thing', arguments: '{}' },
        ],
      })
    })
    registry.registerTool({
      name: 'slow_read',
      description: 'slow concurrent read',
      parameters: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80))
        return 'slow_done'
      },
    } as any)
    registry.registerTool({
      name: 'write_thing',
      description: 'non-concurrent write',
      parameters: z.object({}),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => 'write_done',
    } as any)

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const completes = events.filter((e) => e.type === 'tool_call_complete') as any[]
    const order = completes.map((e) => e.result.name)
    expect(order.indexOf('slow_read')).toBeLessThan(order.indexOf('write_thing'))
  })

  it('门禁在 executor 内生效：permission engine deny → 工具永不执行，返回策略错误', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.registerTool({
      name: 'blocked_tool',
      description: 'blocked',
      parameters: z.object({}),
      execute: async () => {
        executed++
        return 'should not happen'
      },
    } as any)
    const provider = new DelayedStreamProvider((onChunk) => {
      onChunk({ completedToolCalls: [{ id: 'x1', name: 'blocked_tool', arguments: '{}' }] })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
        permissionEngine: {
          evaluate: () => ({ allowed: false, requiresApproval: false, behavior: 'deny', reason: 'policy: no tools for you' }),
        } as any,
      } as any)
    )

    expect(executed).toBe(0)
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(complete.result.error).toContain('policy')
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true)
  })

  it('run_command 失败触发兄弟级联 abort：并发兄弟工具观察到 signal 中止', async () => {
    const registry = new ToolRegistry()
    const provider = new DelayedStreamProvider((onChunk) => {
      onChunk({
        completedToolCalls: [
          { id: 'cmd1', name: 'run_command', arguments: '{"command":"bad"}' },
          { id: 'sib1', name: 'sibling_probe', arguments: '{}' },
        ],
      })
    })
    registry.registerTool({
      name: 'run_command',
      description: 'mock failing command',
      parameters: z.object({ command: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        throw new Error('command exploded')
      },
    } as any)
    registry.registerTool({
      name: 'sibling_probe',
      description: 'observes sibling abort',
      parameters: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async (_args: any, ctx: any) => {
        return await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('finished-normally'), 5000)
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve('cancelled by sibling abort')
          })
        })
      },
    } as any)

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const completes = events.filter((e) => e.type === 'tool_call_complete') as any[]
    const sibling = completes.find((e) => e.result.name === 'sibling_probe')
    expect(sibling).toBeDefined()
    expect(String(sibling.result.output || sibling.result.error)).toContain('cancelled by sibling abort')
  })
})
