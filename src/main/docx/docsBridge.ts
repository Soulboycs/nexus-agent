import type { BrowserWindow as BrowserWindowType } from 'electron'

let electronModule: any = null
try {
  electronModule = require('electron')
} catch {}

const ipcMain = electronModule?.ipcMain
const webContents = electronModule?.webContents

/**
 * Shell-main half of the MCP <-> docs-editor bridge.
 * Aligned 1:1 with GenOffice docs-bridge architecture.
 *
 * Drives the visible Word editor in the right-hand workbench drawer:
 * - Listens for docs:mcp-ready when Word editor mounts
 * - Pushes editor commands over docs:mcp-command
 * - Resolves matching docs:mcp-result
 * - Broadcasts focus and external file modification events
 */

const READY_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 60_000

interface PendingCommand {
  wcId: number
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const readyIds = new Set<number>()
interface ReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
}
const readyWaiters = new Map<number, ReadyWaiter[]>()
const watchedIds = new Set<number>()
const pending = new Map<string, PendingCommand>()
let requestSeq = 0
let installed = false
let getWinRef: (() => BrowserWindowType | null) | null = null

// R11 路径寻址(计划 §6.4):path(canonical key)→ 就绪实例。多文档多 pane 下命令不再广播。
import { normalizeKeyPath } from '../../shared/paths'
import { allowDocRoot } from '../agent/sandbox/SandboxGuard'
const wcIdByDocPath = new Map<string, number>()
const docPathsByWcId = new Map<number, Set<string>>()

function registerDocPath(wcId: number, rawPath: unknown): void {
  if (typeof rawPath !== 'string' || !rawPath) return
  try {
    const pathMod = require('path') as typeof import('path')
    const abs = pathMod.resolve(rawPath)
    allowDocRoot(pathMod.dirname(abs))
    // §6.3 canonical 接线:realpath 消解 8.3 短名/软链/规范大小写,注册双 key(语法形+canonical)
    import('fs/promises')
      .then((fs) => fs.realpath(abs))
      .then((real) => {
        for (const k of new Set([normalizeKeyPath(rawPath), normalizeKeyPath(real)])) {
          wcIdByDocPath.set(k, wcId)
          docPathsByWcId.get(wcId)?.add(k)
        }
      })
      .catch(() => {})
  } catch {}
  const key = normalizeKeyPath(rawPath)
  wcIdByDocPath.set(key, wcId)
  let set = docPathsByWcId.get(wcId)
  if (!set) {
    set = new Set()
    docPathsByWcId.set(wcId, set)
  }
  set.add(key)
}

function unregisterWcPaths(wcId: number): void {
  const set = docPathsByWcId.get(wcId)
  if (set) {
    for (const key of set) {
      if (wcIdByDocPath.get(key) === wcId) wcIdByDocPath.delete(key)
    }
    docPathsByWcId.delete(wcId)
  }
}

function takeWaiters(wcId: number): ReadyWaiter[] {
  const waiters = readyWaiters.get(wcId) ?? []
  readyWaiters.delete(wcId)
  return waiters
}

function markReady(wcId: number): void {
  readyIds.add(wcId)
  for (const waiter of takeWaiters(wcId)) waiter.resolve()
}

function watchDestroyed(wcId: number): void {
  if (!webContents || watchedIds.has(wcId)) return
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return
  watchedIds.add(wcId)
  wc.once('destroyed', () => {
    watchedIds.delete(wcId)
    readyIds.delete(wcId)
    unregisterWcPaths(wcId)
    const closed = new Error('The document editor was closed')
    for (const waiter of takeWaiters(wcId)) waiter.reject(closed)
    for (const [requestId, entry] of pending) {
      if (entry.wcId !== wcId) continue
      pending.delete(requestId)
      clearTimeout(entry.timer)
      entry.reject(closed)
    }
  })
}

export function isDocsEditorReady(): boolean {
  if (!webContents) return false
  for (const id of readyIds) {
    const wc = webContents.fromId(id)
    if (wc && !wc.isDestroyed()) return true
  }
  return false
}

export function getActiveDocsWcId(): number | null {
  if (!webContents) return null
  for (const id of readyIds) {
    const wc = webContents.fromId(id)
    if (wc && !wc.isDestroyed()) return id
  }
  return null
}

