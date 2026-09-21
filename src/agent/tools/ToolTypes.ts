import { z } from 'zod'
import { ToolResultPayload } from '../../shared/types'
export { ToolContext, AgentTool, ValidationResult } from '../../main/agent/tools/ToolRegistry'
import type { AgentTool } from '../../main/agent/tools/ToolRegistry'

export function buildAgentTool<TArgs>(tool: AgentTool<TArgs>): AgentTool<TArgs> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    maxResultSizeChars: 50_000,
    ...tool,
  }
}

