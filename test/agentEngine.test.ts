import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { AgentEngine } from '../src/main/agent/core/AgentEngine'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { writeToFileTool } from '../src/main/agent/tools/fileTools'
import { AgentEvent } from '@shared/types'

describe('AgentEngine - ReAct Loop & HITL Authorization Tests', () => {
  let tempDir: string
  let mockProvider: MockLLMProvider
  let engine: AgentEngine

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-engine-test-'))
    mockProvider = new MockLLMProvider()
    engine = new AgentEngine({
      workspaceRoot: tempDir,
      customProvider: mockProvider,
      permissionMode: 'bypass'
    })
    engine.getToolRegistry().registerTool(writeToFileTool)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('executes a full tool-call cycle and finishes in completed state', async () => {
    const events: AgentEvent[] = []
    engine.on('event', (ev: AgentEvent) => events.push(ev))

    // First LLM response: call write_to_file tool
    mockProvider.queueResponse({
      thinking: 'I need to write greeting.txt',
      toolCalls: [
        {
          id: 'call_1',
          name: 'write_to_file',
          arguments: {
            filePath: 'greeting.txt',
            content: 'Hello Vitest!',
            overwrite: true
          }
        }
      ]
    })

    // Second LLM response: conclude task
    mockProvider.queueResponse({
      thinking: 'File created. Replying to user.',
      content: 'I have created greeting.txt for you!'
    })

    await engine.run('Create a greeting.txt file')

    expect(engine.getStatus()).toBe('completed')

    // Verify file actually created on disk (evidence)
    const fileContent = await fs.readFile(path.join(tempDir, 'greeting.txt'), 'utf-8')
    expect(fileContent).toBe('Hello Vitest!')

    // Verify event sequence
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('status_change')
    expect(eventTypes).toContain('thinking_delta')
    expect(eventTypes).toContain('tool_call_start')
    expect(eventTypes).toContain('tool_call_complete')
    expect(eventTypes).toContain('message_delta')
  })

  it('triggers approval request for dangerous actions and handles user approval', async () => {
    engine.setPermissionMode('ask')
    // Custom tool that requires approval
    engine.getToolRegistry().registerTool({
      name: 'dangerous_action',
      description: 'A dangerous operation',
      parameters: writeToFileTool.parameters,
      requiresApproval: () => true,
      execute: async () => 'Danger handled safely'
    })

    mockProvider.queueResponse({
      toolCalls: [
        {
          id: 'call_danger',
          name: 'dangerous_action',
          arguments: { filePath: 'foo', content: 'bar', overwrite: true }
        }
      ]
    })

    mockProvider.queueResponse({
      content: 'Finished after approval.'
    })

    let receivedRequestId = ''
    engine.on('event', (ev: AgentEvent) => {
      if (ev.type === 'approval_required') {
        receivedRequestId = ev.request.id
        // Auto-approve after a microtask
        setTimeout(() => {
          engine.respondApproval(receivedRequestId, true)
        }, 10)
      }
    })

    await engine.run('Perform dangerous action')

    expect(receivedRequestId).not.toBe('')
    expect(engine.getStatus()).toBe('completed')
  })

  it('handles user rejection cleanly and informs model', async () => {
    engine.setPermissionMode('ask')
    engine.getToolRegistry().registerTool({
      name: 'restricted_action',
      description: 'Restricted action',
      parameters: writeToFileTool.parameters,
      requiresApproval: () => true,
      execute: async () => 'Should not run'
    })

    mockProvider.queueResponse({
      toolCalls: [
        {
          id: 'call_restricted',
          name: 'restricted_action',
          arguments: { filePath: 'foo', content: 'bar', overwrite: true }
        }
      ]
    })

    mockProvider.queueResponse({
      content: 'User rejected the action, so I stopped.'
    })

    engine.on('event', (ev: AgentEvent) => {
      if (ev.type === 'approval_required') {
        setTimeout(() => {
          engine.respondApproval(ev.request.id, false, 'Security concern')
        }, 10)
      }
    })

    await engine.run('Perform restricted action')

    expect(engine.getStatus()).toBe('completed')
  })
})
