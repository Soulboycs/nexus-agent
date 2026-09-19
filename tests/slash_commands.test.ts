import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createDefaultAgentEngine } from '../src/main/agent'
import { SlashCommandDispatcher } from '../src/main/agent/commands/SlashCommandDispatcher'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('SlashCommandDispatcher', () => {
  let tempWorkspace: string
  let customMemDir: string

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-slash-test-'))
    customMemDir = path.join(tempWorkspace, '.nexus', 'memory')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should handle /clear command by resetting conversation history to initial system prompt', async () => {
    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir
    })

    // Add some turns
    engine.setConversationHistory([
      { role: 'system', content: 'Base system' },
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Answer 1' }
    ])

    const dispatcher = new SlashCommandDispatcher(engine)
    const result = await dispatcher.dispatch('/clear')

    expect(result).not.toBeNull()
    expect(result?.handled).toBe(true)
    expect(result?.output).toContain('Conversation cleared')

    const history = engine.getConversationHistory()
    expect(history.length).toBe(1)
    expect(history[0].role).toBe('system')
  })

  it('should handle /memory command by reporting active persistent memory index and items', async () => {
    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir
    })

    const memManager = engine.getMemoryManager()
    await memManager.saveMemory({
      filename: 'user_profile.md',
      type: 'user',
      name: 'User Background',
      description: 'Senior engineer',
      content: 'Go and TypeScript specialist'
    })

    const dispatcher = new SlashCommandDispatcher(engine)
    const result = await dispatcher.dispatch('/memory')

    expect(result).not.toBeNull()
    expect(result?.handled).toBe(true)
    expect(result?.output).toContain('User Background')
    expect(result?.output).toContain('user_profile.md')
  })

  it('should handle /compact command by forcefully compacting history even below threshold', async () => {
    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir
    })

    engine.setConversationHistory([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Request 1: ' + 'A'.repeat(200) },
      { role: 'assistant', content: 'Response 1: ' + 'B'.repeat(200) },
      { role: 'user', content: 'Request 2: ' + 'C'.repeat(200) },
      { role: 'assistant', content: 'Response 2: ' + 'D'.repeat(200) },
      { role: 'user', content: 'Recent request' },
      { role: 'assistant', content: 'Recent response' }
    ])

    const dispatcher = new SlashCommandDispatcher(engine)
    const result = await dispatcher.dispatch('/compact')

    expect(result).not.toBeNull()
    expect(result?.handled).toBe(true)
    expect(result?.output).toContain('compacted')

    const history = engine.getConversationHistory()
    const hasBoundary = history.some(m => m.content?.includes('[compact_boundary]'))
    expect(hasBoundary).toBe(true)
  })

  it('should return handled: false for non-slash messages', async () => {
    const engine = createDefaultAgentEngine({
      workspaceRoot: tempWorkspace,
      customMemoryDir: customMemDir
    })

    const dispatcher = new SlashCommandDispatcher(engine)
    const result = await dispatcher.dispatch('Regular prompt message')
    expect(result.handled).toBe(false)
  })
})
