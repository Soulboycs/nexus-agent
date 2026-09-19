import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { query } from '../src/agent/core/query'
import { MockLLMProvider, ILLMProvider, LLMMessage, LLMStreamChunk, AgentTool } from '../src/main/agent/providers/LLMProvider'
import { AgentEngine } from '../src/main/agent/core/AgentEngine'
import { SubagentEngine } from '../src/main/agent/subagents/SubagentEngine'
import { PermissionEngine } from '../src/main/agent/permissions/PermissionEngine'
import { SandboxGuard } from '../src/main/agent/sandbox/SandboxGuard'
import { listDirectoryTool } from '../src/main/agent/tools/fileTools'
import { docxApplyOpsTool, docxModifyBlockTool } from '../src/main/agent/tools/docxTools'
import { AgentEvent, ApprovalRequest } from '../src/shared/types'
import { z } from 'zod'

/**
 * 审查修复回归（2026-09-20 独立审查发现的缺口）：
 * 1. HITL fail-closed：无审批回调时 requiresApproval 工具必须拒绝而非静默执行
 * 2. 子代理门禁穿透：General 子代理继承父级门禁；无回调自动拒绝
 * 3. list_directory dirPath 沙箱逃逸（回归：gate 漏读 dirPath）
 * 4. userModified 注记各侧恰好一次（回归：曾重复两次）
 * 5. .env/credentials 内置敏感写入规则
 * 6. docx 试点 checkPermissions 离线分支
 * 7. run_command requiresApproval 恢复 + setPermissionMode 归一化
 */

class ToolUseProvider implements ILLMProvider {
  constructor(
    private calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    private done = 'subagent finished'
  ) {}
  async chatStream(_m: LLMMessage[], _t: AgentTool[], _onChunk: (c: LLMStreamChunk) => void) {
    return {
      fullThinking: '',
      fullContent: this.calls.length === 0 ? this.done : '',
      toolCalls: this.calls.splice(0, this.calls.length),
    }
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

describe('审查修复 — HITL fail-closed 与子代理门禁', () => {
  it('query 无审批回调：requiresApproval 工具被 fail-closed 拒绝，永不执行（回归：曾静默执行）', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.registerTool({
      name: 'sensitive_op',
      description: 'needs user',
      parameters: z.object({}),
      requiresApproval: () => true,
      execute: async () => {
        executed++
        return 'should not run'
      },
    } as any)
    const mock = new MockLLMProvider()
    mock.queueResponse({ toolCalls: [{ id: 'c1', name: 'sensitive_op', arguments: {} }] })

    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: '.',
        // 注意：故意不传 onApprovalRequired
      } as any)
    )

    expect(executed).toBe(0)
    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('fail-closed')
    expect(terminal.reason).toBe('completed')
  })

  it('General 子代理（无回调）：危险工具自动拒绝（回归：曾以 bypass 静默执行）', async () => {
    const parentRegistry = new ToolRegistry()
    let executed = 0
    parentRegistry.registerTool({
      name: 'danger_cmd',
      description: 'dangerous',
      parameters: z.object({}),
      requiresApproval: () => true,
      execute: async () => {
        executed++
        return 'MUTATED WITHOUT ASK'
      },
    } as any)

    const provider = new ToolUseProvider([{ id: 's1', name: 'danger_cmd', arguments: {} }])
    const subagent = new SubagentEngine({
      subagentType: 'General',
      workspaceRoot: '.',
      provider,
      parentToolRegistry: parentRegistry,
      maxTurns: 3,
      // 不传 onApprovalRequired / permissionEngine —— 最坏情况
    })

    const result = await subagent.run('do the dangerous thing')
    expect(executed).toBe(0)
    // 子代理得到结构化拒绝，最终仍能收尾汇报
    expect(result.reason).toBe('completed')
    expect(result.summary).toContain('subagent finished')
  })

  it('General 子代理（继承父级回调）：批准则执行，拒绝则不执行', async () => {
    let executed = 0
    let approvalCount = 0
    const parentRegistry = new ToolRegistry()
    parentRegistry.registerTool({
      name: 'danger_cmd',
      description: 'dangerous',
      parameters: z.object({}),
      requiresApproval: () => true,
      execute: async () => {
        executed++
        return 'ran-with-approval'
      },
    } as any)

    // 第一次运行：批准
    const p1 = new ToolUseProvider([{ id: 's1', name: 'danger_cmd', arguments: {} }])
    const sub1 = new SubagentEngine({
      subagentType: 'General',
      workspaceRoot: '.',
      provider: p1,
      parentToolRegistry: parentRegistry,
      maxTurns: 3,
      onApprovalRequired: async () => {
        approvalCount++
        return true
      },
    })
    await sub1.run('go')
    expect(approvalCount).toBe(1)
    expect(executed).toBe(1)

    // 第二次运行：拒绝
    const p2 = new ToolUseProvider([{ id: 's2', name: 'danger_cmd', arguments: {} }])
    const sub2 = new SubagentEngine({
      subagentType: 'General',
      workspaceRoot: '.',
      provider: p2,
      parentToolRegistry: parentRegistry,
      maxTurns: 3,
      onApprovalRequired: async () => false,
    })
    await sub2.run('go')
    expect(executed).toBe(1) // 仍是第一次的计数
  })

  it('Explore 子代理只读工具在 ask 模式下不受影响（无回调也正常执行）', async () => {
    const parentRegistry = new ToolRegistry()
    parentRegistry.registerTool({
      name: 'view_file',
      description: 'read',
      parameters: z.object({}),
      isReadOnly: () => true,
      execute: async () => 'file content',
    } as any)

    const provider = new ToolUseProvider([{ id: 's1', name: 'view_file', arguments: {} }])
    const subagent = new SubagentEngine({
      subagentType: 'Explore',
      workspaceRoot: '.',
      provider,
      parentToolRegistry: parentRegistry,
      maxTurns: 3,
    })
    const result = await subagent.run('explore')
    expect(result.summary).toContain('subagent finished')
  })
})

