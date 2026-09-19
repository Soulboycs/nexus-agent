import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { query } from '../src/agent/core/query'
import { MockLLMProvider, ILLMProvider, LLMMessage, LLMStreamChunk, AgentTool } from '../src/main/agent/providers/LLMProvider'
import { AgentEvent } from '../src/shared/types'
import { z } from 'zod'

/**
 * P1 负向/对抗用例：流式工具执行路径的失败面。
 * 每个用例对应一种真实故障模式：网络中断、审批挂起后用户中止、模型输出
 * 非法参数、幻觉工具名、重复块完成、同步抛错、级联 abort 连带排队工具。
 */

class ScriptedProvider implements ILLMProvider {
  constructor(
    private script: (onChunk: (c: LLMStreamChunk) => void) => void,
    private result?: () => { fullThinking: string; fullContent: string; toolCalls: any[] },
    private error?: () => never
  ) {}
  async chatStream(_m: LLMMessage[], _t: AgentTool[], onChunk: (c: LLMStreamChunk) => void) {
    this.script(onChunk)
    if (this.error) this.error()
    return this.result ? this.result() : { fullThinking: '', fullContent: '', toolCalls: [] }
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

function makeRegistry(extra?: (registry: ToolRegistry) => void) {
  const registry = new ToolRegistry()
  registry.registerTool({
    name: 'probe',
    description: 'probe',
    parameters: z.object({ requiredField: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => 'ok',
  } as any)
  extra?.(registry)
  return registry
}

describe('P1 负向 — 流式执行失败面', () => {
  it('网络在工具已开跑后中断：reason=error，不产生悬挂 tool_use（messages 不含半执行对）', async () => {
    const registry = makeRegistry()
    const provider = new ScriptedProvider(
      (onChunk) => {
        onChunk({ completedToolCalls: [{ id: 'c1', name: 'probe', arguments: '{"requiredField":"x"}' }] })
      },
      undefined,
      () => {
        throw new Error('network died mid-stream')
      }
    )

    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    expect(terminal.reason).toBe('error')
    expect(terminal.error).toContain('network died')
    expect(events.some((e) => e.type === 'error')).toBe(true)
    // 关键：不得把只执行了一半的 assistant/tool 对写回 messages
    const roles = terminal.messages.map((m: any) => m.role)
    expect(roles).toEqual(['user'])
  })

  it('审批永不响应 + 用户 abort：query 不挂死，合成 cancelled 结果，reason=aborted', async () => {
    const registry = makeRegistry((r) =>
      r.registerTool({
        name: 'needs_approval',
        description: 'danger',
        parameters: z.object({ requiredField: z.string() }),
        requiresApproval: () => true,
        execute: async () => 'never',
      } as any)
    )
    const abortController = new AbortController()
    const provider = new ScriptedProvider(
      (onChunk) => {
        onChunk({ completedToolCalls: [{ id: 'c1', name: 'needs_approval', arguments: '{"requiredField":"x"}' }] })
      },
      () => ({
        fullThinking: '',
        fullContent: '',
        // 真实 provider 一定会在最终结果里带回 toolCalls —— assistant 消息
        // 需要它配对，否则 sanitize 会正确地剔除孤儿 tool 消息
        toolCalls: [{ id: 'c1', name: 'needs_approval', arguments: { requiredField: 'x' } }],
      })
    )

    const q = query({
      messages: [{ role: 'user', content: 'go' }],
      toolRegistry: registry,
      provider,
      workspaceRoot: '.',
      signal: abortController.signal,
      onApprovalRequired: () => new Promise<boolean>(() => {}), // 永不响应
    } as any)

    setTimeout(() => abortController.abort(), 60)
    const { events, terminal } = await collect(q)

    expect(terminal.reason).toBe('aborted')
    const approvalEvent = events.find((e) => e.type === 'approval_required')
    expect(approvalEvent).toBeDefined()
    const toolMessages = terminal.messages.filter((m: any) => m.role === 'tool')
    expect(toolMessages.length).toBe(1)
    expect(toolMessages[0].content).toContain('cancelled')
  }, 5000)

  it('模型输出非法 JSON 参数：zod 校验拦截并返回结构化错误（不 crash）', async () => {
    const registry = makeRegistry()
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({ completedToolCalls: [{ id: 'c1', name: 'probe', arguments: '{broken json!!' }] })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete).toBeDefined()
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('Invalid tool arguments')
  })

  it('幻觉工具名（未注册）：返回 not registered 错误，流程继续不 crash', async () => {
    const registry = makeRegistry()
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({ completedToolCalls: [{ id: 'c1', name: 'totally_fake_tool', arguments: '{}' }] })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('No such tool available')
  })

  it('同一块完成事件重复上抛（provider bug）：按 id 去重，仅执行一次', async () => {
    let executed = 0
    const registry = makeRegistry((r) => {
      r.registerTool({
        name: 'counter',
        description: 'counts',
        parameters: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async () => {
          executed++
          return 'counted'
        },
      } as any)
    })
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({ completedToolCalls: [{ id: 'dup', name: 'counter', arguments: '{}' }] })
      onChunk({ completedToolCalls: [{ id: 'dup', name: 'counter', arguments: '{}' }] })
      onChunk({ completedToolCalls: [{ id: 'dup', name: 'counter', arguments: '{}' }] })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    expect(executed).toBe(1)
    expect(events.filter((e) => e.type === 'tool_call_complete').length).toBe(1)
  })

  it('工具同步 throw（非 async）：捕获为错误结果，回合正常收尾', async () => {
    const registry = makeRegistry((r) =>
      r.registerTool({
        name: 'sync_boom',
        description: 'throws synchronously',
        parameters: z.object({}),
        execute: (() => {
          throw new Error('sync explosion')
        }) as any,
      } as any)
    )
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({ completedToolCalls: [{ id: 'c1', name: 'sync_boom', arguments: '{}' }] })
    })

    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('sync explosion')
    expect(terminal.reason).toBe('completed')
  })

  it('级联 abort 连带排队工具：run_command 失败后，未启动的排队工具得到 aborted 错误而非执行', async () => {
    const started: string[] = []
    const registry = makeRegistry((r) => {
      r.registerTool({
        name: 'run_command',
        description: 'fails',
        parameters: z.object({ command: z.string() }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async () => {
          throw new Error('command exploded')
        },
      } as any)
      r.registerTool({
        name: 'sibling_probe',
        description: 'watches signal',
        parameters: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async (_a: any, ctx: any) =>
          await new Promise<string>((resolve) => {
            const t = setTimeout(() => resolve('finished-normally'), 5000)
            ctx.signal?.addEventListener('abort', () => {
              clearTimeout(t)
              resolve('cancelled by sibling abort')
            })
          }),
      } as any)
      r.registerTool({
        name: 'queued_write',
        description: 'non-concurrent, queued behind',
        parameters: z.object({}),
        isConcurrencySafe: () => false,
        execute: async () => {
          started.push('queued_write')
          return 'should not run'
        },
      } as any)
    })
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({
        completedToolCalls: [
          { id: 'cmd', name: 'run_command', arguments: '{"command":"bad"}' },
          { id: 'sib', name: 'sibling_probe', arguments: '{}' },
          { id: 'queued', name: 'queued_write', arguments: '{}' },
        ],
      })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    expect(started).toEqual([]) // 排队工具从未真正执行
    const byName: Record<string, any> = {}
    for (const e of events) {
      if (e.type === 'tool_call_complete') byName[(e as any).result.name] = (e as any).result
    }
    // R4 对齐 cc createSyntheticErrorMessage：queued 兄弟拿到带出错工具描述的合成错误
    expect(String(byName['queued_write'].error)).toContain('Cancelled: parallel tool call run_command(')
    expect(String(byName['queued_write'].error)).toContain('errored')
    expect(String(byName['sibling_probe'].output || byName['sibling_probe'].error)).toContain('cancelled by sibling abort')
  })

  it('排序镜像：[非并发慢, 并发快] 时完成顺序仍为到达顺序', async () => {
    const registry = makeRegistry((r) => {
      r.registerTool({
        name: 'slow_write',
        description: 'non-concurrent slow',
        parameters: z.object({}),
        isConcurrencySafe: () => false,
        execute: async () => {
          await new Promise((res) => setTimeout(res, 80))
          return 'slow'
        },
      } as any)
      r.registerTool({
        name: 'fast_read',
        description: 'concurrent fast',
        parameters: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async () => 'fast',
      } as any)
    })
    const provider = new ScriptedProvider((onChunk) => {
      onChunk({
        completedToolCalls: [
          { id: 'w', name: 'slow_write', arguments: '{}' },
          { id: 'r', name: 'fast_read', arguments: '{}' },
        ],
      })
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider,
        workspaceRoot: '.',
      } as any)
    )

    const order = events.filter((e) => e.type === 'tool_call_complete').map((e: any) => e.result.name)
    expect(order).toEqual(['slow_write', 'fast_read'])
  })
})
