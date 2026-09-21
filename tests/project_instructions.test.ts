import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ProjectInstructions } from '../src/main/agent/memory/ProjectInstructions'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('ProjectInstructions Discovery', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-instructions-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should return empty string if no instruction files exist', async () => {
    const instructions = new ProjectInstructions(tempDir)
    const prompt = await instructions.loadInstructionsPrompt()
    expect(prompt).toBe('')
  })

  it('should detect NEXUS.md and inject into prompt', async () => {
    const filePath = path.join(tempDir, 'NEXUS.md')
    fs.writeFileSync(filePath, '# Nexus Custom Guidelines\n- Rule 1: Always check types\n- Rule 2: Run tests', 'utf-8')

    const instructions = new ProjectInstructions(tempDir)
    const prompt = await instructions.loadInstructionsPrompt()
    expect(prompt).toContain('# Project Instructions (from NEXUS.md)')
    expect(prompt).toContain('Rule 1: Always check types')
  })

  it('should detect AGENTS.md if NEXUS.md does not exist', async () => {
    const filePath = path.join(tempDir, 'AGENTS.md')
    fs.writeFileSync(filePath, '# Agent Rules\n- Use evidence driven engineering', 'utf-8')

    const instructions = new ProjectInstructions(tempDir)
    const prompt = await instructions.loadInstructionsPrompt()
    expect(prompt).toContain('# Project Instructions (from AGENTS.md)')
    expect(prompt).toContain('Use evidence driven engineering')
  })

  it('should detect CLAUDE.md if neither NEXUS.md nor AGENTS.md exist', async () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# Claude Guidelines\n- Build using bun test', 'utf-8')

    const instructions = new ProjectInstructions(tempDir)
    const prompt = await instructions.loadInstructionsPrompt()
    expect(prompt).toContain('# Project Instructions (from CLAUDE.md)')
    expect(prompt).toContain('Build using bun test')
  })

  it('should merge project instructions with local instructions (.local.md) if present', async () => {
    fs.writeFileSync(path.join(tempDir, 'NEXUS.md'), 'Team instruction: keep code clean', 'utf-8')
    fs.writeFileSync(path.join(tempDir, 'NEXUS.local.md'), 'Personal instruction: use dark mode theme test', 'utf-8')

    const instructions = new ProjectInstructions(tempDir)
    const prompt = await instructions.loadInstructionsPrompt()
    expect(prompt).toContain('Team instruction: keep code clean')
    expect(prompt).toContain('Personal instruction: use dark mode theme test')
  })
})
