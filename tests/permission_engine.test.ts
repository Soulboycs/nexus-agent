import { describe, it, expect } from 'bun:test'
import { PermissionEngine } from '../src/main/agent/permissions/PermissionEngine'

describe('PermissionEngine Multi-Tier Rule Evaluation', () => {
  it('should deny execution when a matching deny rule exists, even if an allow rule matches', () => {
    const engine = new PermissionEngine({
      rules: [
        { ruleStr: 'run_command(rm -rf *)', behavior: 'deny', source: 'projectSettings' },
        { ruleStr: 'run_command(*)', behavior: 'allow', source: 'userSettings' }
      ]
    })

    const evalRes = engine.evaluate('run_command', { CommandLine: 'rm -rf /' }, 'ask')
    expect(evalRes.allowed).toBe(false)
    expect(evalRes.behavior).toBe('deny')
    expect(evalRes.reason).toContain('denied')
  })

  it('should allow execution without approval when matching allow rule exists', () => {
    const engine = new PermissionEngine({
      rules: [
        { ruleStr: 'run_command(bun test *)', behavior: 'allow', source: 'projectSettings' }
      ]
    })

    const evalRes = engine.evaluate('run_command', { CommandLine: 'bun test tests/foo.test.ts' }, 'ask')
    expect(evalRes.allowed).toBe(true)
    expect(evalRes.requiresApproval).toBe(false)
  })

  it('should prioritize session-scoped rules over project settings', () => {
    const engine = new PermissionEngine({
      rules: [
        { ruleStr: 'run_command(npm install)', behavior: 'ask', source: 'projectSettings' }
      ]
    })

    // Before session grant: requires approval
    const before = engine.evaluate('run_command', { CommandLine: 'npm install' }, 'ask')
    expect(before.requiresApproval).toBe(true)

    // Grant for current session
    engine.addRule({ ruleStr: 'run_command(npm install)', behavior: 'allow', source: 'session' })

    const after = engine.evaluate('run_command', { CommandLine: 'npm install' }, 'ask')
    expect(after.allowed).toBe(true)
    expect(after.requiresApproval).toBe(false)
  })

  it('should fall back to permissionMode defaults when no explicit rule matches', () => {
    const engine = new PermissionEngine()

    // Read-only tool in default mode: allowed without approval
    const readRes = engine.evaluate('view_file', { AbsolutePath: 'foo.ts' }, 'ask')
    expect(readRes.allowed).toBe(true)
    expect(readRes.requiresApproval).toBe(false)

    // Command tool in default mode: requires approval
    const cmdRes = engine.evaluate('run_command', { CommandLine: 'npm run build' }, 'ask')
    expect(cmdRes.requiresApproval).toBe(true)

    // In bypassPermissions mode: everything allowed
    const bypassRes = engine.evaluate('run_command', { CommandLine: 'npm run build' }, 'bypass')
    expect(bypassRes.allowed).toBe(true)
    expect(bypassRes.requiresApproval).toBe(false)

    // In acceptEdits mode: file modifications allowed, command requires approval
    const editRes = engine.evaluate('write_to_file', { TargetFile: 'foo.ts' }, 'ask')
    expect(editRes.allowed).toBe(true)
    expect(editRes.requiresApproval).toBe(false)
  })
})
