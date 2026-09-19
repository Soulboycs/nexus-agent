export type SandboxViolationType =
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SENSITIVE_FILE_PROTECTION'
  | 'DANGEROUS_COMMAND'

export interface SandboxValidationResult {
  passed: boolean
  violation?: SandboxViolationType
  reason?: string
}
