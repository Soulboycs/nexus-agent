import { spawn, ChildProcess } from 'child_process'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R6/R7 Task 系列（1:1 cc TaskCreate/TaskList/TaskOutput/TaskStop，后台 shell
 * 任务核心版）：进程独立于 query 信号存活，输出环形缓冲（carry 半行缓冲）
 * 可回读。已披露简化：cc 的 agent 型任务（子代理后台）与完成通知回调未含。
 */

interface BackgroundTask {
  id: string
  description: string
  command: string
  proc?: ChildProcess
  output: string[]
  status: 'running' | 'completed' | 'failed' | 'stopped'
  exitCode: number | null
  createdAt: string
}

const MAX_LINES = 1000
const tasks = new Map<string, BackgroundTask>()

let taskCounter = 0
function nextTaskId(): string {
  taskCounter += 1
  return `task_${Date.now().toString(36)}_${taskCounter}`
}

function listTasks(): string {
  if (tasks.size === 0) return 'No background tasks.'
  return Array.from(tasks.values())
    .map(
      (t) =>
        `${t.id} [${t.status}] (exit=${t.exitCode ?? '—'}) ${t.description || t.command}`
    )
    .join('\n')
}

/** 启动后台 shell 任务（TaskCreate 与 Bash.run_in_background 共用） */
export function startBackgroundTask(
  command: string,
  workspaceRoot: string,
  description?: string
): { id: string } {
  const id = nextTaskId()
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'powershell.exe' : '/bin/bash'
  const shellArgs = isWindows
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command]

  const task: BackgroundTask = {
    id,
    description: description || command.slice(0, 60),
    command,
    output: [],
    status: 'running',
    exitCode: null,
    createdAt: new Date().toISOString(),
  }

  const child = spawn(shell, shellArgs, {
    cwd: workspaceRoot,
    env: { ...process.env, PAGER: 'cat' },
    windowsHide: true,
  })
  task.proc = child

  // Line-buffered push with carry：split 尾段跨 chunk 保留、\r 剥离。
  // 无 carry 时每个以换行结尾的 chunk 会把尾随空段推入环形缓冲，
  // 有效容量减半（复核发现）。
  let carry = ''
  const pushLine = (line: string) => {
    if (task.output.length >= MAX_LINES) task.output.shift()
    task.output.push(line)
  }
  const push = (chunk: Buffer | string) => {
    carry += chunk.toString()
    const parts = carry.split(/\r?\n/)
    carry = parts.pop() ?? ''
    for (const part of parts) {
      pushLine(part.replace(/\r$/, ''))
    }
  }
  const flush = () => {
    if (carry !== '') {
      pushLine(carry.replace(/\r$/, ''))
      carry = ''
    }
  }
  child.stdout?.on('data', push)
  child.stderr?.on('data', push)
  child.on('exit', (code) => {
    flush()
    task.exitCode = code
    task.status = code === 0 ? 'completed' : code === null ? 'stopped' : 'failed'
  })

  tasks.set(id, task)
  return { id }
}

/** 测试/清理钩子：终止全部在跑任务并清空注册表 */
export function stopAllBackgroundTasks(): void {
  for (const task of tasks.values()) {
    if (task.status === 'running') task.proc?.kill()
  }
  tasks.clear()
}

export const taskCreateTool: AgentTool = {
  name: 'TaskCreate',
  aliases: ['task_create', 'run_in_background'],
  description:
    'Start a long-running shell command in the BACKGROUND (dev servers, watchers, builds, test suites). Returns a task ID immediately; poll with TaskOutput and stop with TaskStop. The process keeps running across turns.',
  searchHint: 'background task long running server watcher dev server',
  isReadOnly: () => false,
  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 5_000,
  parameters: z.object({
    command: z.string().describe('The shell command to run in the background'),
    description: z.string().optional().describe('Short human-readable description, e.g. "dev server"'),
  }),
  execute: async ({ command, description }: { command: string; description?: string }, context) => {
    const started = startBackgroundTask(command, context.workspaceRoot, description)
    return [
      `Background task started: ${started.id}`,
      `Command: ${command}`,
      `Use TaskOutput with task_id "${started.id}" to read output, TaskStop to terminate, TaskList to see all tasks.`,
    ].join('\n')
  },
}

export const taskListTool: AgentTool = {
  name: 'TaskList',
  aliases: ['task_list'],
  description: 'List all background tasks with their IDs and statuses.',
  searchHint: 'list background tasks status',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 5_000,
  parameters: z.object({}),
  execute: async () => listTasks(),
}

export const taskOutputTool: AgentTool = {
  name: 'TaskOutput',
  aliases: ['task_output'],
  description:
    'Read the output of a background task. Returns the last N lines and the current status. Use TaskList first if you do not know the task ID.',
  searchHint: 'read background task output logs',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 50_000,
  parameters: z.object({
    taskId: z.string().describe('The task ID returned by TaskCreate'),
    lastLines: z.number().int().positive().max(500).default(100).describe('How many trailing lines to return'),
  }),
  execute: async ({ taskId, lastLines }: { taskId: string; lastLines: number }) => {
    const task = tasks.get(taskId)
    if (!task) {
      return `Task not found: ${taskId}.\n${listTasks()}`
    }
    const tail = task.output.slice(-lastLines).join('\n')
    return `Task ${taskId} [${task.status}] (exit=${task.exitCode ?? '—'})\n--- output (last ${Math.min(lastLines, task.output.length)} lines) ---\n${tail || '(no output yet)'}`
  },
}

export const taskStopTool: AgentTool = {
  name: 'TaskStop',
  aliases: ['task_stop'],
  description: 'Stop a running background task by its task ID.',
  searchHint: 'stop kill background task terminate',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 2_000,
  parameters: z.object({
    taskId: z.string().describe('The task ID to stop'),
  }),
  execute: async ({ taskId }: { taskId: string }) => {
    const task = tasks.get(taskId)
    if (!task) return `Task not found: ${taskId}.\n${listTasks()}`
    if (task.status !== 'running') {
      return `Task ${taskId} is not running (status: ${task.status}, exit=${task.exitCode ?? '—'}).`
    }
    task.proc?.kill()
    return `Stop signal sent to task ${taskId} (${task.command}).`
  },
}
