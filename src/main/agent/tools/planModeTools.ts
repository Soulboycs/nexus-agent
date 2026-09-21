import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R6 EnterPlanMode / ExitPlanMode（1:1 cc，执行侧复用我们的 plan 权限模式）。
 * 已披露简化：cc 的 plan 内容存盘 + updatedInput 回写机制，我们简化为
 * ExitPlanMode 直接以 plan 参数携带（批准时经 updatedInput 亦可改写）。
 */

export const enterPlanModeTool: AgentTool = {
  name: 'EnterPlanMode',
  aliases: ['enter_plan_mode'],
  description:
    'Switch into plan mode: explore the codebase read-only, design an approach, then call ExitPlanMode with your plan for user approval. Use for non-trivial implementation tasks that benefit from upfront design. No file writes or command execution are allowed in plan mode.',
  searchHint: 'plan mode design approach readonly explore before coding',
  isReadOnly: () => true,
  requiresApproval: () => false,
  maxResultSizeChars: 5_000,
  parameters: z.object({}),
  execute: async (_args: Record<string, never>, context) => {
    if (!context.setPermissionMode) {
      throw new Error('Plan mode is only available in the main interactive session (no mode-switch channel).')
    }
    if (context.getPermissionMode?.() === 'plan') {
      return 'Already in plan mode. Explore the codebase, design your approach, then call ExitPlanMode with your plan for user approval.'
    }
    context.setPermissionMode('plan')
    return [
      'Plan mode is now ACTIVE. In this mode:',
      '1. Explore the codebase (Read/Glob/Grep/LS are available) to understand existing patterns.',
      '2. Design an implementation approach — do NOT write or edit any files yet.',
      '3. When the design is complete, call ExitPlanMode with your plan to request user approval.',
      '',
      'Write tools and command execution are blocked by the permission system while in plan mode.',
    ].join('\n')
  },
}

export const exitPlanModeTool: AgentTool = {
  name: 'ExitPlanMode',
  aliases: ['exit_plan_mode'],
  description:
    'Submit your implementation plan for user approval and leave plan mode. Call ONLY after you have explored the code and finalized the plan (never for trivial one-line fixes). The user approves, edits, or rejects the plan.',
  searchHint: 'exit plan mode approval submit plan ready to code',
  isReadOnly: () => false, // 会切换权限模式；cc 同样因写盘标非只读
  requiresApproval: () => true,
  maxResultSizeChars: 10_000,
  parameters: z.object({
    plan: z.string().describe('The implementation plan to present for user approval (markdown)'),
    allowedPrompts: z
      .array(
        z.object({
          tool: z.enum(['Bash']),
          prompt: z.string().describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
        })
      )
      .optional()
      .describe('Prompt-based Bash permissions needed to implement the plan'),
  }),
  checkPermissions: async () => ({ behavior: 'ask' }),
  execute: async (
    args: { plan: string; allowedPrompts?: Array<{ tool: string; prompt: string }> },
    context
  ) => {
    const current = context.getPermissionMode?.()
    if (current !== 'plan') {
      throw new Error(`You are not in plan mode (current mode: ${current ?? 'unknown'}). Call EnterPlanMode first.`)
    }
    context.setPermissionMode?.('ask')

    const promptsNote =
      args.allowedPrompts && args.allowedPrompts.length > 0
        ? `\n\nApproved Bash scopes: ${args.allowedPrompts.map((p) => p.prompt).join('; ')}`
        : ''
    return [
      'User has approved your plan. You can now start coding.',
      'Start with updating your todo list if applicable, then implement.',
      '',
      '## Approved Plan:',
      args.plan,
      promptsNote,
    ].join('\n')
  },
}
