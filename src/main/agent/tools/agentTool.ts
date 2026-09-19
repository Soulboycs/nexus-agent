import { z } from 'zod'
import type { AgentTool, ToolRegistry } from './ToolRegistry'
import { SubagentEngine } from '../subagents/SubagentEngine'
import type { ILLMProvider } from '../providers/LLMProvider'

export interface AgentToolOptions {
  workspaceRoot: string
  provider?: ILLMProvider
  getProvider?: () => ILLMProvider
  toolRegistry: ToolRegistry
}

export const agentToolSchema = z.object({
  subagent_type: z
    .enum(['Explore', 'Plan', 'General'])
    .describe('Type of subagent: Explore (fast read-only discovery), Plan (architecture planning), or General'),
  prompt: z.string().describe('Clear, actionable instructions for the subagent')
})

export function createAgentTool(
  options: AgentToolOptions
): AgentTool<z.infer<typeof agentToolSchema>> {
  return {
    name: 'Agent',
    description:
      'Spawn an isolated subagent to explore files, plan architecture, or execute dedicated subtasks without bloating parent context.',
    parameters: agentToolSchema,
    requiresApproval: () => false,
    execute: async (args, context) => {
      const activeProvider = options.getProvider ? options.getProvider() : options.provider
      if (!activeProvider) {
        throw new Error('No active LLM provider configured for Subagent delegation')
      }

      // 1:1 Claude Code canUseTool propagation: the subagent inherits the
      // parent's permission engine, sandbox and approval callback. Approval
      // requests surface in the host UI via emitAgentEvent; without any
      // callback SubagentEngine fails closed (auto-deny).
      const onApprovalRequired = context.onApprovalRequired
        ? async (request: any) => {
            context.emitAgentEvent?.({
              type: 'status_change',
              status: 'awaiting_confirmation',
              message: `Awaiting user confirmation for ${request.toolName} (subagent)...`,
            })
            context.emitAgentEvent?.({ type: 'approval_required', request })
            return await context.onApprovalRequired!(request)
          }
        : undefined

      const subagent = new SubagentEngine({
        subagentType: args.subagent_type,
        workspaceRoot: context.workspaceRoot || options.workspaceRoot,
        provider: activeProvider,
        parentToolRegistry: options.toolRegistry,
        permissionMode: context.permissionMode,
        permissionEngine: context.permissionEngine,
        sandboxGuard: context.sandboxGuard,
        onApprovalRequired,
      })

      const result = await subagent.run(args.prompt)
      return `[Subagent ${args.subagent_type} Response (${result.reason})]:\n${result.summary}`
    }
  }
}
