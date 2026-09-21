/**
 * Word 编辑器全局单实例宿主(计划 §6.4 前置3/§8.2):
 * Tiptap 编辑器是内存大头且内部依赖 window.__aidocs 全局单例——
 * 因此无论多少 word tab/pane,编辑器实例全局只挂载一份(React root 常驻),
 * 通过 DOM reparent"搬"进当前激活的 word pane;隐藏/切换不销毁状态。
 */

import { createRoot } from 'react-dom/client'
import { App as WordEditorApp } from '../components/word/App'
import { LocaleProvider } from '../components/word/i18n/locale'

let hostEl: HTMLDivElement | null = null
let mounted = false
let currentPath: string | null = null
let pathListenerInstalled = false

function ensurePathListener(): void {
  if (pathListenerInstalled || typeof window === 'undefined') return
  pathListenerInstalled = true
  window.addEventListener('nexus-word-file-opened', (e) => {
    const detail = (e as CustomEvent<{ filePath?: string }>).detail
    if (detail?.filePath) currentPath = detail.filePath
  })
}

function ensureMounted(): void {
  if (mounted || typeof document === 'undefined') return
  hostEl = document.createElement('div')
  hostEl.setAttribute('data-word-host', 'singleton')
  hostEl.style.width = '100%'
  hostEl.style.height = '100%'
  document.body.appendChild(hostEl)
  createRoot(hostEl).render(
    <LocaleProvider initial="zh">
      <WordEditorApp />
    </LocaleProvider>
  )
  mounted = true
  ensurePathListener()
}

/** 把单实例编辑器挂进指定容器(若已在别处则自动搬移);返回是否首次挂载 */
export function acquireWordHost(container: HTMLElement): void {
  ensureMounted()
  if (!hostEl) return
  if (hostEl.parentElement !== container) {
    container.appendChild(hostEl)
  }
  hostEl.style.display = 'block'
}

/** 从容器脱离并隐藏(不销毁,保活) */
export function hideWordHost(): void {
  if (hostEl) hostEl.style.display = 'none'
}

/** 打开指定路径(与当前不同才触发)。
 * 竞态修复:编辑器懒挂载(createRoot 异步 render),事件监听器可能尚未注册——
 * 优先走 __aidocs.openPath 直通 API;桥未就绪则轮询重试(≤4s),超时兜底事件。 */
export function openWordPath(path: string): void {
  ensureMounted()
  const w = window as unknown as Record<string, unknown>
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const tryOpen = (): boolean => {
    const aidocs = w.__aidocs as
      | { openPath?: (p: string) => void; getFilePath?: () => string | undefined; filePath?: string }
      | undefined
    const cur = (aidocs?.getFilePath ? aidocs.getFilePath() : aidocs?.filePath) ?? currentPath
    currentPath = cur
    if (cur && (cur === path || norm(cur) === norm(path))) return true
    if (aidocs?.openPath) {
      aidocs.openPath(path)
      currentPath = path
      return true
    }
    return false
  }
  if (tryOpen()) return
  const started = Date.now()
  const timer = setInterval(() => {
    const ok = tryOpen()
    if (ok || Date.now() - started > 4000) {
      clearInterval(timer)
      if (!ok) {
        window.dispatchEvent(new CustomEvent('nexus-word-open-file', { detail: { path } }))
      }
    }
  }, 150)
}

export function getWordCurrentPath(): string | null {
  ensureMounted()
  const aidocs = (window as unknown as Record<string, unknown>).__aidocs as
    | { getFilePath?: () => string | undefined; filePath?: string }
    | undefined
  currentPath = (aidocs?.getFilePath ? aidocs.getFilePath() : aidocs?.filePath) ?? currentPath
  return currentPath
}
