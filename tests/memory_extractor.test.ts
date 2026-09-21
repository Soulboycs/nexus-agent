import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryExtractor } from '../src/main/agent/memory/MemoryExtractor'
import { MemoryManager } from '../src/main/agent/memory/MemoryManager'
import type { LLMMessage } from '../src/main/agent/providers/LLMProvider'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('MemoryExtractor', () => {
  let tempDir: string
  let manager: MemoryManager

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-extractor-test-'))
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

  it('should ignore trivial messages (greetings, simple queries)', async () => {
    const extractor = new MemoryExtractor({ memoryManager: manager })
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi! How can I help you today?' }
    ]

    const extracted = await extractor.extractFromTurn(messages)
    expect(extracted.length).toBe(0)
  })

  it('should extract user feedback/corrections and save into memory', async () => {
    let notifiedFilename = ''
    const extractor = new MemoryExtractor({
      memoryManager: manager,
      onMemoryUpdated: (item) => {
        notifiedFilename = item.filename
      }
    })

    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'Remember: never use python scripts or python-docx to edit docx files in this repo, always use docx_modify_block'
      },
      {
        role: 'assistant',
        content: 'Got it. I will strictly use docx_modify_block instead of python scripts.'
      }
    ]

    const extracted = await extractor.extractFromTurn(messages)
    expect(extracted.length).toBeGreaterThan(0)
    expect(extracted[0].type).toBe('feedback')
    expect(notifiedFilename).toBe(extracted[0].filename)

    // Verify it was persisted to disk
    const saved = await manager.readMemory(extracted[0].filename)
    expect(saved).not.toBeNull()
    expect(saved?.content).toContain('docx')
  })

  it('should extract user profile when user introduces role or skill background', async () => {
    const extractor = new MemoryExtractor({ memoryManager: manager })
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'I have 10 years of experience in Go and Rust, but I am completely new to React and Vite in this project.'
      },
      {
        role: 'assistant',
        content: 'Understood, I will frame frontend React concepts using Go and Rust patterns.'
      }
    ]

    const extracted = await extractor.extractFromTurn(messages)
    expect(extracted.length).toBeGreaterThan(0)
    expect(extracted[0].type).toBe('user')
    expect(extracted[0].content).toContain('Go')
  })
})
