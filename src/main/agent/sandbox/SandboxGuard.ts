import * as path from 'path'
import * as os from 'os'
import type { SandboxValidationResult } from './types'

export interface SandboxGuardOptions {
  workspaceRoot: string
  allowTempDirs?: boolean
  additionalAllowedPaths?: string[]
}

const IS_WINDOWS = process.platform === 'win32'

const extraAllowedRoots = new Set<string>()

/**
 * 动态放行目录(R14):用户在工作区外打开的文档目录。
 * docsBridge 注册文档实例时调用;全部引擎实例共享(集中管理)。
 */
export function allowDocRoot(dir: string): void {
  try {
    extraAllowedRoots.add(path.resolve(dir))
  } catch {}
}

export class SandboxGuard {
  private workspaceRoot: string
  private allowedRoots: string[]

  constructor(options: SandboxGuardOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.allowedRoots = [this.workspaceRoot]

    if (options.allowTempDirs !== false) {
      this.allowedRoots.push(path.resolve(os.tmpdir()))
    }
    // Allow user nexus home for memory and config
    this.allowedRoots.push(path.resolve(path.join(os.homedir(), '.nexus')))

    if (options.additionalAllowedPaths) {
      for (const p of options.additionalAllowedPaths) {
        this.allowedRoots.push(path.resolve(p))
      }
    }
  }

  /**
   * Validates if a file target path is safe and inside the sandbox jail.
   */
  public validateFileTarget(rawPath: string): SandboxValidationResult {
    if (!rawPath || typeof rawPath !== 'string') {
      return {
        passed: false,
        violation: 'PATH_OUTSIDE_WORKSPACE',
        reason: 'Empty or invalid file path'
      }
    }

    if (rawPath.includes('\0')) {
      return {
        passed: false,
        violation: 'PATH_OUTSIDE_WORKSPACE',
        reason: 'Path contains null byte injection'
      }
    }

    // Resolve absolute path
    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceRoot, rawPath)

    const normalizedResolved = IS_WINDOWS ? resolved.toLowerCase() : resolved
    const forwardSlashes = normalizedResolved.replace(/\\/g, '/')

    // 0. 动态放行目录(R14):用户已打开的文档目录(集中管理,全部实例共享)
    for (const root of extraAllowedRoots) {
      const rootNorm = (IS_WINDOWS ? root.toLowerCase() : root).replace(/[\\]+/g, '/')
      if (forwardSlashes.startsWith(rootNorm.endsWith('/') ? rootNorm : rootNorm + '/')) {
        return { passed: true }
      }
    }

    // 1. Check for sensitive files (even inside workspace!)
    if (
      forwardSlashes.includes('/.git/hooks/') ||
      forwardSlashes.endsWith('/.git/hooks') ||
      forwardSlashes.includes('/.ssh/') ||
      forwardSlashes.endsWith('/id_rsa') ||
      forwardSlashes.endsWith('/id_ed25519')
    ) {
      return {
        passed: false,
        violation: 'SENSITIVE_FILE_PROTECTION',
        reason: `Target path "${rawPath}" is protected against unauthorized tampering`
      }
    }

    // 2. Check if inside any allowed root
    let isInsideAllowedRoot = false
    for (const root of this.allowedRoots) {
      const normalizedRoot = IS_WINDOWS ? root.toLowerCase() : root
      if (
        normalizedResolved === normalizedRoot ||
        normalizedResolved.startsWith(normalizedRoot + path.sep) ||
        normalizedResolved.startsWith(normalizedRoot + '/')
      ) {
        isInsideAllowedRoot = true
        break
      }
    }

    if (!isInsideAllowedRoot) {
      return {
        passed: false,
        violation: 'PATH_OUTSIDE_WORKSPACE',
        reason: `Path "${rawPath}" is outside the workspace sandbox jail`
      }
    }

    return { passed: true }
  }

  /**
   * Inspects shell command line for catastrophic or destructive patterns.
   */
  public validateCommand(commandLine: string): SandboxValidationResult {
    const trimmed = commandLine.trim()

    // 1. Fork bomb
    if (trimmed.includes(':(){ :|:& };:')) {
      return {
        passed: false,
        violation: 'DANGEROUS_COMMAND',
        reason: 'Fork bomb execution blocked'
      }
    }

    // 2. Root recursive wipe
    if (
      /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|\/\*)(?:\s|$)/i.test(trimmed) ||
      /\brm\s+(-rf|-fr|-r\s+-f|-f\s+-r)\s+(\/|\/\*)(?:\s|$)/i.test(trimmed)
    ) {
      return {
        passed: false,
        violation: 'DANGEROUS_COMMAND',
        reason: 'Recursive deletion of root filesystem blocked'
      }
    }

    // 3. Disk format / partition wiping
    if (
      /\bformat\s+[a-zA-Z]:/i.test(trimmed) ||
      /\bmkfs\b/i.test(trimmed) ||
      /\bdel\s+\/s\s+\/q\s+[a-zA-Z]:\\(\*|system32)/i.test(trimmed)
    ) {
      return {
        passed: false,
        violation: 'DANGEROUS_COMMAND',
        reason: 'Destructive drive format / system wipe command blocked'
      }
    }

    return { passed: true }
  }
}
