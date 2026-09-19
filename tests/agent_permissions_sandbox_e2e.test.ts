import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createDefaultAgentEngine } from '../src/main/agent'
import { ILLMProvider, LLMMessage, LLMStreamChunk } from '../src/main/agent/providers/LLMProvider'
import { AgentTool } from '../src/main/agent/tools/ToolRegistry'
import type { AgentEvent } from '../src/shared/types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

class ScriptedToolLLMProvider implements ILLMProvider {
  public scriptedResponses: Array<{
    thinking?: string
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
  }> = []
  private callIdx = 0

  async chatStream(
    _messages: LLMMessage[],
    _tools: AgentTool[],
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<{ fullThinking: string; fullContent: string; toolCalls: any[] }> {
    const resp = this.scriptedResponses[this.callIdx++] || { content: 'Default response' }
    if (resp.thinking) onChunk({ thinking: resp.thinking })
    if (resp.content) onChunk({ content: resp.content })
    if (resp.toolCalls) {
      for (const tc of resp.toolCalls) {
        onChunk({
          toolCalls: [
            {
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments
            }
          ]
        })
      }
    }
    return {
      fullThinking: resp.thinking || '',
      fullContent: resp.content || '',
      toolCalls: resp.toolCalls || []
    }
  }
}

describe('AgentEngine Permissions & Sandbox E2E Integration', () => {
  let tempWorkspace: string

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-perm-e2e-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should immediately deny execution when tool matches a deny permission rule', async () => {
    const provider = new ScriptedToolLLMProvider()
    // Turn 1: LLM tries to write to .env.secret
    provider.scriptedResponses = [
      {
        content: 'Writing config...',
        toolCalls: [
          {
            id: 'call_deny_1',
            name: 'write_to_file',
            arguments: JSON.stringify({ TargetFile: path.join(tempWorkspace, '.env.secret'), CodeContent: 'SECRET=123' })
          }
        ]
      },
      // Turn 2: LLM acknowledges denial
      {
        content: 'I noticed the write was denied by policy.'
      }
    ]

    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customProvider: provider,
      permissionRules: [
        {
          ruleStr: 'write_to_file(*.secret)',
          behavior: 'deny',
          source: 'projectSettings'
        }
      ]
    })

    const terminal = await engine.run('Save the secret')
    expect(terminal.reason).toBe('completed')

    // Verify tool result contains denial reason
    const history = engine.getConversationHistory()
    const toolResult = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call_deny_1')
    expect(toolResult).toBeDefined()
    expect(toolResult?.content).toContain('denied by policy')

    // Verify file was NOT created on disk
    expect(fs.existsSync(path.join(tempWorkspace, '.env.secret'))).toBe(false)
  })

  it('should block file modifications outside workspace using SandboxGuard', async () => {
    const provider = new ScriptedToolLLMProvider()
    // LLM tries to escape workspace
    provider.scriptedResponses = [
      {
        content: 'Modifying outside file...',
        toolCalls: [
          {
            id: 'call_escape_1',
            name: 'write_to_file',
            arguments: JSON.stringify({ TargetFile: 'c:/windows/system32/test.dll', CodeContent: 'danger' })
          }
        ]
      },
      {
        content: 'Understood, file outside sandbox cannot be modified.'
      }
    ]

    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customProvider: provider,
      permissionMode: 'bypass' // Even with bypass permissions, SandboxGuard must strictly block!
    })

    const terminal = await engine.run('Escape sandbox')
    expect(terminal.reason).toBe('completed')

    const history = engine.getConversationHistory()
    const toolResult = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call_escape_1')
    expect(toolResult).toBeDefined()
    expect(toolResult?.content).toContain('blocked by sandbox guard')
    expect(toolResult?.content).toContain('PATH_OUTSIDE_WORKSPACE')
  })

  it('should block destructive shell commands using SandboxGuard', async () => {
    const provider = new ScriptedToolLLMProvider()
    provider.scriptedResponses = [
      {
        content: 'Cleaning up...',
        toolCalls: [
          {
            id: 'call_rm_1',
            name: 'run_command',
            arguments: JSON.stringify({ CommandLine: 'rm -rf /' })
          }
        ]
      },
      {
        content: 'Dangerous command was rejected.'
      }
    ]

    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customProvider: provider,
      permissionMode: 'bypass'
    })

    const terminal = await engine.run('Wipe drive')
    expect(terminal.reason).toBe('completed')

    const history = engine.getConversationHistory()
    const toolResult = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call_rm_1')
    expect(toolResult).toBeDefined()
    expect(toolResult?.content).toContain('blocked by sandbox guard')
    expect(toolResult?.content).toContain('DANGEROUS_COMMAND')
  })

  it('should bypass approval when an allow rule matches in default mode', async () => {
    let approvalRequested = false
    const provider = new ScriptedToolLLMProvider()
    provider.scriptedResponses = [
      {
        content: 'Checking git status...',
        toolCalls: [
          {
            id: 'call_git_1',
            name: 'run_command',
            arguments: JSON.stringify({ CommandLine: 'git status' })
          }
        ]
      },
      {
        content: 'Git status completed.'
      }
    ]

    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customProvider: provider,
      permissionMode: 'ask',
      permissionRules: [
        {
          ruleStr: 'run_command(git *)',
          behavior: 'allow',
          source: 'projectSettings'
        }
      ]
    })

    engine.on('event', (evt: AgentEvent) => {
      if (evt.type === 'approval_required') {
        approvalRequested = true
      }
    })

    const terminal = await engine.run('Check git status')
    expect(terminal.reason).toBe('completed')
    // Verification: approval was NOT requested because rule granted allow
    expect(approvalRequested).toBe(false)
  })
})
