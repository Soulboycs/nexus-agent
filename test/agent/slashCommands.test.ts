import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { AgentEngine } from '../../src/main/agent/core/AgentEngine'
import { SlashCommandDispatcher } from '../../src/main/agent/commands/SlashCommandDispatcher'

describe('SlashCommandDispatcher - Zero-Token Instant Handlers & /undo', () => {
  let tempDir: string
  let engine: AgentEngine
  let dispatcher: SlashCommandDispatcher

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-slash-test-'))
    engine = new AgentEngine({
      workspaceRoot: tempDir
    })
    dispatcher = new SlashCommandDispatcher(engine)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('handles /clear by wiping conversation history', async () => {
    engine.setConversationHistory([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ])

    const res = await dispatcher.dispatch('/clear')
    expect(res.handled).toBe(true)
    expect(res.output).toContain('Conversation cleared')
    // Conversation history now contains only initial system prompt
    const history = engine.getConversationHistory()
    expect(history.filter((m) => m.role !== 'system')).toHaveLength(0)
  })

  it('handles /help by displaying available slash commands including /undo', async () => {
    const res = await dispatcher.dispatch('/help')
    expect(res.handled).toBe(true)
    expect(res.output).toContain('/clear')
    expect(res.output).toContain('/memory')
    expect(res.output).toContain('/compact')
    expect(res.output).toContain('/undo')
  })

  it('handles /undo by reverting file modifications made by tools', async () => {
    const testFile = path.join(tempDir, 'demo.txt')
    await fs.writeFile(testFile, 'Original Text\n', 'utf-8')

    // Track edit
    const tracker = engine.getFileHistoryTracker()
    await tracker.trackEdit(testFile, tempDir)

    // Overwrite file
    await fs.writeFile(testFile, 'Modified Text\n', 'utf-8')
    tracker.createSnapshot('test_turn')

    expect(await fs.readFile(testFile, 'utf-8')).toBe('Modified Text\n')

    // Invoke /undo
    const res = await dispatcher.dispatch('/undo')
    expect(res.handled).toBe(true)
    expect(res.output).toContain('Successfully reverted')
    expect(await fs.readFile(testFile, 'utf-8')).toBe('Original Text\n')
  })

  it('handles /undo gracefully when no modifications exist', async () => {
    const res = await dispatcher.dispatch('/undo')
    expect(res.handled).toBe(true)
    expect(res.output).toContain('No file modifications')
  })

  it('ignores regular user prompts without slash prefix', async () => {
    const res = await dispatcher.dispatch('Can you please write a function?')
    expect(res.handled).toBe(false)
  })
})