describe('审查修复 — 沙箱与敏感文件', () => {
  it('list_directory 的 dirPath 现在进沙箱链：工作区外目录被拦截（回归：曾可越狱枚举）', async () => {
    const registry = new ToolRegistry()
    registry.registerTool(listDirectoryTool)
    const mock = new MockLLMProvider()
    mock.queueResponse({
      toolCalls: [{ id: 'c1', name: 'list_directory', arguments: { dirPath: 'C:/__nexus_escape_probe_dir' } }],
    })

    const { events } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: 'C:/Temp/nexus-review-fix-ws',
        sandboxGuard: new SandboxGuard({ workspaceRoot: 'C:/Temp/nexus-review-fix-ws' }),
      } as any)
    )

    const complete = events.find((e) => e.type === 'tool_call_complete') as any
    expect(complete.result.isError).toBe(true)
    expect(String(complete.result.error)).toContain('sandbox')
  })

  it('PermissionEngine 内置敏感写入规则：.env 写入 ask、读取不受影响、bypass 跳过', () => {
    const engine = new PermissionEngine({ rules: [] })
    const writeEnv = engine.evaluate('write_to_file', { filePath: 'C:/ws/.env.local' }, 'ask')
    expect(writeEnv.behavior).toBe('ask')
    expect(writeEnv.requiresApproval).toBe(true)

    const writeCreds = engine.evaluate('write_to_file', { filePath: 'config/credentials.json' }, 'ask')
    expect(writeCreds.behavior).toBe('ask')

    // 读取合法：敏感规则只拦写入
    expect(engine.evaluate('view_file', { filePath: '.env' }, 'ask').behavior).toBe('allow')

    // bypass 契约：零提示
    expect(engine.evaluate('write_to_file', { filePath: '.env' }, 'bypass').behavior).toBe('allow')

    // 非敏感写入不受牵连
    expect(engine.evaluate('write_to_file', { filePath: 'src/app.ts' }, 'ask').behavior).toBe('allow')
  })

  it('run_command requiresApproval 已恢复为 true（无引擎路径的最后防线）', () => {
    const { runCommandTool } = require('../src/main/agent/tools/commandTool')
    expect(runCommandTool.requiresApproval!({})).toBe(true)
  })
})

describe('审查修复 — docx 试点离线分支与引擎加固', () => {
  it('docx_apply_ops 离线 deny；docx_modify_block 离线 allow（在线分支依赖画布）', async () => {
    const apply = await docxApplyOpsTool.checkPermissions!({} as any, {
      workspaceRoot: '.',
    } as any)
    expect(apply.behavior).toBe('deny')

    const modify = await docxModifyBlockTool.checkPermissions!({ trackChanges: false } as any, {
      workspaceRoot: '.',
    } as any)
    expect(modify.behavior).toBe('allow') // 离线直改磁盘，无需审批
  })

  it('AgentEngine.setPermissionMode 归一化旧值（纵深防御）', () => {
    const engine = new AgentEngine({ workspaceRoot: 'C:/Temp/nexus-review-fix', customProvider: new MockLLMProvider() })
    engine.setPermissionMode('bypassPermissions' as any)
    expect(engine.getPermissionMode()).toBe('bypass')
    engine.setPermissionMode('garbage' as any)
    expect(engine.getPermissionMode()).toBe('ask') // fail-closed
  })
})
