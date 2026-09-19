import { spawn } from 'child_process'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

const MAX_OUTPUT_LENGTH = 50000

export const runCommandTool: AgentTool = {
  name: 'run_command',
  aliases: ['bash', 'powershell', 'exec', 'sh'],
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
    timeoutMs: z.number().int().positive().default(30000).describe('Timeout in milliseconds (default 30s)')
  }),
  requiresApproval: () => true,
  execute: async ({ command, timeoutMs }, context) => {
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
        reject(new Error(`Command timed out after ${timeoutMs}ms: "${command}"`))
      }, timeoutMs)

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

        output += `Process exited with code: ${code}`

        if (stdoutAccumulated.length >= MAX_OUTPUT_LENGTH || stderrAccumulated.length >= MAX_OUTPUT_LENGTH) {
          output += `\n[Warning: Output exceeded ${MAX_OUTPUT_LENGTH} characters and was truncated]`
        }

        if (code === 0) {
          resolve(output)
        } else {
          resolve(output) // We resolve with exit code so agent can inspect stderr and decide to fix
        }
      })
    })
  }
}
