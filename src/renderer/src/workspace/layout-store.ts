import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { z } from 'zod'
import {
  clampNormalizedSizes,
  closePaneInLayout,
  closeTabInLayout,
  createDefaultLayout,
  findPaneById,
  focusPaneInLayout,
  moveTabToPaneInLayout,
  normalizeLayout,
  openTabInLayout,
  reorderTabsInPaneInLayout,
  retargetTabInLayout,
  selectTabInPaneInLayout,
  setPaneHiddenInLayout,
  splitPaneInLayout,
  collectAllPanes,
  type LayoutIds,
  type LayoutState,
  type SplitPosition,
  type TabTarget,
  type WorkspaceLayout
} from './layout-model'

export const LAYOUT_PERSIST_KEY = 'nexus_workspace_layout'
const LAYOUT_PERSIST_VERSION = 1
const BOOT_SESSION_ID = '__boot__'

// ─── 持久化校验(zod strict 信封 + normalizeLayout 逐节点打捞,计划 §4.4)───

const LayoutPersistedSchema = z
  .object({
    version: z.literal(LAYOUT_PERSIST_VERSION),
    layout: z.unknown(),
    sizesByGroupId: z.record(z.string(), z.array(z.number()))
  })
  .strict()

export interface ValidatedPersistedLayout {
  layout: WorkspaceLayout
  sizesByGroupId: Record<string, number[]>
}

/** 持久化信封校验:任何信封级失败 → null(调用方回默认布局);结构内语义脏由 normalizeLayout 打捞 */
export function validatePersisted(raw: unknown): ValidatedPersistedLayout | null {
  const parsed = LayoutPersistedSchema.safeParse(raw)
  if (!parsed.success) return null
  const layout = normalizeLayout(parsed.data.layout)
  if (!layout) return null
  const sizesByGroupId: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(parsed.data.sizesByGroupId)) {
    if (Array.isArray(v) && v.length > 0 && v.every((n) => Number.isFinite(n))) {
      sizesByGroupId[k] = clampNormalizedSizes(v)
    }
  }
  return { layout, sizesByGroupId }
}

// ─── Store ──────────────────────────────────────────────────

interface LayoutStoreState extends LayoutState {
  hydrated: boolean
  openTab(target: TabTarget, opts?: { paneId?: string; afterTabId?: string }): string | null
  splitPane(
    paneId: string,
    position: SplitPosition,
    payload?: { tabId?: string; target?: TabTarget }
  ): string | null
  moveTabToPane(tabId: string, toPaneId: string, afterTabId?: string, front?: boolean): boolean
  reorderTabsInPane(paneId: string, tabIds: string[]): boolean
  closeTab(tabId: string): boolean
  closePane(paneId: string): boolean
  setPaneHidden(paneId: string, hidden: boolean): boolean
  focusPane(paneId: string): void
  selectTab(paneId: string, tabId: string): void
  /** new_tab 落地页 → 用户选定内容(原位替换 target) */
  retargetTab(tabId: string, target: TabTarget): boolean
  resizeSplit(groupId: string, sizes: number[]): void
  /** 启动迁移:把 __boot__ 占位 tab 指向真实会话(幂等) */
  bootstrapSession(sessionId: string): void
  /** 一键重置:回到单 chat pane(保留当前聚焦会话) */
  resetLayout(): void
  setHydrated(): void
}

let idCounter = 0
const ids: LayoutIds = {
  tab: () => `tab_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`,
  pane: () => `pane_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`,
  group: () => `grp_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`
}

