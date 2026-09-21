import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { AgentTool } from './ToolRegistry'

/**
 * R7 Cron 四件套（1:1 cc ScheduleCronTool 家族，核心版）：
 * 5 字段 cron（分 时 日 月 周）持久化于 <workspace>/.nexus/crons.json，
 * 注册表每分钟检查；到点且引擎空闲时触发注入的回调（engine.run(prompt)）。
 * 已披露简化：无 delayMinutes/maxRuns/时区语义、无自动化持久去重。
 */

export interface CronEntry {
  id: string
  prompt: string
  schedule: string
  createdAt: string
  lastFiredAt?: string
}

let cronRunnerCallback: ((prompt: string, schedule: string) => Promise<void>) | null = null
let checkerTimer: ReturnType<typeof setInterval> | null = null

export function registerCronRunner(
  workspaceRoot: string,
  callback: (prompt: string, schedule: string) => Promise<void>
): void {
  cronRunnerCallback = callback
  if (checkerTimer) return
  checkerTimer = setInterval(() => {
    void checkAndFire(workspaceRoot)
  }, 60_000)
  // 不阻止进程退出
  ;(checkerTimer as any).unref?.()
}

export function stopCronRunner(): void {
  if (checkerTimer) {
    clearInterval(checkerTimer)
    checkerTimer = null
  }
  cronRunnerCallback = null
}

function cronsFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.nexus', 'crons.json')
}

function loadCrons(workspaceRoot: string): CronEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cronsFile(workspaceRoot), 'utf-8'))
    return Array.isArray(parsed?.crons) ? parsed.crons : []
  } catch {
    return []
  }
}

function saveCrons(workspaceRoot: string, crons: CronEntry[]): void {
  const dir = path.join(workspaceRoot, '.nexus')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(cronsFile(workspaceRoot), JSON.stringify({ crons }, null, 2), 'utf-8')
}

export function validateCronSchedule(schedule: string): string | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return 'Cron schedule must have exactly 5 fields: minute hour day-of-month month day-of-week'
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  for (let i = 0; i < 5; i++) {
    const field = fields[i]
    if (field === '*') continue
    for (const part of field.split(',')) {
      const stepParts = part.split('/')
      const base = stepParts[0]
      const rangeForm = /^(\*|\d+)(-\d+)?$/.exec(base)
      if (!rangeForm) return `Invalid cron field "${field}" (position ${i + 1})`
      if (base !== '*') {
        const num = parseInt(base, 10)
        const [min, max] = ranges[i]
        const hi = base.includes('-') ? parseInt(base.split('-')[1], 10) : num
        if (num < min || hi > max) return `Cron field "${field}" out of range (${min}-${max}) at position ${i + 1}`
      }
      if (stepParts[1] !== undefined && !/^\d+$/.test(stepParts[1])) {
        return `Invalid step in cron field "${field}"`
      }
    }
  }
  return null
}