export function waitForReady(wcId: number, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  if (readyIds.has(wcId)) return Promise.resolve()
  if (!webContents) return Promise.reject(new Error('WebContents is not available'))
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return Promise.reject(new Error('The document editor is not available'))
  watchDestroyed(wcId)
  return new Promise((resolve, reject) => {
    const waiters = readyWaiters.get(wcId) ?? []
    const timer = setTimeout(() => {
      const list = readyWaiters.get(wcId)
      if (list) {
        const at = list.indexOf(waiter)
        if (at >= 0) list.splice(at, 1)
        if (list.length === 0) readyWaiters.delete(wcId)
      }
      reject(new Error(`The document editor did not become ready within ${timeoutMs}ms`))
    }, timeoutMs)
    const waiter: ReadyWaiter = {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    }
    waiters.push(waiter)
    readyWaiters.set(wcId, waiters)
  })
}

/** Register the reply listeners. Safe to call more than once. */
export function installDocsBridge(getWin: () => BrowserWindowType | null): void {
  getWinRef = getWin
  if (installed || !ipcMain) return
  installed = true

  ipcMain.on('docs:mcp-ready', (event: any, info: unknown) => {
    const wcId = event.sender.id
    markReady(wcId)
    watchDestroyed(wcId)
    registerDocPath(wcId, (info as { path?: unknown } | null)?.path)
  })

  ipcMain.on('docs:mcp-result', (event: any, result: unknown) => {
    const payload = result as {
      requestId?: unknown
      ok?: unknown
      result?: unknown
      error?: unknown
    }
    if (!payload || typeof payload.requestId !== 'string') return
    const entry = pending.get(payload.requestId)
    if (!entry) return
    if (entry.wcId !== event.sender.id) return
    pending.delete(payload.requestId)
    clearTimeout(entry.timer)
    if (payload.ok === true) {
      entry.resolve(payload.result)
    } else {
      entry.reject(new Error(typeof payload.error === 'string' ? payload.error : 'Command failed'))
    }
  })
}

/**
 * Execute a command on the live Word editor in the renderer.
 */
export async function runDocsCommand(command: string, payload: unknown, targetWcId?: number): Promise<unknown> {
  const wcId = targetWcId ?? getActiveDocsWcId()
  if (!wcId) {
    throw new Error('No active Word editor instance is ready')
  }
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    throw new Error('The target Word editor is no longer open')
  }

  const requestId = `mcp-${++requestSeq}`
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`The document command "${command}" timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)
    pending.set(requestId, { wcId, resolve, reject, timer })
  })

  wc.send('docs:mcp-command', { requestId, command, payload })
  return result
}

/**
 * 按路径寻址的 live 命令(R11,禁跨文档覆写):
 * 只发给"当前打开的就是该文档"的实例;无实例 → 立即抛错(工具走离线分支)。
 * 实例端还会校验 targetPath 与自身文档一致,双重保险。
 */
export async function runDocsCommandForPath(
  command: string,
  docPath: string,
  payload: unknown
): Promise<unknown> {
  let key = normalizeKeyPath(docPath)
  let wcId = wcIdByDocPath.get(key)
  if (!wcId) {
    // canonical 兜底:语法形未命中 → 尝试 realpath 后再查(短名/软链变体)
    try {
      const pathMod = require('path') as typeof import('path')
      const fs = await import('fs/promises')
      const real = await fs.realpath(pathMod.resolve(docPath))
      key = normalizeKeyPath(real)
      wcId = wcIdByDocPath.get(key)
    } catch {}
  }
  if (!wcId) {
    throw new Error(`NO_LIVE_EDITOR_FOR_PATH:${docPath}`)
  }
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    unregisterWcPaths(wcId)
    throw new Error(`NO_LIVE_EDITOR_FOR_PATH:${docPath}`)
  }
  const requestId = `mcp-${++requestSeq}`
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`The document command "${command}" timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)
    pending.set(requestId, { wcId, resolve, reject, timer })
  })
  wc.send('docs:mcp-command', { requestId, command, payload, targetPath: key })
  return result
}

/**
 * Notify the UI to open the right-side Word drawer and focus the given file.
 */
export function notifyFocusWordDoc(filePath: string): void {
  const win = getWinRef?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:word-focus', { filePath })
  }
}

/**
 * Notify the Word editor that a file was modified on disk so it can reload.
 * 统一经 FileChangeHub(50ms 合并 + canonical key),联动层唯一信号源。
 */
import { FileChangeHub } from './fileChangeHub'
let hub: FileChangeHub | null = null
function getHub(): FileChangeHub {
  if (!hub) {
    hub = new FileChangeHub({
      send: (channel, payload) => {
        const win = getWinRef?.()
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      }
    })
  }
  return hub
}

export function notifyWordFileChanged(filePath: string): void {
  getHub().notifyChanged(filePath, 'tool')
}

/** docs:save/save-as 成功后的通知入口(编辑器保存路径) */
export function notifyDocsSavedByEditor(filePath: string): void {
  getHub().notifyChanged(filePath, 'editor')
}
