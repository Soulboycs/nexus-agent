import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { SubagentEngine } from '../src/main/agent/subagents/SubagentEngine'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { viewFileTool, writeToFileTool } from '../src/main/agent/tools/fileTools'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('SubagentEngine (Explore / Plan / General)', () => {
  let tempWorkspace: string
  let parentRegistry: ToolRegistry

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-subagent-test-'))
    parentRegistry = new ToolRegistry()
    parentRegistry.registerTool(viewFileTool)
    parentRegistry.registerTool(writeToFileTool)
  })

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('Explore subagent should restrict available tools strictly to read-only', () => {
    const subagent = new SubagentEngine({
      subagentType: 'Explore',
      workspaceRoot: tempWorkspace,
      provider: new MockLLMProvider(),
      parentToolRegistry: parentRegistry
    })

    const tools = subagent.getToolRegistry()
    expect(tools.getTool('view_file')).toBeDefined()
    // write_to_file must NOT be registered in Explore subagent
    expect(tools.getTool('write_to_file')).toBeUndefined()
  })

  it('Explore subagent should run isolated subagent loop and return concise summary', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({
      content: 'Exploration complete: found 3 relevant files in src/.'
    })

    const subagent = new SubagentEngine({
      subagentType: 'Explore',
      workspaceRoot: tempWorkspace,
      provider: mock,
      parentToolRegistry: parentRegistry
    })

    const result = await subagent.run('Find all API endpoints')
    expect(result.reason).toBe('completed')
    expect(result.summary).toContain('found 3 relevant files')

    // Subagent history is completely isolated
    expect(subagent.getConversationHistory().length).toBeGreaterThan(0)
  })

  it('Plan subagent should enforce planning guidelines in system prompt', () => {
    const subagent = new SubagentEngine({
      subagentType: 'Plan',
      workspaceRoot: tempWorkspace,
      provider: new MockLLMProvider(),
      parentToolRegistry: parentRegistry
    })

    const prompt = subagent.getSystemPrompt()
    expect(prompt).toContain('Plan')
    expect(prompt).toContain('Implementation Plan')
  })
})
