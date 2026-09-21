import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { FileHistoryTracker } from '../../src/main/agent/history/FileHistoryTracker'
import { writeToFileTool, replaceFileContentTool } from '../../src/main/agent/tools/fileTools'

describe('FileHistoryTracker & /undo (1:1 with Claude Code fileHistory)', () => {
  let tempDir: string
  let tracker: FileHistoryTracker

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-file-history-test-'))
    tracker = new FileHistoryTracker(tempDir)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('restores modified files back to original pre-edit content on rewind', async () => {
    const testFile = path.join(tempDir, 'existing.txt')
    await fs.writeFile(testFile, 'Version 1: Original Content\n', 'utf-8')

    // Track edit
    await tracker.trackEdit(testFile, tempDir)

    // Simulate edit
    await fs.writeFile(testFile, 'Version 2: Modified Content\n', 'utf-8')
    tracker.createSnapshot('turn_1')

    expect(await fs.readFile(testFile, 'utf-8')).toBe('Version 2: Modified Content\n')

    // Rewind
    const res = await tracker.rewindLastSnapshot(tempDir)
    expect(res.restored).toHaveLength(1)
    expect(await fs.readFile(testFile, 'utf-8')).toBe('Version 1: Original Content\n')
  })

  it('deletes newly created files on rewind', async () => {
    const newFile = path.join(tempDir, 'new_created_file.ts')

    // Track edit on non-existent file
    await tracker.trackEdit(newFile, tempDir)

    // Create file
    await fs.writeFile(newFile, 'export const secret = 42;\n', 'utf-8')
    tracker.createSnapshot('turn_2')

    expect(await fs.stat(newFile).then(() => true).catch(() => false)).toBe(true)

    // Rewind
    const res = await tracker.rewindLastSnapshot(tempDir)
    expect(res.deleted).toHaveLength(1)
    expect(await fs.stat(newFile).then(() => true).catch(() => false)).toBe(false)
  })

  it('preserves initial v1 backup even if trackEdit is called multiple times in same turn', async () => {
    const file = path.join(tempDir, 'multi_edit.txt')
    await fs.writeFile(file, 'Initial State\n', 'utf-8')

    // 1st edit in turn
    await tracker.trackEdit(file, tempDir)
    await fs.writeFile(file, 'Intermediate State\n', 'utf-8')

    // 2nd edit in same turn
    await tracker.trackEdit(file, tempDir)
    await fs.writeFile(file, 'Final State\n', 'utf-8')

    tracker.createSnapshot('turn_3')

    // Rewind must return to 'Initial State', not 'Intermediate State'
    await tracker.rewindLastSnapshot(tempDir)
    expect(await fs.readFile(file, 'utf-8')).toBe('Initial State\n')
  })

  it('integrates seamlessly with write_to_file and replace_file_content tools', async () => {
    const testFile = path.join(tempDir, 'code.ts')
    const ctx = {
      workspaceRoot: tempDir,
      fileHistoryTracker: tracker
    }

    // Step 1: write_to_file creates code.ts
    await writeToFileTool.execute(
      { filePath: 'code.ts', content: 'function hello() {\n  return "world";\n}\n', overwrite: true },
      ctx
    )
    tracker.createSnapshot('step_1')

    // Step 2: replace_file_content edits code.ts
    await replaceFileContentTool.execute(
      { filePath: 'code.ts', targetContent: '"world"', replacementContent: '"Nexus Agent"', allowMultiple: false },
      ctx
    )
    tracker.createSnapshot('step_2')

    expect(await fs.readFile(testFile, 'utf-8')).toContain('"Nexus Agent"')

    // Rewind step 2
    await tracker.rewindLastSnapshot(tempDir)
    expect(await fs.readFile(testFile, 'utf-8')).toContain('"world"')
    expect(await fs.readFile(testFile, 'utf-8')).not.toContain('"Nexus Agent"')

    // Rewind step 1 (created file)
    await tracker.rewindLastSnapshot(tempDir)
    expect(await fs.stat(testFile).then(() => true).catch(() => false)).toBe(false)
  })

  it('preserves Windows CRLF line endings when modifying files', async () => {
    const winFile = path.join(tempDir, 'windows.txt')
    const crlfContent = 'line 1\r\nline 2\r\nline 3\r\n'
    await fs.writeFile(winFile, crlfContent, 'utf-8')

    const ctx = { workspaceRoot: tempDir }
    await replaceFileContentTool.execute(
      { filePath: 'windows.txt', targetContent: 'line 2', replacementContent: 'line 2 modified', allowMultiple: false },
      ctx
    )

    const updated = await fs.readFile(winFile, 'utf-8')
    expect(updated).toBe('line 1\r\nline 2 modified\r\nline 3\r\n')
  })

  it('supports smart quote tolerance when replacing content', async () => {
    const quoteFile = path.join(tempDir, 'quote.txt')
    // File has straight quotes: console.log('hello');
    await fs.writeFile(quoteFile, "console.log('hello');\n", 'utf-8')

    const ctx = { workspaceRoot: tempDir }
    // LLM emitted curly quotes: console.log(‘hello’);
    await replaceFileContentTool.execute(
      { filePath: 'quote.txt', targetContent: "console.log(‘hello’);", replacementContent: "console.log('hi');", allowMultiple: false },
      ctx
    )

    const updated = await fs.readFile(quoteFile, 'utf-8')
    expect(updated).toBe("console.log('hi');\n")
  })
})
