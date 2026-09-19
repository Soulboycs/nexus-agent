import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { createDefaultAgentEngine } from '../src/main/agent'

/**
 * P1 端到端负向用例（AgentEngine × 真实默认工具集 × 真实沙箱/权限引擎）：
 * 幻觉工具名、沙箱路径逃逸拦截、审批挂起后用户中止。
 */

async function waitFor(cond: () => boolean, timeoutMs = 4000, interval = 10) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, interval))
  }
}

describe('AgentEngine E2E 负向', () => {
  it('幻觉工具名：结构化 not-registered 错误回给模型，引擎仍正常完成回合', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({
      toolCalls: [{ id: 'call_ghost', name: 'no_such_tool', arguments: { whatever: 1 } }],
    })
    mock.queueResponse({ content: 'Recovered after ghost tool' })

    const engine = createDefaultAgentEngine({ workspaceRoot: 'C:/Temp/nexus-e2e-neg', customProvider: mock })
    const events: any[] = []
    engine.on('event', (e: any) => events.push(e))

    const terminal = await engine.run('Call a fake tool')

    expect(terminal.reason).toBe('completed')
    const ghostComplete = events.find((e) => e.type === 'tool_call_complete' && e.result?.name === 'no_such_tool')
    expect(ghostComplete).toBeDefined()
    expect(ghostComplete.result.isError).toBe(true)
    expect(String(ghostComplete.result.error)).toContain('No such tool available')
    // 拒绝结果必须回流到对话历史，模型下一轮才能看到
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_ghost')
    expect(toolMsg).toBeDefined()
  })

  it('沙箱路径逃逸：write_to_file 指向工作区外绝对路径被真实 SandboxGuard 拦截（回归：gate 曾漏读 filePath 字段）', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({
      toolCalls: [
        {
          id: 'call_escape',
          name: 'write_to_file',
          arguments: { filePath: 'C:/__nexus_escape_probe.txt', content: 'should never be written' },
        },
      ],
    })
    mock.queueResponse({ content: 'Sandbox blocked the write' })

    const engine = createDefaultAgentEngine({ workspaceRoot: 'C:/Temp/nexus-e2e-neg2', customProvider: mock })
    const events: any[] = []
    engine.on('event', (e: any) => events.push(e))

    const terminal = await engine.run('Write outside the workspace')

    expect(terminal.reason).toBe('completed')
    const escapeComplete = events.find((e) => e.type === 'tool_call_complete' && e.result?.name === 'write_to_file')
    expect(escapeComplete).toBeDefined()
    expect(escapeComplete.result.isError).toBe(true)
    expect(String(escapeComplete.result.error)).toContain('sandbox')
    // 模型收到的是可理解的拦截原因，而非裸异常
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_escape')
    expect(String(toolMsg?.content || '')).toContain('sandbox')
  })

  it('审批挂起时用户 abort：run 以 aborted 收尾、pending 审批被清理、状态回 idle', async () => {
    const mock = new MockLLMProvider()
    // ask 模式（继承 acceptEdits 语义）下 write_to_file 属 EDIT 类自动放行；
    // run_command 才是 ask 的典型对象 —— 且 gate 先挂起审批，命令不会真正执行
    mock.queueResponse({
      toolCalls: [
        {
          id: 'call_cmd',
          name: 'run_command',
          arguments: { command: 'echo approval-probe' },
        },
      ],
    })
    mock.queueResponse({ content: 'never reached before abort' })

    const engine = createDefaultAgentEngine({ workspaceRoot: 'C:/Temp/nexus-e2e-neg3', customProvider: mock })
    const events: any[] = []
    engine.on('event', (e: any) => events.push(e))

    const runPromise = engine.run('Write a file that needs approval')

    await waitFor(() => engine.getStatus() === 'awaiting_confirmation')
    expect(events.some((e) => e.type === 'approval_required')).toBe(true)

    engine.abort()
    const terminal = await runPromise

    expect(terminal.reason).toBe('aborted')
    expect(engine.getStatus()).toBe('idle')
    // 中止后的对话状态干净：可立即启动新 run 而不被旧审批污染
    mock.queueResponse({ content: 'Fresh turn after abort' })
    const terminal2 = await engine.run('Fresh start')
    expect(terminal2.reason).toBe('completed')
  })
})

describe('AgentEngine E2E — 审批改参（P2b updatedInput）', () => {
  it('用户在审批时修改命令参数 → 实际执行修改后的命令且回流注记', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({
      toolCalls: [{ id: 'call_edit', name: 'ask_echo', arguments: { payload: 'original-args' } }],
    })
    mock.queueResponse({ content: 'Command executed' })

    const engine = createDefaultAgentEngine({
      workspaceRoot: 'C:/Temp/nexus-e2e-approval-edit',
      customProvider: mock,
      permissionMode: 'ask',
    })
    // 注入一个 ask 模式下必须审批的自定义工具（避免依赖外部进程）
    engine.getToolRegistry().registerTool({
      name: 'ask_echo',
      description: 'echoes its payload, asks for approval',
      parameters: z.object({ payload: z.string() }),
      requiresApproval: () => true,
      execute: async (args: any) => 'executed:' + args.payload,
    } as any)

    // 模拟审批 UI：收到 approval_required 后以修改过的参数批准
    const approvalHandler = (e: any) => {
      if (e.type === 'approval_required') {
        engine.respondApproval(e.request.id, true, undefined, { payload: 'edited-by-user' })
      }
    }
    engine.on('event', approvalHandler)

    const terminal = await engine.run('Run a command')
    engine.removeListener('event', approvalHandler)

    expect(terminal.reason).toBe('completed')
    const toolMsg = terminal.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_edit')
    expect(toolMsg).toBeDefined()
    // 真实执行的是用户改后的参数
    expect(String(toolMsg.content)).toContain('executed:edited-by-user')
    expect(String(toolMsg.content)).toContain('[Note: user modified the tool input during approval]')
    expect(String(toolMsg.content)).not.toContain('original-args')
  })
})
