import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

const MAX_OUTPUT_LENGTH = 50000

export const runCommandTool: AgentTool = {
  // 1:1 cc 命名（R5）；旧名 run_command 等保留为别名兼容既有规则/会话
  name: 'Bash',
  aliases: ['run_command', 'bash', 'powershell', 'exec', 'sh'],
  description: 'Execute a shell command in the workspace. Streams output and captures stdout/stderr.',
  searchHint: 'execute terminal shell command in powershell or bash',
  interruptBehavior: () => 'cancel',
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  getActivityDescription: (args) => args?.command ? `Running "${args.command.slice(0, 40)}${args.command.length > 40 ? '...' : ''}"` : 'Running command',
  getToolUseSummary: (args) => args?.command ? `$ ${args.command}` : null,
  toAutoClassifierInput: (args) => args?.command || '',
  parameters: z.object({
    command: z.string().describe('The command line string to execute'),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Timeout in milliseconds (default 120000, max 600000)'),
    description: z
      .string()
      .optional()
      .describe('Clear, concise description of what this command does (5-10 words)'),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run the command in the background without blocking (poll via TaskOutput)'),
    dangerouslyDisableSandbox: z
      .boolean()
      .optional()
      .describe('Accepted for cc compatibility; no OS-level sandbox is enforced by this tool'),
  }),
  requiresApproval: () => true,
  execute: async (rawArgs, context) => {
    // R7 参数对齐：timeout（cc 名，默认 120s，上限 600s）；旧 timeoutMs 兼容
    const command = String(rawArgs.command)
    const timeout = Number(rawArgs.timeout ?? rawArgs.timeoutMs ?? process.env.BASH_DEFAULT_TIMEOUT_MS ?? 120000)
    const maxTimeout = Number(process.env.BASH_MAX_TIMEOUT_MS ?? 600000)
    const effectiveTimeout = Math.min(Number.isFinite(timeout) ? timeout : 120000, maxTimeout)

    // run_in_background：转后台任务注册表（1:1 cc），立即返回 taskId
    if (rawArgs.run_in_background) {
      const { startBackgroundTask } = await import('./taskTools')
      const started = startBackgroundTask(command, context.workspaceRoot, rawArgs.description)
      return `Background task started: ${started.id}
Command: ${command}
Use TaskOutput with task_id "${started.id}" to read output.`
    }

    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32'
      const shell = isWindows ? 'powershell.exe' : '/bin/bash'
      const shellArgs = isWindows ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command] : ['-c', command]

      let stdoutAccumulated = ''
      let stderrAccumulated = ''
      let killed = false

      const child = spawn(shell, shellArgs, {
        cwd: context.workspaceRoot,
        env: { ...process.env, PAGER: 'cat' },
        windowsHide: true
      })

      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 2000)
        reject(new Error(`Command timed out after ${effectiveTimeout}ms: "${command}"`))
      }, effectiveTimeout)

      if (context.signal) {
        context.signal.addEventListener('abort', () => {
          killed = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          reject(new Error(`Command aborted by user: "${command}"`))
        })
      }

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString('utf-8')
        context.emitTerminalOutput?.(text)
        if (stdoutAccumulated.length < MAX_OUTPUT_LENGTH) {
          stdoutAccumulated += text
        }
      })

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf-8')
        context.emitTerminalOutput?.(text)
        if (stderrAccumulated.length < MAX_OUTPUT_LENGTH) {
          stderrAccumulated += text
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        if (!killed) {
          reject(new Error(`Failed to start command: ${err.message}`))
        }
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (killed) return

        let output = ''
        if (stdoutAccumulated.trim()) {
          output += `STDOUT:\n${stdoutAccumulated.trim()}\n`
        }
        if (stderrAccumulated.trim()) {
          output += `STDERR:\n${stderrAccumulated.trim()}\n`
        }
        if (!output.trim()) {
          output = '(Command produced no output)\n'
        }

        // R7 大输出落盘（1:1 cc persisted-output）：超 30K 写入可回读文件而非丢失
        const totalLen = stdoutAccumulated.length + stderrAccumulated.length
        if (totalLen >= 30_000) {
          try {
            const outDir = path.join(context.workspaceRoot, '.nexus', 'outputs')
            fs.mkdirSync(outDir, { recursive: true })
            const outFile = path.join(outDir, `bash-${Date.now()}.log`)
            fs.writeFileSync(outFile, `STDOUT:\n${stdoutAccumulated}\nSTDERR:\n${stderrAccumulated}`, 'utf-8')
            output = output.slice(0, 30_000)
            output += `\n\n[Output truncated at 30000 of ${totalLen} characters. Full output persisted to: ${outFile}]`
          } catch {
            output += `\n[Warning: Output exceeded 30000 characters and was truncated]`
          }
        }

        output += `\nProcess exited with code: ${code}`

        if (code === 0) {
          resolve(output)
        } else {
          // 1:1 cc ShellError 语义：非零退出进入错误通道，模型直接看到失败
          reject(new Error(`${output}\nExit code: ${code}`))
        }
      })
    })
  }
}
