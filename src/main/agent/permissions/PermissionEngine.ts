import type { PermissionMode } from '@shared/types'
import {
  matchesPermissionRule,
  parsePermissionRule
} from './ruleParser'
import type {
  ConfiguredRule,
  EvaluationResult,
  PermissionRuleSource
} from './types'

export const READ_ONLY_TOOLS = new Set([
  // R5 cc 命名（正名）+ 旧名（别名兼容期双覆盖）
  'Read',
  'view_file',
  'read_file',
  'cat',
  'Glob',
  'Grep',
  'GlobTool',
  'GrepTool',
  'LS',
  'list_directory',
  'list_dir',
  'ls',
  'dir',
  'find_files',
  'search_text',
  'TodoWrite',
  'grep_search',
  'grep',
  'find_by_name',
  'glob',
  'list_dir',
  'list_directory',
  'read_url_content',
  'search_web',
  'docx_read',
  'docx_read_revisions',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'TaskList',
  'TaskOutput'
])

export const EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'write_to_file',
  'replace_file_content',
  'edit',
  'write_file',
  'create_file',
  'edit_file',
  'str_replace',
  'docx_modify_block',
  'docx_apply_ops',
  'docx_append_content',
  'docx_insert_table',
  'docx_delete_block',
  'docx_create',
  'docx_accept_revisions',
  'docx_reject_revisions',
  // R6
  'NotebookEdit',
  'TaskCreate',
  'TaskStop'
])

/**
 * Built-in sensitive-file policy (write-only). Matches the basename anywhere
 * in the path so `.env.local`, `prod.env`, `credentials.json` etc. are covered.
 * Read stays allowed — agents legitimately inspect these files; only mutation
 * asks. Bypass mode still skips it (the mode's contract is zero prompts).
 */
const SENSITIVE_WRITE_PATTERN = /(^|[\\/])(\.env[^\\/]*|credentials[^\\/]*|\.npmrc|id_rsa[^\\/]*|id_ed25519[^\\/]*)$/i

export function isSensitiveWriteTarget(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  if (!EDIT_TOOLS.has(toolName)) return false
  const target =
    (args.filePath || args.TargetFile || args.AbsolutePath || args.path) as string | undefined
  if (!target || typeof target !== 'string') return false
  return SENSITIVE_WRITE_PATTERN.test(target)
}

export interface PermissionEngineOptions {
  rules?: ConfiguredRule[]
}

export class PermissionEngine {
  private rules: ConfiguredRule[] = []

  constructor(options?: PermissionEngineOptions) {
    if (options?.rules) {
      this.rules = [...options.rules]
    }
  }

  public addRule(rule: ConfiguredRule): void {
    // Avoid duplicate identical rules
    this.rules = this.rules.filter(
      (r) => !(r.ruleStr === rule.ruleStr && r.source === rule.source)
    )
    this.rules.push(rule)
  }

  public removeRule(ruleStr: string, source?: PermissionRuleSource): void {
    this.rules = this.rules.filter((r) => {
      if (r.ruleStr !== ruleStr) return true
      if (source && r.source !== source) return true
      return false
    })
  }

  public getRules(): ConfiguredRule[] {
    return [...this.rules]
  }

  /**
   * Evaluates permission for a specific tool call against configured rules and active permissionMode.
   */
  public evaluate(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode = 'ask'
  ): EvaluationResult {
    // 1. Check for matching 'deny' rules across all levels (fail-closed model: deny wins!)
    for (const rule of this.rules) {
      if (rule.behavior === 'deny') {
        const parsed = parsePermissionRule(rule.ruleStr)
        if (matchesPermissionRule(parsed, toolName, args)) {
          return {
            allowed: false,
            requiresApproval: false,
            behavior: 'deny',
            reason: `Tool execution denied by policy: ${rule.ruleStr} (${rule.source})`,
            matchingRule: rule
          }
        }
      }
    }

    // 1.5 Built-in sensitive-write policy: mutating credentials/env files asks
    // even when mode defaults would auto-allow (deny rules above still win).
    if (
      mode !== 'bypass' &&
      isSensitiveWriteTarget(toolName, args)
    ) {
      return {
        allowed: true,
        requiresApproval: true,
        behavior: 'ask',
        reason: `Sensitive file write requires approval (${toolName})`
      }
    }

    // 2. Check for explicit rules by source priority (session > local > project > user)
    const priorityOrder: PermissionRuleSource[] = [
      'session',
      'policySettings',
      'localSettings',
      'projectSettings',
      'userSettings'
    ]

    for (const source of priorityOrder) {
      const sourceRules = this.rules.filter((r) => r.source === source)
      for (const rule of sourceRules) {
        const parsed = parsePermissionRule(rule.ruleStr)
        if (matchesPermissionRule(parsed, toolName, args)) {
          if (rule.behavior === 'allow') {
            return {
              allowed: true,
              requiresApproval: false,
              behavior: 'allow',
              matchingRule: rule
            }
          } else if (rule.behavior === 'ask') {
            return {
              allowed: true,
              requiresApproval: true,
              behavior: 'ask',
              matchingRule: rule
            }
          }
        }
      }
    }

    // 3. Fall back to permissionMode defaults
    return this.evaluateModeDefaults(toolName, mode)
  }

  private evaluateModeDefaults(toolName: string, mode: PermissionMode): EvaluationResult {
    // In bypass mode: everything allowed automatically
    if (mode === 'bypass') {
      return {
        allowed: true,
        requiresApproval: false,
        behavior: 'allow'
      }
    }

    // In plan mode: only read-only tools allowed
    if (mode === 'plan') {
      if (READ_ONLY_TOOLS.has(toolName)) {
        return {
          allowed: true,
          requiresApproval: false,
          behavior: 'allow'
        }
      }
      return {
        allowed: false,
        requiresApproval: false,
        behavior: 'deny',
        reason: `Action blocked: tool "${toolName}" is not permitted in plan mode.`
      }
    }

    // In ask mode (semantics inherited from the old acceptEdits): read and
    // edit tools allowed automatically; commands and everything else ask.
    if (READ_ONLY_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName)) {
      return {
        allowed: true,
        requiresApproval: false,
        behavior: 'allow'
      }
    }

    return {
      allowed: true,
      requiresApproval: true,
      behavior: 'ask'
    }
  }
}
