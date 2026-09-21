export type SubagentType = 'Explore' | 'Plan' | 'General'

export interface SubagentRunResult {
  reason: 'completed' | 'aborted' | 'error'
  summary: string
}
