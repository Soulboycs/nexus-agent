import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { query } from '../src/agent/core/query'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { AgentEvent } from '../src/shared/types'
import { z } from 'zod'

/**
 * P2b 负向 — 工具级 checkPermissions 与审批改参（updatedInput/userModified）。
 */

async function collect(q: AsyncGenerator<AgentEvent, any>) {
  const events: AgentEvent[] = []
  while (true) {
    const next = await q.next()
    if (next.done) return { events, terminal: next.value }
    events.push(next.value)
  }
}

describe('P2b — checkPermissions 门禁', () => {
  it('deny：携带工具自身 message 的结构化错误，工具永不执行', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.registerTool({
      name: 'live_only_tool',
      description: 'requires canvas',
      parameters: z.object({}),
      checkPermissions: async () => ({
        behavior: 'deny',
        message: 'Live Word Canvas not mounted. Open the drawer first.',
      }),
      execute: async () => {
        executed++
        return 'never'
      },
    } as any)

    const mock = new MockLLMProvider()
    mock.queueResponse({ toolCalls: [{ id: 'c1', name: 'live_only_tool', arguments: {} }] })
    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
      } as any)
    )

    expect(executed).toBe(0)
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('Live Word Canvas not mounted')
    // 拒绝原因回流模型，下一轮可自救
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool')
    expect(String(toolMsg.content)).toContain('permission policy')
    expect(terminal.reason).toBe('completed')
  })

  it('ask：即使无权限引擎也会强制触发 HITL 审批（负向：拒绝后不执行）', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.registerTool({
      name: 'untracked_mutation',
      description: 'asks on live canvas',
      parameters: z.object({}),
      checkPermissions: async () => ({ behavior: 'ask', message: 'no revision history' }),
      execute: async () => {
        executed++
        return 'mutated'
      },
    } as any)

    const mock = new MockLLMProvider()
    mock.queueResponse({ toolCalls: [{ id: 'c1', name: 'untracked_mutation', arguments: {} }] })
    mock.queueResponse({ content: 'user said no' })

    let approvalSeen = false
    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
        onApprovalRequired: async () => {
          approvalSeen = true
          return false // 用户拒绝
        },
      } as any)
    )

    expect(approvalSeen).toBe(true)
    expect(events.some((e) => e.type === 'approval_required')).toBe(true)
    expect(executed).toBe(0)
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(String(complete.result.error)).toContain('cancelled by user')
    expect(terminal.reason).toBe('completed')
  })
})

describe('P2b — 审批改参 updatedInput / userModified', () => {
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    const seen: { args: any; ctxUserModified: boolean | undefined }[] = []
    registry.registerTool({
      name: 'echo_args',
      description: 'echoes args',
      parameters: z.object({ text: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      requiresApproval: () => true,
      execute: async (args: any, ctx: any) => {
        seen.push({ args, ctxUserModified: ctx?.userModified })
        return `echo:${args.text}`
      },
    } as any)
    return { registry, seen }
  }

  it('批准并携带 updatedInput → 以修改后参数执行 + 注记回流模型', async () => {
    const { registry, seen } = makeRegistry()
    const mock = new MockLLMProvider()
    mock.queueResponse({ toolCalls: [{ id: 'c1', name: 'echo_args', arguments: { text: 'original' } }] })
    mock.queueResponse({ content: 'done' })

    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
        onApprovalRequired: async () => ({
          approved: true,
          updatedInput: { text: 'edited-by-user' },
        }),
      } as any)
    )

    expect(seen).toHaveLength(1)
    expect(seen[0].args.text).toBe('edited-by-user')
    expect(seen[0].ctxUserModified).toBe(true)
    const note = '[Note: user modified the tool input during approval]'
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool')
    expect(String(toolMsg.content)).toContain('echo:edited-by-user')
    // 审查修复回归：注记在模型侧必须恰好出现一次（曾重复两次）
    expect(String(toolMsg.content).split(note).length - 1).toBe(1)
    // 事件侧（UI）也恰好一次
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(String(complete.result.output).split(note).length - 1).toBe(1)
  })

  it('普通批准（无 updatedInput）→ 原参数执行，无注记（负向：不误标）', async () => {
    const { registry, seen } = makeRegistry()
    const mock = new MockLLMProvider()
    mock.queueResponse({ toolCalls: [{ id: 'c1', name: 'echo_args', arguments: { text: 'original' } }] })
    mock.queueResponse({ content: 'done' })

    const { terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
        onApprovalRequired: async () => true,
      } as any)
    )

    expect(seen[0].args.text).toBe('original')
    expect(seen[0].ctxUserModified).toBeUndefined()
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool')
    expect(String(toolMsg.content)).not.toContain('user modified')
  })

  it('负向：用户改参后沙箱复检拦截（纵深防御，改参不能越狱）', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.registerTool({
      name: 'run_command',
      description: 'cmd',
      parameters: z.object({ command: z.string() }),
      requiresApproval: () => true,
      execute: async () => {
        executed++
        return 'ran'
      },
    } as any)

    const mock = new MockLLMProvider()
    mock.queueResponse({
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'echo ok' } }],
    })
    mock.queueResponse({ content: 'done' })

    // 用户在审批时把命令改成 fork 炸弹 —— 必须被沙箱复检拦截
    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
        sandboxGuard: {
          validateCommand: (cmd: string) =>
            cmd.includes(':(){')
              ? { passed: false, reason: 'fork bomb', violation: 'dangerous_pattern' }
              : { passed: true },
          validateFileTarget: () => ({ passed: true }),
        } as any,
        onApprovalRequired: async () => ({
          approved: true,
          updatedInput: { command: ':(){ :|:& };:' },
        }),
      } as any)
    )

    expect(executed).toBe(0)
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('User-edited input blocked by sandbox guard')
  })
})
