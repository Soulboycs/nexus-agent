import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AgentEngine } from '../src/main/agent/core/AgentEngine'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import type { AgentEvent } from '../src/shared/types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('AgentEngine Memory Architecture E2E', () => {
  let tempWorkspace: string
  let customMemDir: string

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-e2e-ws-'))
    customMemDir = path.join(tempWorkspace, '.nexus', 'memory')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should discover NEXUS.md and inject into system prompt on run', async () => {
    fs.writeFileSync(
      path.join(tempWorkspace, 'NEXUS.md'),
      '# Team Guideline\n- Always use bun test\n- Never skip linting',
      'utf-8'
    )

    const engine = new AgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir,
      customProvider: new MockLLMProvider()
    })

    const terminal = await engine.run('Hello agent!')
    expect(terminal.reason).toBe('completed')

    const history = engine.getConversationHistory()
    const systemMsg = history.find((m) => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg?.content).toContain('# Project Instructions (from NEXUS.md)')
    expect(systemMsg?.content).toContain('Always use bun test')
    expect(systemMsg?.content).toContain('# Auto Memory')
  })

  it('should trigger silent memory extraction and persist memory item upon turn completion', async () => {
    const emittedEvents: AgentEvent[] = []
    const engine = new AgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir,
      customProvider: new MockLLMProvider()
    })

    engine.on('event', (evt: AgentEvent) => {
      emittedEvents.push(evt)
    })

    const userPrompt = 'Remember: never touch package-lock.json directly, always use bun install'
    const terminal = await engine.run(userPrompt)
    expect(terminal.reason).toBe('completed')

    // Wait a brief moment for async extraction
    await new Promise((r) => setTimeout(r, 100))

    const memoryUpdatedEvt = emittedEvents.find((e) => e.type === 'memory_updated')
    expect(memoryUpdatedEvt).toBeDefined()

    // Verify file on disk
    const memManager = engine.getMemoryManager()
    const items = await memManager.listMemories()
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].type).toBe('feedback')
    expect(items[0].content).toContain('bun install')

    // Run another turn and check that the saved memory is now in the system prompt
    await engine.run('How should I install packages?')
    const history = engine.getConversationHistory()
    const systemMsg = history.find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain(items[0].name)
  })

  it('should compact conversation history when message tokens exceed threshold', async () => {
    const emittedEvents: AgentEvent[] = []
    const engine = new AgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir,
      customProvider: new MockLLMProvider()
    })

    // Set a very low compaction threshold for test
    const compactor = engine.getCompactor() as any
    compactor.thresholdTokens = 150
    compactor.preserveRecentRounds = 1

    engine.on('event', (evt: AgentEvent) => {
      emittedEvents.push(evt)
    })

    // Seed historical messages
    const initial = [
      { role: 'user' as const, content: 'Long request 1: ' + 'X'.repeat(300) },
      { role: 'assistant' as const, content: 'Long response 1: ' + 'Y'.repeat(300) }
    ]

    await engine.run('What is next?', { initialMessages: initial })

    const compactedEvt = emittedEvents.find((e) => e.type === 'compacted')
    expect(compactedEvt).toBeDefined()

    const history = engine.getConversationHistory()
    const hasBoundary = history.some((m) => m.content.includes('[compact_boundary]'))
    expect(hasBoundary).toBe(true)
  })
})
