import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createAgentTool } from '../src/main/agent/tools/agentTool'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { viewFileTool } from '../src/main/agent/tools/fileTools'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('AgentTool (Subagent delegation)', () => {
  let tempWorkspace: string
  let registry: ToolRegistry

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-tool-test-'))
    registry = new ToolRegistry()
    registry.registerTool(viewFileTool)
  })

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should execute subagent delegation via tool and return subagent findings', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({
      content: 'Discovered components in src/renderer: App.tsx, Sidebar.tsx'
    })

    const agentTool = createAgentTool({
      workspaceRoot: tempWorkspace,
      provider: mock,
      toolRegistry: registry
    })

    const resultStr = await agentTool.execute(
      {
        subagent_type: 'Explore',
        prompt: 'Survey frontend components'
      },
      { workspaceRoot: tempWorkspace }
    )

    expect(resultStr).toContain('Discovered components')
    expect(resultStr).toContain('App.tsx')
  })
})