export function cronMatchesNow(schedule: string, now: Date): boolean {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const values = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()]
  for (let i = 0; i < 5; i++) {
    const field = fields[i]
    if (field === '*') continue
    const parts = field.split(',')
    const value = values[i]
    let hit = false
    for (const part of parts) {
      const [base, stepStr] = part.split('/')
      const step = stepStr ? parseInt(stepStr, 10) : 1
      let min = value
      let max = value
      if (base === '*') {
        const [min2, max2] = [
          [0, 59],
          [0, 23],
          [1, 31],
          [1, 12],
          [0, 6],
        ][i]
        min = min2
        max = max2
      } else if (base.includes('-')) {
        const [a, b] = base.split('-').map(Number)
        min = a
        max = b
      } else {
        min = max = parseInt(base, 10)
      }
      if (value >= min && value <= max && (value - min) % step === 0) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

export async function checkAndFire(workspaceRoot: string): Promise<string[]> {
  const fired: string[] = []
  if (!cronRunnerCallback) return fired
  const crons = loadCrons(workspaceRoot)
  const now = new Date()
  let dirty = false
  for (const cron of crons) {
    if (validateCronSchedule(cron.schedule)) continue
    if (cron.lastFiredAt && now.getTime() - new Date(cron.lastFiredAt).getTime() < 55_000) continue
    if (!cronMatchesNow(cron.schedule, now)) continue
    dirty = true
    cron.lastFiredAt = now.toISOString()
    fired.push(cron.id)
    try {
      await cronRunnerCallback(cron.prompt, cron.schedule)
    } catch (err) {
      console.error('[cron] runner failed for', cron.id, err)
    }
  }
  if (dirty) saveCrons(workspaceRoot, crons)
  return fired
}

function cronFields(partial: Record<string, unknown>, id: string) {
  return z.object({
    id: z.literal(id),
    prompt: z.string(),
    schedule: z.string(),
    createdAt: z.string(),
    lastFiredAt: z.string().optional(),
  }).parse(partial)
}

// ============ CronCreate ============
export const cronCreateTool: AgentTool = {
  name: 'CronCreate',
  aliases: ['cron_create', 'schedule_cron'],
  description:
    'Create a recurring scheduled task: when the 5-field cron schedule matches (minute hour day-of-month month day-of-week), the given prompt is submitted to the agent as a new user turn. Persists to .nexus/crons.json.',
  searchHint: 'schedule recurring cron timed task every',
  isReadOnly: () => false,
  requiresApproval: () => true,
  maxResultSizeChars: 3_000,
  parameters: z.object({
    prompt: z.string().min(1).describe('The prompt to submit to the agent when the schedule fires'),
    schedule: z
      .string()
      .describe('5-field cron schedule in local time: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5" = weekdays at 09:00)'),
  }),
  execute: async ({ prompt, schedule }: { prompt: string; schedule: string }, context) => {
    const invalid = validateCronSchedule(schedule)
    if (invalid) throw new Error(invalid)
    const crons = loadCrons(context.workspaceRoot)
    const entry: CronEntry = {
      id: `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      prompt,
      schedule,
      createdAt: new Date().toISOString(),
    }
    crons.push(entry)
    saveCrons(context.workspaceRoot, crons)
    return `Scheduled task created: ${entry.id}\nSchedule: ${schedule}\nPrompt: ${prompt}\nUse CronList to see it, CronDelete to remove it.`
  },
}

// ============ CronList ============
export const cronListTool: AgentTool = {
  name: 'CronList',
  aliases: ['cron_list'],
  description: 'List all scheduled cron tasks (id, schedule, prompt).',
  searchHint: 'list scheduled cron tasks',
  isReadOnly: () => true,
  maxResultSizeChars: 5_000,
  parameters: z.object({}),
  execute: async (_args: Record<string, never>, context) => {
    const crons = loadCrons(context.workspaceRoot)
    if (crons.length === 0) return 'No scheduled tasks.'
    return crons
      .map((c) => `${c.id} [${c.schedule}] (created ${c.createdAt}${c.lastFiredAt ? `, last fired ${c.lastFiredAt}` : ''})\n  prompt: ${c.prompt}`)
      .join('\n\n')
  },
}

// ============ CronDelete ============
export const cronDeleteTool: AgentTool = {
  name: 'CronDelete',
  aliases: ['cron_delete'],
  description: 'Delete a scheduled cron task by its id.',
  searchHint: 'delete scheduled cron task remove',
  isReadOnly: () => false,
  requiresApproval: () => false,
  maxResultSizeChars: 2_000,
  parameters: z.object({
    id: z.string().describe('The cron task id returned by CronCreate'),
  }),
  execute: async ({ id }: { id: string }, context) => {
    const crons = loadCrons(context.workspaceRoot)
    const remaining = crons.filter((c) => c.id !== id)
    if (remaining.length === crons.length) {
      throw new Error(`Cron task not found: ${id}. Use CronList to see existing tasks.`)
    }
    saveCrons(context.workspaceRoot, remaining)
    return `Deleted scheduled task ${id}. Remaining: ${remaining.length}.`
  },
}

// ============ CronUpdate ============
export const cronUpdateTool: AgentTool = {
  name: 'CronUpdate',
  aliases: ['cron_update'],
  description: 'Update an existing scheduled cron task (new prompt and/or schedule). Omitted fields keep their current values.',
  searchHint: 'update scheduled cron task reschedule',
  isReadOnly: () => false,
  requiresApproval: () => false,
  maxResultSizeChars: 3_000,
  parameters: z.object({
    id: z.string().describe('The cron task id to update'),
    prompt: z.string().optional().describe('New prompt'),
    schedule: z.string().optional().describe('New 5-field cron schedule'),
  }),
  execute: async ({ id, prompt, schedule }: { id: string; prompt?: string; schedule?: string }, context) => {
    const crons = loadCrons(context.workspaceRoot)
    const entry = crons.find((c) => c.id === id)
    if (!entry) throw new Error(`Cron task not found: ${id}. Use CronList to see existing tasks.`)
    if (schedule !== undefined) {
      const invalid = validateCronSchedule(schedule)
      if (invalid) throw new Error(invalid)
      entry.schedule = schedule
    }
    if (prompt !== undefined) entry.prompt = prompt
    saveCrons(context.workspaceRoot, crons)
    return `Updated scheduled task ${id}.\nSchedule: ${entry.schedule}\nPrompt: ${entry.prompt}`
  },
}
