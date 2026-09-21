import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'

/**
 * 常驻管道 shell(T1 终端 pane 后端):
 * - cmd.exe /Q(禁自身回显)+ /K(保持驻留),cd 在进程内持续生效;
 * - 渲染端行模式本地回显(见 TerminalView),回车整行送达这里;
 * - 单实例:drawer 与 pane 共享同一 shell 输出流(v1 语义)。
 * 已知限制(诚实):无 TTY,交互式全屏程序(vim 等)不可用;仅命令行交互。
 */
let child: ChildProcess | null = null
let broadcast: ((data: string) => void) | null = null
let shellCwd = process.cwd()

function ensureShell(): void {
  if (child) return
  const comspec = process.env.COMSPEC || 'cmd.exe'
  try {
    child = spawn(comspec, ['/Q', '/K'], { cwd: shellCwd, windowsHide: true })
  } catch {
    child = null
    broadcast?.('\r\n[terminal] failed to spawn shell\r\n')
    return
  }
  broadcast?.(`\r\n[Antigravity Shell] ${shellCwd}\r\n`)
  const push = (d: Buffer) => {
    const text = d.toString()
    broadcast?.(text.endsWith('\n') ? text : text + '\n')
  }
  child.stdout?.on('data', push)
  child.stderr?.on('data', push)
  child.on('exit', () => {
    child = null
    broadcast?.('\r\n[shell exited]\r\n')
  })
}

export function killShell(): void {
  child?.kill()
  child = null
}

/** 安装桥接:输入来自 preload terminal:input(整行);输出广播 terminal:data */
export function installTerminalBridge(
  ipc: { on(channel: string, fn: (event: unknown, data: unknown) => void): void },
  send: (data: string) => void,
  getCwd: () => string
): void {
  broadcast = send
  shellCwd = getCwd() || shellCwd
  ensureShell()
  ipc.on('terminal:input', (_event, data: unknown) => {
    const line = typeof data === 'string' ? data.trim() : ''
    if (!line) return
    const m = /^cd\s+(.+)$/i.exec(line)
    if (m) {
      const target = m[1].replace(/^"|"$/g, '')
      shellCwd = path.isAbsolute(target) ? path.normalize(target) : path.resolve(shellCwd, target)
    }
    ensureShell()
    if (child) shellCwd = shellCwd // cd 由 shell 进程内生效;此处同步记录用于新 shell
    broadcast?.(`${line}\n`)
    child?.stdin?.write(line + '\r\n')
  })
}
