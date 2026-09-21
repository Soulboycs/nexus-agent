import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R6 AskUserQuestion（1:1 cc AskUserQuestionTool，复用 HITL 通道）：
 * checkPermissions 恒 ask → 触发 HITL；UI/用户经审批 updatedInput 回填
 * answers；工具 execute 输出作答文本。bypass/无审批回调时返回结构化提示，
 * 让模型基于 options 自行决策（cc 的 shouldAvoidPermissionPrompts 等价）。
 */

const questionOptionSchema = z.object({
  label: z.string().min(1).describe('The display text for this option (concise, 1-5 words)'),
  description: z.string().optional().describe('Explanation of what this option means'),
  preview: z.string().optional().describe('Optional preview content (e.g. code/mockup) for comparison'),
})

const questionSchema = z.object({
  question: z.string().min(1).describe('The complete question, ending with a question mark'),
  header: z.string().min(1).max(12).describe('Very short label shown as a chip/tag (max 12 chars)'),
  options: z.array(questionOptionSchema).min(2).max(4).describe('The available choices (2-4)'),
  multiSelect: z.boolean().optional().describe('Set true to allow multiple selections'),
})

export const askUserQuestionTool: AgentTool = {
  name: 'AskUserQuestion',
  aliases: ['ask_user_question', 'ask_user'],
  description:
    'Ask the user 1-4 structured questions with 2-4 options each. Use ONLY when you are blocked on a decision that is genuinely the user\'s to make and cannot resolve it from context. The user sees your questions in the approval dialog and answers via the option selector.',
  searchHint: 'ask user question clarify choice decision interactive',
  isReadOnly: () => true,
  requiresUserInteraction: true,
  maxResultSizeChars: 10_000,
  parameters: z.object({
    questions: z.array(questionSchema).min(1).max(4).describe('Questions to ask the user (1-4)'),
    answers: z
      .record(z.string(), z.string())
      .optional()
      .describe('User answers collected by the approval dialog, keyed by question text (filled by the UI, not by you)'),
    annotations: z
      .record(
        z.string(),
        z.object({
          preview: z.string().optional(),
          notes: z.string().optional(),
        })
      )
      .optional()
      .describe('Optional per-question user annotations (notes/preview selections), keyed by question text'),
  }),
  checkPermissions: async () => ({ behavior: 'ask' }),
  execute: async (args: {
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description?: string; preview?: string }>
      multiSelect?: boolean
    }>
    answers?: Record<string, string>
    annotations?: Record<string, { preview?: string; notes?: string }>
  }) => {
    // bypass 模式/子代理无审批回调：cc 等价行为是禁用交互——提示模型自行决策
    if (!args.answers || Object.keys(args.answers).length === 0) {
      return (
        'No interactive user available in this context (approval dialog disabled). ' +
        'Do NOT call AskUserQuestion again. Decide yourself using the options you proposed, state your choice explicitly, and continue.'
      )
    }

    const lines: string[] = []
    let answeredCount = 0
    for (const q of args.questions) {
      const answer = args.answers?.[q.question]
      if (!answer) continue
      answeredCount += 1
      lines.push(`"${q.question}"="${answer}"`)
      const annotation = args.annotations?.[q.question]
      // 附注行不计入 answered 计数
      if (annotation?.preview) lines.push(`  selected preview: ${annotation.preview.slice(0, 200)}`)
      if (annotation?.notes) lines.push(`  user notes: ${annotation.notes}`)
    }

    const answered = answeredCount
    const allAnswered = answered === args.questions.length
    const guidance = allAnswered
      ? 'Continue with these answers.'
      : 'Some questions were not answered — reconsider your approach given the missing information.'

    return `User has answered your questions:\n${lines.join('\n')}\n\n${guidance}`
  },
}
