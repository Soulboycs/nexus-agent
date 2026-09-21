import { describe, it, expect } from 'bun:test'
import { SandboxGuard } from '../src/main/agent/sandbox/SandboxGuard'

describe('SandboxGuard Defense & Jail Isolation', () => {
  const workspaceRoot = 'd:/Agent'
  const guard = new SandboxGuard({ workspaceRoot })

  it('should allow file modifications inside workspace root or temp dir', () => {
    const valid1 = guard.validateFileTarget('d:/Agent/src/foo.ts')
    expect(valid1.passed).toBe(true)

    const valid2 = guard.validateFileTarget('d:\\Agent\\tests\\bar.test.ts')
    expect(valid2.passed).toBe(true)
  })

  it('should block file modifications outside workspace root (path traversal / system dir)', () => {
    const invalid1 = guard.validateFileTarget('c:/windows/system32/drivers/etc/hosts')
    expect(invalid1.passed).toBe(false)
    expect(invalid1.violation).toBe('PATH_OUTSIDE_WORKSPACE')

    const invalid2 = guard.validateFileTarget('d:/Agent/../../sensitive_folder/secret.txt')
    expect(invalid2.passed).toBe(false)
    expect(invalid2.violation).toBe('PATH_OUTSIDE_WORKSPACE')
  })

  it('should block modifications to sensitive files (.git/hooks, ssh keys, root config)', () => {
    const sensitiveGit = guard.validateFileTarget('d:/Agent/.git/hooks/pre-commit')
    expect(sensitiveGit.passed).toBe(false)
    expect(sensitiveGit.violation).toBe('SENSITIVE_FILE_PROTECTION')

    const sensitiveSsh = guard.validateFileTarget('C:/Users/Administrator/.ssh/id_rsa')
    expect(sensitiveSsh.passed).toBe(false)
    expect(sensitiveSsh.violation).toBe('SENSITIVE_FILE_PROTECTION')
  })

  it('should detect and block catastrophic commands', () => {
    // Dangerous destructive commands
    expect(guard.validateCommand('rm -rf /').passed).toBe(false)
    expect(guard.validateCommand('rm -rf /*').passed).toBe(false)
    expect(guard.validateCommand('format C: /y').passed).toBe(false)
    expect(guard.validateCommand(':(){ :|:& };:').passed).toBe(false)

    // Safe standard dev commands
    expect(guard.validateCommand('bun test tests/foo.test.ts').passed).toBe(true)
    expect(guard.validateCommand('git status').passed).toBe(true)
    expect(guard.validateCommand('npm run build').passed).toBe(true)
  })
})
