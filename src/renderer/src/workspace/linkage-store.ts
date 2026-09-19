import { create } from 'zustand'
import { normalizeKeyPath } from '@shared/paths'

/**
 * 联动层状态(计划 §6.3/6.5,D4 零配置文件跟随):
 * - pathToTab:文档路径(canonical)→ tabId,唯一实例路由表;
 * - lastTouch:文档路径 → 最近操作的 sessionId(问 AI 反向路由,last-writer-wins);
 * - updatedPaths:后台被 agent 改动、尚未查看的文档(角标);
 * - followPaused / suppressedPaths:取消联动(§6.5);
 * - panePreference:会话上次打开文档的 pane(落位记忆)。
 * 绑定全部是引用,永不进 prompt(L0)。
 */

interface LinkageState {
  pathToTab: Record<string, string>
  lastTouch: Record<string, string>
  updatedPaths: Record<string, boolean>
  followPaused: Record<string, boolean>
  suppressedPaths: Record<string, boolean>
  panePreference: Record<string, string>
  registerWordTab(tabId: string, rawPath: string): void
  unregisterWordTab(tabId: string): void
  setLastTouch(rawPath: string, sessionId: string): void
  clearLastTouch(rawPath: string): void
  markUpdated(rawPath: string): void
  clearUpdated(rawPath: string): void
  isUpdated(rawPath: string): boolean
  isSuppressed(rawPath: string): boolean
  setFollowPaused(tabId: string, paused: boolean): void
  suppress(rawPath: string): void
  setPanePreference(sessionId: string, paneId: string): void
  bootstrapFromLegacy(): void
  resetForTest(): void
}

export const useLinkageStore = create<LinkageState>()((set, get) => ({
  pathToTab: {},
  lastTouch: {},
  updatedPaths: {},
  followPaused: {},
  suppressedPaths: {},
  panePreference: {},

  registerWordTab(tabId, rawPath) {
    const key = normalizeKeyPath(rawPath)
    if (!key) return
    set({ pathToTab: { ...get().pathToTab, [key]: tabId } })
  },

  unregisterWordTab(tabId) {
    const next = { ...get().pathToTab }
    for (const [k, v] of Object.entries(next)) {
      if (v === tabId) delete next[k]
    }
    set({ pathToTab: next })
  },

  setLastTouch(rawPath, sessionId) {
    const key = normalizeKeyPath(rawPath)
    if (!key) return
    set({ lastTouch: { ...get().lastTouch, [key]: sessionId } })
  },

  clearLastTouch(rawPath) {
    const key = normalizeKeyPath(rawPath)
    const next = { ...get().lastTouch }
    delete next[key]
    set({ lastTouch: next })
  },

  markUpdated(rawPath) {
    const key = normalizeKeyPath(rawPath)
    set({ updatedPaths: { ...get().updatedPaths, [key]: true } })
  },

  clearUpdated(rawPath) {
    const key = normalizeKeyPath(rawPath)
    const next = { ...get().updatedPaths }
    delete next[key]
    set({ updatedPaths: next })
  },

  isUpdated(rawPath) {
    return get().updatedPaths[normalizeKeyPath(rawPath)] === true
  },

  isSuppressed(rawPath) {
    return get().suppressedPaths[normalizeKeyPath(rawPath)] === true
  },

  setFollowPaused(tabId, paused) {
    const next = { ...get().followPaused, [tabId]: paused }
    if (!paused) delete next[tabId]
    set({ followPaused: next })
  },

  suppress(rawPath) {
    const key = normalizeKeyPath(rawPath)
    set({ suppressedPaths: { ...get().suppressedPaths, [key]: true } })
  },

  setPanePreference(sessionId, paneId) {
    set({ panePreference: { ...get().panePreference, [sessionId]: paneId } })
  },

  bootstrapFromLegacy() {
    try {
      const raw = localStorage.getItem('nexus_session_word_docs')
      if (!raw) return
      const map = JSON.parse(raw) as Record<string, string>
      const lastTouch = { ...get().lastTouch }
      for (const [sessionId, path] of Object.entries(map)) {
        if (typeof path === 'string') lastTouch[normalizeKeyPath(path)] = sessionId
      }
      set({ lastTouch })
    } catch {
      // 坏数据逐 key 容忍:整体跳过,不阻塞启动
    }
  },

  resetForTest() {
    set({ pathToTab: {}, lastTouch: {}, updatedPaths: {}, followPaused: {}, suppressedPaths: {}, panePreference: {} })
  }
}))

// ── 持久化(§4.4 LinkageState 独立 key):记忆/抑制/落位偏好重启保留;路由表由 tab 挂载重建 ──
const LS_KEY = 'nexus_linkage_v1'
const hasLS = typeof globalThis !== 'undefined' && (globalThis as any).localStorage
if (hasLS) {
  try {
    const raw = (globalThis as any).localStorage.getItem(LS_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      useLinkageStore.setState({
        lastTouch: d.lastTouch ?? {},
        suppressedPaths: d.suppressedPaths ?? {},
        panePreference: d.panePreference ?? {}
      })
    }
  } catch {}
  useLinkageStore.subscribe((s) => {
    try {
      ;(globalThis as any).localStorage.setItem(
        LS_KEY,
        JSON.stringify({ lastTouch: s.lastTouch, suppressedPaths: s.suppressedPaths, panePreference: s.panePreference })
      )
    } catch {}
  })
}