function initialState(): LayoutState {
  return createDefaultLayout({ kind: 'chat', sessionId: BOOT_SESSION_ID }, ids)
}

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set, get) => ({
      ...initialState(),
      hydrated: false,

      openTab(target, opts) {
        const next = openTabInLayout(get().layout, target, opts, ids)
        if (!next) return null
        set({ layout: next })
        // 返回聚焦 tab 的 id
        for (const p of collectAllPanes(next.root)) {
          if (p.id === next.focusedPaneId) return p.focusedTabId
        }
        return null
      },

      splitPane(paneId, position, payload) {
        let p = payload
        if (!p || (p.tabId === undefined && p.target === undefined)) {
          // 空载荷 = 分屏同内容(VS Code 语义):克隆聚焦 tab 的 target
          const pane = findPaneById(get().layout.root, paneId)
          const focused = pane?.tabs.find((t) => t.tabId === pane.focusedTabId)
          if (!focused) return null
          p = { target: focused.target }
        }
        const r = splitPaneInLayout(get(), paneId, position, p, ids)
        if (!r) return null
        set(r.state)
        return r.paneId
      },

      moveTabToPane(tabId, toPaneId, afterTabId, front) {
        const next = moveTabToPaneInLayout(get(), tabId, toPaneId, afterTabId, front)
        if (!next) return false
        set(next)
        return true
      },

      reorderTabsInPane(paneId, tabIds) {
        const next = reorderTabsInPaneInLayout(get().layout, paneId, tabIds)
        if (!next) return false
        set({ layout: next })
        return true
      },

      closeTab(tabId) {
        const next = closeTabInLayout(get(), tabId)
        if (!next) return false
        set(next)
        return true
      },

      closePane(paneId) {
        const next = closePaneInLayout(get(), paneId)
        if (!next) return false
        set(next)
        return true
      },

      setPaneHidden(paneId, hidden) {
        const next = setPaneHiddenInLayout(get(), paneId, hidden)
        if (!next) return false
        set(next)
        return true
      },

      focusPane(paneId) {
        set({ layout: focusPaneInLayout(get().layout, paneId) })
      },

      selectTab(paneId, tabId) {
        set({ layout: selectTabInPaneInLayout(get().layout, paneId, tabId) })
      },

      retargetTab(tabId, target) {
        const next = retargetTabInLayout(get().layout, tabId, target)
        if (!next) return false
        set({ layout: next })
        return true
      },

      resizeSplit(groupId, sizes) {
        set({
          sizesByGroupId: {
            ...get().sizesByGroupId,
            [groupId]: clampNormalizedSizes(sizes)
          }
        })
      },

      bootstrapSession(sessionId) {
        const st = get()
        // 已有真实会话 tab → 幂等返回
        const hasReal = collectAllPanes(st.layout.root).some((p) =>
          p.tabs.some((t) => t.target.kind === 'chat' && t.target.sessionId === sessionId)
        )
        if (hasReal) return
        // 把 __boot__ 占位 tab 原地替换为真实会话
        for (const p of collectAllPanes(st.layout.root)) {
          const boot = p.tabs.find(
            (t) => t.target.kind === 'chat' && (t.target as { sessionId: string }).sessionId === BOOT_SESSION_ID
          )
          if (boot) {
            const tabs = p.tabs.map((t) =>
              t.tabId === boot.tabId ? { ...t, target: { kind: 'chat' as const, sessionId } } : t
            )
            set({ layout: replaceTabsInPane(st.layout, p.id, tabs) })
            return
          }
        }
        // 无占位(异常恢复)→ 常规打开
        get().openTab({ kind: 'chat', sessionId })
      },

      resetLayout() {
        const st = get()
        const focused = collectAllPanes(st.layout.root)
          .flatMap((x) => x.tabs)
          .find((t) => t.tabId === collectAllPanes(st.layout.root).find((x) => x.id === st.layout.focusedPaneId)?.focusedTabId)
        const target =
          focused && focused.target.kind === 'chat'
            ? focused.target
            : st.layout.root.kind === 'group'
              ? undefined
              : undefined
        const chatSession =
          target && 'sessionId' in target
            ? target.sessionId
            : collectAllPanes(st.layout.root)
                .map((x) => x.tabs.find((t) => t.target.kind === 'chat'))
                .filter(Boolean)
                .map((t) => (t!.target as { sessionId: string }).sessionId)[0]
        set(createDefaultLayout({ kind: 'chat', sessionId: chatSession || '__boot__' }, ids))
      },

      setHydrated() {
        set({ hydrated: true })
      }
    }),
    {
      name: LAYOUT_PERSIST_KEY,
      version: LAYOUT_PERSIST_VERSION,
      storage: createJSONStorage(() => {
        // node 测试环境无 localStorage → no-op storage(bun 门禁可跑;真实持久化在 Electron 生效)
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {}
        }
      }),
      partialize: (s) => ({
        version: LAYOUT_PERSIST_VERSION,
        layout: s.layout,
        sizesByGroupId: s.sizesByGroupId
      }),
      merge: (persisted, current) => {
        const v = validatePersisted(persisted)
        if (!v) return current // 信封级失败 → 默认布局(R2)
        return { ...current, ...v }
      }
    }
  )
)

function replaceTabsInPane(
  layout: WorkspaceLayout,
  paneId: string,
  tabs: import('./layout-model').PaneTab[]
): WorkspaceLayout {
  const rewrite = (node: WorkspaceLayout['root']): WorkspaceLayout['root'] => {
    if (node.kind === 'pane') {
      return node.pane.id === paneId ? { kind: 'pane', pane: { ...node.pane, tabs } } : node
    }
    return {
      kind: 'group',
      group: { ...node.group, children: node.group.children.map(rewrite) }
    }
  }
  return { ...layout, root: rewrite(layout.root) }
}
