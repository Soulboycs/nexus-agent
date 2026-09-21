import type { ParsedRule } from './types'

/**
 * Parses a permission rule string like "run_command" or "run_command(bun test *)".
 */
export function parsePermissionRule(ruleStr: string): ParsedRule {
  const trimmed = ruleStr.trim()
  const openParen = trimmed.indexOf('(')

  if (openParen === -1 || !trimmed.endsWith(')')) {
    return {
      ruleStr: trimmed,
      toolName: trimmed
    }
  }

  const toolName = trimmed.slice(0, openParen).trim()
  const specifier = trimmed.slice(openParen + 1, -1).trim()

  return {
    ruleStr: trimmed,
    toolName,
    specifier
  }
}

/**
 * Checks if a string pattern with wildcard `*` matches a target string.
 */
export function matchesWildcard(pattern: string, target: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  const normalizedTarget = target.replace(/\\/g, '/').toLowerCase()
  const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase()

  if (normalizedPattern === normalizedTarget) return true

  // Convert wildcard pattern to regex
  // ** matches any characters including slashes
  // * matches any characters except slashes or generic word match
  const regexStr = '^' + normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '.*') + '$'

  try {
    const regex = new RegExp(regexStr, 'i')
    if (regex.test(normalizedTarget)) return true
  } catch {
    // fallback
  }

  // Also support prefix matching for command specifiers e.g. "git *" or "bun test *"
  if (normalizedPattern.endsWith('.*') || normalizedPattern.endsWith('*')) {
    const prefix = normalizedPattern.replace(/\*+/g, '').trim()
    if (normalizedTarget.startsWith(prefix)) return true
  }

  return false
}

/**
 * Evaluates whether a tool call with given arguments satisfies a parsed rule.
 */
export function matchesPermissionRule(
  rule: ParsedRule,
  toolName: string,
  args: Record<string, unknown>
): boolean {
  if (rule.toolName !== '*' && rule.toolName !== toolName) {
    return false
  }

  if (!rule.specifier) {
    return true
  }

  // 1. Command tools
  if (toolName === 'run_command' || toolName === 'Bash' || toolName === 'bash') {
    const cmd = (args.CommandLine || args.command || '') as string
    return matchesWildcard(rule.specifier, cmd)
  }

  // 2. File modification or inspection tools
  const targetFile = (args.TargetFile || args.AbsolutePath || args.path || '') as string
  if (targetFile) {
    const normalizedTarget = targetFile.replace(/\\/g, '/')
    if (matchesWildcard(rule.specifier, normalizedTarget)) {
      return true
    }
    // Also match relative path within project (e.g. specifier "src/**" against "/path/to/src/foo.ts")
    if (rule.specifier.includes('/**') || rule.specifier.includes('/*')) {
      const token = '___GLOB_DOUBLE_STAR___'
      const sanitized = rule.specifier
        .replace(/\*\*/g, token)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(new RegExp(token, 'g'), '.*')
      const reg = new RegExp(`(^|/)${sanitized}$`, 'i')
      if (reg.test(normalizedTarget)) {
        return true
      }
    }
  }

  return false
}
