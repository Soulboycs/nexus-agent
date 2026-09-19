import { describe, it, expect, beforeEach } from 'vitest'
import { ToolHookRegistry } from '../../src/main/agent/tools/ToolHooks'
import { ToolContext } from '../../src/main/agent/tools/ToolRegistry'

describe('ToolHooks - Lifecycle Interception Pipeline', () => {
  let hooks: ToolHookRegistry
  const mockContext: ToolContext = { workspaceRoot: '/test/workspace' }

  beforeEach(() => {
    hooks = new ToolHookRegistry()
  })

  it('allows tool execution when PreToolUse hook approves', async () => {
    hooks.registerPreToolHook(async (toolName, input) => {
      return { decision: 'allow' }
    })

    const res = await hooks.executePreToolHooks('read_file', { filePath: 'foo.ts' }, mockContext)
    expect(res.decision).toBe('allow')
    expect(res.updatedInput).toEqual({ filePath: 'foo.ts' })
  })

  it('blocks tool execution when PreToolUse hook returns block decision', async () => {
    hooks.registerPreToolHook(async (toolName, input) => {
      if (input.dangerous) {
        return {
          decision: 'block',
          reason: 'Dangerous operation prohibited by safety hook'
        }
      }
      return { decision: 'allow' }
    })

    const res = await hooks.executePreToolHooks('run_command', { command: 'rm -rf /', dangerous: true }, mockContext)
    expect(res.decision).toBe('block')
    expect(res.reason).toContain('Dangerous operation prohibited')
  })

  it('modifies and sanitizes input arguments via PreToolUse hook', async () => {
    hooks.registerPreToolHook(async (toolName, input) => {
      if (typeof input.command === 'string') {
        return {
          decision: 'allow',
          updatedInput: {
            command: input.command.trim()
          }
        }
      }
    })

    const res = await hooks.executePreToolHooks('run_command', { command: '   npm test   ' }, mockContext)
    expect(res.decision).toBe('allow')
    expect(res.updatedInput?.command).toBe('npm test')
  })

  it('transforms tool output via PostToolUse hook', async () => {
    hooks.registerPostToolHook(async (toolName, input, output) => {
      return {
        modifiedOutput: output + '\n[Audited by ComplianceHook]'
      }
    })

    const res = await hooks.executePostToolHooks('write_file', { filePath: 'bar.txt' }, 'File written', mockContext)
    expect(res.modifiedOutput).toBe('File written\n[Audited by ComplianceHook]')
  })

  it('recovers from tool execution failure via PostToolUseFailure hook', async () => {
    hooks.registerFailureHook(async (toolName, input, error) => {
      if (error.message.includes('ENOENT')) {
        return {
          recoveredOutput: 'File was missing, fallback applied.'
        }
      }
    })

    const res = await hooks.executeFailureHooks('read_file', { filePath: 'missing.txt' }, new Error('ENOENT: no such file'), mockContext)
    expect(res.recoveredOutput).toBe('File was missing, fallback applied.')
  })

  it('supports unregistering hooks via dispose function', async () => {
    const dispose = hooks.registerPreToolHook(async () => {
      return { decision: 'block', reason: 'Temporary block' }
    })

    let res = await hooks.executePreToolHooks('test', {}, mockContext)
    expect(res.decision).toBe('block')

    dispose() // Unregister

    res = await hooks.executePreToolHooks('test', {}, mockContext)
    expect(res.decision).toBe('allow')
  })
})
