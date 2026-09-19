/**
 * Word 编辑器全局单实例宿主(计划 §6.4 前置3/§8.2):
 * Tiptap 编辑器是内存大头且内部依赖 window.__aidocs 全局单例——
 * 因此无论多少 word tab/pane,编辑器实例全局只挂载一份(React root 常驻),
 * 通过 DOM reparent"搬"进当前激活的 word pane;隐藏/切换不销毁状态。
 */

import { createRoot } from 'react-dom/client'
import { App as WordEditorApp } from '../components/word/App'

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
  createRoot(hostEl).render(<WordEditorApp />)
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

/** 打开指定路径(与当前不同才触发) */
export function openWordPath(path: string): void {
  ensureMounted()
  const aidocs = (window as unknown as Record<string, unknown>).__aidocs as
    | { openPath?: (p: string) => void; getFilePath?: () => string | undefined; filePath?: string }
    | undefined
  currentPath = (aidocs?.getFilePath ? aidocs.getFilePath() : aidocs?.filePath) ?? currentPath
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  if (!(currentPath && (currentPath === path || norm(currentPath) === norm(path)))) {
    window.dispatchEvent(new CustomEvent('nexus-word-open-file', { detail: { path } }))
    currentPath = path
  }
}

export function getWordCurrentPath(): string | null {
  ensureMounted()
  const aidocs = (window as unknown as Record<string, unknown>).__aidocs as
    | { getFilePath?: () => string | undefined; filePath?: string }
    | undefined
  currentPath = (aidocs?.getFilePath ? aidocs.getFilePath() : aidocs?.filePath) ?? currentPath
  return currentPath
}
