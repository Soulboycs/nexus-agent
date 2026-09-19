import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryManager } from '../src/main/agent/memory/MemoryManager'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('MemoryManager', () => {
  let tempDir: string
  let manager: MemoryManager

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-memory-test-'))
    manager = new MemoryManager({
      workspaceRoot: tempDir,
      customMemoryDir: path.join(tempDir, '.nexus', 'memory')
    })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should initialize memory directory and empty MEMORY.md', async () => {
    await manager.ensureMemoryDir()
    const memDir = manager.getMemoryDir()
    expect(fs.existsSync(memDir)).toBe(true)
    const entrypointPath = path.join(memDir, 'MEMORY.md')
    expect(fs.existsSync(entrypointPath)).toBe(true)
  })

  it('should save a memory item and update MEMORY.md index automatically', async () => {
    await manager.saveMemory({
      filename: 'feedback_testing.md',
      type: 'feedback',
      name: 'Test Strategy',
      description: 'Use real database for integration tests, do not mock',
      content: 'Integration tests must hit a real database.\n\n**Why:** Mock divergence caused issues.'
    })

    const memDir = manager.getMemoryDir()
    const filePath = path.join(memDir, 'feedback_testing.md')
    expect(fs.existsSync(filePath)).toBe(true)

    const fileContent = fs.readFileSync(filePath, 'utf-8')
    expect(fileContent).toContain('type: feedback')
    expect(fileContent).toContain('name: Test Strategy')
    expect(fileContent).toContain('Integration tests must hit a real database.')

    // Check MEMORY.md index
    const indexContent = manager.getEntrypointContent()
    expect(indexContent).toContain('- [Test Strategy](feedback_testing.md) — Use real database for integration tests, do not mock')
  })

  it('should read all memory items accurately', async () => {
    await manager.saveMemory({
      filename: 'user_role.md',
      type: 'user',
      name: 'User Background',
      description: 'Senior Go engineer touching React',
      content: 'User has 10 years Go experience, new to React.'
    })
    await manager.saveMemory({
      filename: 'project_freeze.md',
      type: 'project',
      name: 'Merge Freeze',
      description: '2026-03-05 merge freeze for release',
      content: 'Merge freeze starts on 2026-03-05.'
    })

    const items = await manager.listMemories()
    expect(items.length).toBe(2)
    const userItem = items.find(i => i.type === 'user')
    expect(userItem?.name).toBe('User Background')
    const projItem = items.find(i => i.type === 'project')
    expect(projItem?.name).toBe('Merge Freeze')
  })

  it('should update existing memory item without duplicating entry in MEMORY.md', async () => {
    await manager.saveMemory({
      filename: 'feedback_testing.md',
      type: 'feedback',
      name: 'Test Strategy',
      description: 'Version 1',
      content: 'Content 1'
    })

    await manager.saveMemory({
      filename: 'feedback_testing.md',
      type: 'feedback',
      name: 'Test Strategy Updated',
      description: 'Version 2 updated',
      content: 'Content 2 updated'
    })

    const indexContent = manager.getEntrypointContent()
    const matches = indexContent.split('\n').filter(line => line.includes('feedback_testing.md'))
    expect(matches.length).toBe(1)
    expect(matches[0]).toContain('Version 2 updated')
  })

  it('should delete memory item and remove its entry from MEMORY.md', async () => {
    await manager.saveMemory({
      filename: 'reference_docs.md',
      type: 'reference',
      name: 'API Docs',
      description: 'Internal API docs link',
      content: 'See docs.internal/api'
    })

    expect(manager.getEntrypointContent()).toContain('reference_docs.md')

    await manager.deleteMemory('reference_docs.md')
    expect(manager.getEntrypointContent()).not.toContain('reference_docs.md')

    const memDir = manager.getMemoryDir()
    expect(fs.existsSync(path.join(memDir, 'reference_docs.md'))).toBe(false)
  })

  it('should build formatted memory prompt section for LLM system prompt', async () => {
    await manager.saveMemory({
      filename: 'user_profile.md',
      type: 'user',
      name: 'Developer Profile',
      description: 'Backend engineer',
      content: 'Expert in distributed systems.'
    })

    const prompt = manager.buildMemoryPrompt()
    expect(prompt).toContain('# Auto Memory')
    expect(prompt).toContain('Types of memory')
    expect(prompt).toContain('What NOT to save')
    expect(prompt).toContain('MEMORY.md')
    expect(prompt).toContain('- [Developer Profile](user_profile.md)')
  })

  it('should strictly reject path traversal attacks when saving, reading, or deleting memories', async () => {
    // Attempting to write outside memoryDir via ../ traversal
    expect(
      manager.saveMemory({
        filename: '../../evil.md',
        type: 'feedback',
        name: 'Evil',
        description: 'Exploit',
        content: 'Malicious'
      })
    ).rejects.toThrow(/Invalid memory target filename/)

    // Attempting to read outside memoryDir
    const readRes = await manager.readMemory('../outside.md')
    expect(readRes).toBeNull()

    // Attempting to delete outside memoryDir
    const delRes = await manager.deleteMemory('../outside.md')
    expect(delRes).toBe(false)
  })
})
