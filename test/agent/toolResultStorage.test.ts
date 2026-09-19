import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  processToolResult,
  persistToolResult,
  buildLargeToolResultMessage,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  PREVIEW_SIZE_BYTES,
  PERSISTED_OUTPUT_TAG,
  PERSISTED_OUTPUT_CLOSING_TAG,
  formatFileSize
} from '../../src/main/agent/tools/ToolResultStorage'

describe('ToolResultStorage - Large Output Disk Spillover & Preview', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tool-storage-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('preserves small tool outputs without disk persistence', async () => {
    const output = 'Hello, Nexus Agent!'
    const res = await processToolResult(
      { name: 'test_tool' },
      output,
      'call_123',
      { workspaceRoot: tempDir }
    )

    expect(res.output).toBe(output)
    expect(res.persisted).toBeUndefined()
  })

  it('persists tool outputs exceeding DEFAULT_MAX_RESULT_SIZE_CHARS (50,000 chars) to disk', async () => {
    // Generate a 60,000 character output
    const largeOutput = 'A'.repeat(60_000)
    const res = await processToolResult(
      { name: 'run_command' },
      largeOutput,
      'call_cmd_456',
      {
        workspaceRoot: tempDir,
        sessionId: 'session_abc'
      }
    )

    expect(res.persisted).toBeDefined()
    expect(res.persisted?.originalSize).toBe(60_000)
    expect(res.persisted?.filepath).toContain(path.join('.nexus', 'sessions', 'session_abc', 'tool-results'))
    expect(res.persisted?.filepath.endsWith('.txt')).toBe(true)

    // Verify file exists on disk and content matches exactly
    const savedContent = await fs.readFile(res.persisted!.filepath, 'utf-8')
    expect(savedContent).toBe(largeOutput)

    // Verify XML placeholder format
    expect(res.output).toContain(PERSISTED_OUTPUT_TAG)
    expect(res.output).toContain(PERSISTED_OUTPUT_CLOSING_TAG)
    expect(res.output).toContain('Output too large')
    expect(res.output).toContain(`Full output saved to: ${res.persisted!.filepath}`)
    expect(res.output).toContain(`Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):`)
    expect(res.output).toContain('A'.repeat(PREVIEW_SIZE_BYTES))
  })

  it('never persists tools with maxResultSizeChars === Infinity (anti-loop protection for view_file)', async () => {
    // Even with a huge 200,000 character output, view_file must NOT spill to disk
    const hugeOutput = 'Line from file\n'.repeat(15_000)
    const res = await processToolResult(
      { name: 'view_file', maxResultSizeChars: Infinity },
      hugeOutput,
      'call_view_789',
      { workspaceRoot: tempDir }
    )

    expect(res.output).toBe(hugeOutput)
    expect(res.persisted).toBeUndefined()
  })

  it('respects custom tool-specific maxResultSizeChars threshold', async () => {
    const customThreshold = 500
    const output = 'B'.repeat(600)

    const res = await processToolResult(
      { name: 'custom_tool', maxResultSizeChars: customThreshold },
      output,
      'call_custom_1',
      { workspaceRoot: tempDir }
    )

    expect(res.persisted).toBeDefined()
    expect(res.persisted?.originalSize).toBe(600)
    expect(res.output).toContain(PERSISTED_OUTPUT_TAG)
  })

  it('identifies JSON tool outputs and saves with .json extension', async () => {
    const jsonObject = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item_${i}` })) }
    const jsonOutput = JSON.stringify(jsonObject)

    const res = await processToolResult(
      { name: 'json_api_tool', maxResultSizeChars: 100 },
      jsonOutput,
      'call_json_2',
      { workspaceRoot: tempDir }
    )

    expect(res.persisted).toBeDefined()
    expect(res.persisted?.isJson).toBe(true)
    expect(res.persisted?.filepath.endsWith('.json')).toBe(true)

    const parsedOnDisk = JSON.parse(await fs.readFile(res.persisted!.filepath, 'utf-8'))
    expect(parsedOnDisk.items.length).toBe(2000)
  })

  it('normalizes empty or whitespace-only tool output to prevent LLM premature stop (inc-4586)', async () => {
    // Empty string
    const resEmpty = await processToolResult(
      { name: 'run_command' },
      '',
      'call_empty',
      { workspaceRoot: tempDir }
    )
    expect(resEmpty.output).toBe('(run_command completed with no output)')
    expect(resEmpty.persisted).toBeUndefined()

    // Whitespace only
    const resWhitespace = await processToolResult(
      { name: 'write_to_file' },
      '   \n\t  ',
      'call_spaces',
      { workspaceRoot: tempDir }
    )
    expect(resWhitespace.output).toBe('(write_to_file completed with no output)')
  })
})
