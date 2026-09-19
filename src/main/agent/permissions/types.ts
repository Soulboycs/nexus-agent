import type { PermissionMode } from '@shared/types'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionRuleSource =
  | 'policySettings'
  | 'session'
  | 'localSettings'
  | 'projectSettings'
  | 'userSettings'
  | 'default'

export interface ParsedRule {
  ruleStr: string
  toolName: string
  specifier?: string
}

export interface ConfiguredRule {
  ruleStr: string
  behavior: PermissionBehavior
  source: PermissionRuleSource
}

export interface EvaluationResult {
  allowed: boolean
  requiresApproval: boolean
  behavior: PermissionBehavior
  reason?: string
  matchingRule?: ConfiguredRule
}
