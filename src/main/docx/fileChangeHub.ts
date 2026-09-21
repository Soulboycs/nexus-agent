/**
 * FileChangeHub(计划 §6.4,R11 通知枢纽):
 * main 进程单例。工具两个写盘分支 + docs:save 成功后统一 notifyChanged;
 * 同路径 50ms 合并;广播 docs:file-changed(canonical key 形态路径)。
 * 渲染层联动(角标/跟随/lastTouch)唯一信号源。
 */
import { normalizeKeyPath } from '../../shared/paths'

type Send = (channel: string, payload: { filePath: string; source: string }) => void

interface HubOptions {
  /** IPC 出口(默认 electron webContents broadcast 由调用方注入) */
  send: Send
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export class FileChangeHub {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; source: string }>()
  private readonly lastSent = new Map<string, number>()
  private readonly send: Send
  private readonly now: () => number
  private readonly st: typeof setTimeout
  private readonly ct: typeof clearTimeout

  constructor(opts: HubOptions) {
    this.send = opts.send
    this.now = opts.now ?? Date.now
    this.st = opts.setTimeout ?? setTimeout
    this.ct = opts.clearTimeout ?? clearTimeout
  }

  /** 记录一次文件变更;同路径 50ms 内合并为一次广播 */
  notifyChanged(rawPath: string, source: 'tool' | 'editor' | 'external'): void {
    const key = normalizeKeyPath(rawPath)
    if (!key) return
    const t = this.now()
    const last = this.lastSent.get(key) ?? -Infinity
    if (t - last < 50) return // 抖动去重
    const existing = this.pending.get(key)
    if (existing) {
      this.ct(existing.timer)
    }
    const timer = this.st(() => {
      this.pending.delete(key)
      this.lastSent.set(key, this.now())
      this.send('docs:file-changed', { filePath: key, source })
    }, 50)
    this.pending.set(key, { timer, source })
  }

  pendingCount(): number {
    return this.pending.size
  }
}
