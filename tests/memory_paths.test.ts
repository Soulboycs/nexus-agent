import { describe, it, expect } from 'bun:test'
import {
  getProjectHash,
  getAutoMemPath,
  validateMemoryPath,
  truncateEntrypointContent,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES
} from '../src/main/agent/memory/paths'
import * as os from 'os'
import * as path from 'path'

describe('Memory Paths & Security', () => {
  it('should generate consistent project hash regardless of path casing or trailing slashes on Windows', () => {
    const hash1 = getProjectHash('D:\\Agent')
    const hash2 = getProjectHash('d:\\agent\\')
    const hash3 = getProjectHash('d:/agent')
    expect(hash1).toBe(hash2)
    expect(hash1).toBe(hash3)
    expect(hash1.length).toBeGreaterThan(8)
  })

  it('should resolve default auto memory path under ~/.nexus/projects/{hash}/memory', () => {
    const memPath = getAutoMemPath('d:\\Agent')
    const expectedBase = path.join(os.homedir(), '.nexus', 'projects')
    expect(memPath.startsWith(expectedBase)).toBe(true)
    expect(memPath.endsWith(path.join('memory', '')) || memPath.endsWith('memory')).toBe(true)
  })

  it('should respect custom memory path override if provided', () => {
    const custom = 'D:\\custom_mem_dir'
    const memPath = getAutoMemPath('d:\\Agent', { customDir: custom })
    expect(memPath).toBe(custom)
  })

  it('should validate memory paths and reject dangerous paths', () => {
    // Valid path
    expect(validateMemoryPath('D:\\safe\\project\\.nexus\\memory')).toBe(true)
    expect(validateMemoryPath(path.join(os.homedir(), '.nexus', 'projects', 'abc', 'memory'))).toBe(true)

    // Dangerous / invalid paths
    expect(validateMemoryPath('')).toBe(false)
    expect(validateMemoryPath('../relative/path')).toBe(false)
    expect(validateMemoryPath('C:\\')).toBe(false)
    expect(validateMemoryPath('/')).toBe(false)
    expect(validateMemoryPath('/a')).toBe(false)
    expect(validateMemoryPath('\\\\server\\share\\memory')).toBe(false)
    expect(validateMemoryPath('D:\\test\0hidden')).toBe(false)

    // Strict containment against base directory
    const base = 'D:\\projects\\memory'
    expect(validateMemoryPath('D:\\projects\\memory\\topic.md', base)).toBe(true)
    expect(validateMemoryPath('D:\\projects\\other\\evil.md', base)).toBe(false)
    expect(validateMemoryPath(path.join(base, '../../../../Windows/System32/evil.dll'), base)).toBe(false)
  })
})

describe('MEMORY.md Entrypoint Truncation', () => {
  it('should keep content intact if within line and byte limits', () => {
    const content = `- [User Role](user_role.md) — Senior full stack engineer\n- [Test Policy](feedback_test.md) — Always run bun test`
    const res = truncateEntrypointContent(content)
    expect(res.wasLineTruncated).toBe(false)
    expect(res.wasByteTruncated).toBe(false)
    expect(res.content).toBe(content)
    expect(res.lineCount).toBe(2)
  })

  it('should truncate lines if exceeding MAX_ENTRYPOINT_LINES (200)', () => {
    const lines: string[] = []
    for (let i = 1; i <= 250; i++) {
      lines.push(`- [Entry ${i}](entry_${i}.md) — Description for item ${i}`)
    }
    const raw = lines.join('\n')
    const res = truncateEntrypointContent(raw)
    expect(res.wasLineTruncated).toBe(true)
    expect(res.content.split('\n').filter(l => l.startsWith('- [Entry')).length).toBe(MAX_ENTRYPOINT_LINES)
    expect(res.content).toContain('WARNING: MEMORY.md is')
  })

  it('should truncate bytes if exceeding MAX_ENTRYPOINT_BYTES (25,000)', () => {
    // 100 lines but each line has 300 characters -> ~30,000 bytes
    const lines: string[] = []
    for (let i = 1; i <= 100; i++) {
      lines.push(`- [Entry ${i}](entry_${i}.md) — ${'A'.repeat(280)}`)
    }
    const raw = lines.join('\n')
    const res = truncateEntrypointContent(raw)
    expect(res.wasByteTruncated).toBe(true)
    expect(res.byteCount).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)
    expect(res.content.length).toBeLessThan(MAX_ENTRYPOINT_BYTES + 300)
    expect(res.content).toContain('WARNING: MEMORY.md is')
  })
})
