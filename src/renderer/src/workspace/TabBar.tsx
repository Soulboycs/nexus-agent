import React from 'react'
import { Plus, X, SplitSquareHorizontal, SplitSquareVertical, MoreHorizontal, MessageSquare, FileText, TerminalSquare, Globe, ListChecks } from 'lucide-react'
import { resolveTabBarMode, type TabBarMode } from './drag-geometry'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { PaneState, SplitPosition, TabTarget } from './layout-model'
import { getTabTitle } from './tab-registry'
import { useLayoutStore } from './layout-store'
import { useLinkageStore } from './linkage-store'
import { useSessionMetaStore } from './session-meta'
import { useDndUI } from './WorkspaceDnd'
import { normalizeKeyPath } from '@shared/paths'

/**
 * pane 顶部 tab 行(计划 §5.4):横向滚动 chip(不做测量制),
 * "+"新建会话、Split Right/Down、Close pane。点击 chip 切换聚焦 tab。
 */
export function TabBar({
  pane,
  onCreateChat,
  onSplit,
  className = ''
}: {
  pane: PaneState
  onCreateChat?: () => void
  /** 分割语义(App 提供:新建会话开进新格子);缺省回退"分屏同内容" */
  onSplit?: (position: SplitPosition, paneId: string) => void
  className?: string
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [ctxMenu, setCtxMenu] = React.useState<{ tabId: string; x: number; y: number } | null>(null)
  const linkage = useLinkageStore
  const resetLayout = useLayoutStore((s) => s.resetLayout)
  // 分级自适应(M5):宽度驱动形态,× 永远可见
  const barRef = React.useRef<HTMLDivElement>(null)
  const [mode, setMode] = React.useState<TabBarMode>('comfortable')
  React.useEffect(() => {
    const el = barRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      setMode(resolveTabBarMode(entries[0]?.contentRect.width ?? 999))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const ctxWordPath = React.useMemo(() => {
    if (!ctxMenu) return null
    const t = pane.tabs.find((x) => x.tabId === ctxMenu.tabId)
    return t && t.target.kind === 'word' ? t.target.path : null
  }, [ctxMenu, pane])
  const toggleFollow = (tid: string) => {
    const st = linkage.getState()
    const cur = st.followPaused[tid] === true
    st.setFollowPaused(tid, !cur)
  }
  const suppressDoc = (tid: string) => {
    const t = pane.tabs.find((x) => x.tabId === tid)
    if (t && t.target.kind === 'word') linkage.getState().suppress(t.target.path)
  }
  const clearTouch = (tid: string) => {
    const t = pane.tabs.find((x) => x.tabId === tid)
    if (t && t.target.kind === 'word') linkage.getState().clearLastTouch(t.target.path)
  }
  const splitPane = useLayoutStore((s) => s.splitPane)
  const closeTab = useLayoutStore((s) => s.closeTab)
  const closePane = useLayoutStore((s) => s.closePane)
  const doSplit = (position: SplitPosition) => {
    if (onSplit) onSplit(position, pane.id)
    else splitPane(pane.id, position, {})
  }
  const runCtxClose = (tabId: string) => {
    const p = useLayoutStore.getState().layout
    void p
    const tabCount = pane.tabs.length
    if (tabCount > 1) closeTab(tabId)
    else closePane(pane.id)
  }
  const runCtxOthers = (p: PaneState, tabId: string) => {
    for (const t of p.tabs) if (t.tabId !== tabId) closeTab(t.tabId)
  }
  const runCtxRight = (p: PaneState, tabId: string) => {
    const idx = p.tabs.findIndex((t) => t.tabId === tabId)
    for (let i = p.tabs.length - 1; i > idx; i--) closeTab(p.tabs[i].tabId)
  }

  return (
    <div
      ref={barRef}
      data-testid={`tabbar-${pane.id}`}
      className={`flex items-stretch h-9 shrink-0 border-b border-neutral-200 bg-neutral-50 select-none ${className}`}
    >
      <div className="flex items-stretch flex-1 overflow-x-auto min-w-0">
        {pane.tabs.map((tab, idx) => (
          <DraggableChip
            key={tab.tabId}
            pane={pane}
            tabId={tab.tabId}
            tabIndex={idx}
            mode={mode}
            onContextMenuTab={(tabId, x, y) => setCtxMenu({ tabId, x, y })}
          />
        ))}
      </div>
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white shadow-lg py-1 text-xs" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button type="button" data-testid="ctx-close" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { runCtxClose(ctxMenu.tabId); setCtxMenu(null) }}>关闭</button>
            <button type="button" data-testid="ctx-close-others" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { runCtxOthers(pane, ctxMenu.tabId); setCtxMenu(null) }}>关闭其他</button>
            <button type="button" data-testid="ctx-close-right" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { runCtxRight(pane, ctxMenu.tabId); setCtxMenu(null) }}>关闭右侧</button>
            {ctxWordPath && (
              <>
                <div className="my-1 border-t border-neutral-100" />
                <button type="button" data-testid="ctx-toggle-follow" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { toggleFollow(ctxMenu.tabId); setCtxMenu(null) }}>
                  {(ctxMenu && linkage.getState().followPaused[ctxMenu.tabId]) ? '恢复跟随' : '暂停跟随'}
                </button>
                <button type="button" data-testid="ctx-suppress" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { suppressDoc(ctxMenu.tabId); setCtxMenu(null) }}>不再自动打开</button>
                <button type="button" data-testid="ctx-clear-touch" className="w-full text-left px-3 py-1.5 hover:bg-neutral-100" onClick={() => { clearTouch(ctxMenu.tabId); setCtxMenu(null) }}>清除最近操作记忆</button>
              </>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-0.5 px-1.5 shrink-0">
        <button
          type="button"
          aria-label="New chat tab"
          data-testid="new-chat-tab"
          title="新建会话"
          onClick={() => onCreateChat?.()}
          className="p-1.5 rounded hover:bg-neutral-200/70 text-neutral-500"
        >
          <Plus className="w-4 h-4" />
        </button>
        {mode === 'comfortable' && (
          <>
            <button
              type="button"
              aria-label="Split right"
              data-testid={`split-right-btn-${pane.id}`}
              title="右侧分割(新会话)"
              onClick={() => doSplit('right')}
              className="p-1.5 rounded hover:bg-neutral-200/70 text-neutral-500"
            >
              <SplitSquareHorizontal className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Split down"
              data-testid={`split-down-btn-${pane.id}`}
              title="下方分割(新会话)"
              onClick={() => doSplit('bottom')}
              className="p-1.5 rounded hover:bg-neutral-200/70 text-neutral-500"
            >
              <SplitSquareVertical className="w-4 h-4" />
            </button>
          </>
        )}
        <div className="relative">
          <button
            type="button"
            aria-label="Pane menu"
            data-testid={`pane-menu-${pane.id}`}
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1.5 rounded hover:bg-neutral-200/70 text-neutral-500"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-neutral-200 bg-white shadow-lg py-1 text-xs"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                data-testid="menu-split-right"
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 flex items-center gap-2"
                onClick={() => {
                  setMenuOpen(false)
                  doSplit('right')
                }}
              >
                <SplitSquareHorizontal className="w-3.5 h-3.5" /> 右侧分割(新会话)
              </button>
              <button
                type="button"
                data-testid="menu-split-down"
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 flex items-center gap-2"
                onClick={() => {
                  setMenuOpen(false)
                  doSplit('bottom')
                }}
              >
                <SplitSquareVertical className="w-3.5 h-3.5" /> 下方分割(新会话)
              </button>
              <div className="my-1 border-t border-neutral-100" />
              <button
                type="button"
                data-testid="menu-close-pane"
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-red-600 flex items-center gap-2"
                onClick={() => {
                  setMenuOpen(false)
                  closePane(pane.id)
                }}
              >
                <X className="w-3.5 h-3.5" /> 关闭此窗格
              </button>
              <div className="my-1 border-t border-neutral-100" />
              <button
                type="button"
                data-testid="menu-reset-layout"
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-neutral-600"
                onClick={() => {
                  setMenuOpen(false)
                  resetLayout()
                }}
              >
                重置整个布局(回到单窗格)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export type { SplitPosition, TabTarget }

/**
 * 可拖 tab chip(§5):useDraggable(源)+ useDroppable(chip 级落点,插到它旁边)。
 * PointerSensor distance 8 保证点击选择不被拖拽吞掉;拖后 250ms 内的 click 吞掉(R15)。
 */
const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  chat: MessageSquare,
  word: FileText,
  terminal: TerminalSquare,
  browser: Globe,
  review: ListChecks
}

function DraggableChip({
  pane,
  tabId,
  mode = 'comfortable',
  onContextMenuTab
}: {
  pane: PaneState
  tabId: string
  tabIndex: number
  mode?: TabBarMode
  onContextMenuTab?: (tabId: string, x: number, y: number) => void
}) {
  const tab = pane.tabs.find((t) => t.tabId === tabId)!
  const active = pane.focusedTabId === tabId
  const selectTab = useLayoutStore((s) => s.selectTab)
  // word 角标(§6.2 规则3):后台被 agent 改动 → 亮点;激活即清
  const isWord = tab.target.kind === 'word'
  const wordPath = isWord ? (tab.target as { path: string }).path : ''
  const hasUpdate = useLinkageStore((s) =>
    isWord ? s.updatedPaths[normalizeKeyPath(wordPath)] === true : false
  )
  const clearUpdated = useLinkageStore((s) => s.clearUpdated)
  const closeTab = useLayoutStore((s) => s.closeTab)
  const closePane = useLayoutStore((s) => s.closePane)

  const drag = useDraggable({
    id: `tab:${tabId}`,
    data: { payload: { kind: 'tab', tabId } }
  })
  const drop = useDroppable({
    id: `chip:${tabId}`,
    data: { kind: 'tab-chip', paneId: pane.id, tabId }
  })
  useSessionMetaStore((s) => s.version) // 标题元数据变化时重渲染(所见即所@)
  const justDraggedRef = React.useRef(0)
  React.useEffect(() => {
    if (drag.isDragging) justDraggedRef.current = Date.now()
  }, [drag.isDragging])
  // §5.2 chip 插入 pill:4px 竖条,依 before/after 定位
  const { preview } = useDndUI()
  const pillSide =
    preview && 'kind' in preview && preview.kind === 'chip' && preview.paneId === pane.id && preview.tabId === tabId
      ? preview.before ? 'left' : 'right'
      : null

  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      data-testid={`tab-${tabId}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenuTab?.(tabId, e.clientX, e.clientY)
      }}
      onClick={() => {
        if (Date.now() - justDraggedRef.current < 250) return // R15:拖后 click 吞掉
        selectTab(pane.id, tabId)
        if (isWord) clearUpdated(wordPath)
      }}
      className={[
        'group relative flex items-center gap-1.5 my-1 mx-0.5 rounded-md cursor-pointer whitespace-nowrap text-xs',
        mode === 'tiny' ? 'justify-center px-1' : 'pl-3 pr-2',
        active
          ? 'bg-white border border-neutral-300 shadow-xs text-neutral-900'
          : 'text-neutral-500 hover:bg-neutral-200/60',
        drag.isDragging ? 'opacity-30' : ''
      ].join(' ')}
      style={{ minWidth: mode === 'tiny' ? 44 : 64, maxWidth: 160 }}
    >
      {pillSide && (
        <span
          data-testid={`pill-${tabId}-${pillSide}`}
          className={`absolute top-1 bottom-1 w-[3px] rounded bg-blue-500 ${pillSide === 'left' ? '-left-[3px]' : '-right-[3px]'}`}
        />
      )}
      {mode === 'tiny' ? (
        <span ref={drop.setNodeRef} className="flex items-center" title={getTabTitle(tab.target)}>
          {(() => {
            const Icon = KIND_ICON[tab.target.kind] ?? MessageSquare
            return <Icon className="w-3.5 h-3.5" />
          })()}
        </span>
      ) : (
        <span ref={drop.setNodeRef} className="truncate flex-1" title={getTabTitle(tab.target)}>
          {getTabTitle(tab.target)}
        </span>
      )}
      {hasUpdate && <span data-testid={`badge-${tabId}`} className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 animate-pulse" />}
      <button
        type="button"
        aria-label="Close tab"
        data-testid={`close-tab-${tabId}`}
        onClick={(e) => {
          e.stopPropagation()
          // 多 tab → 关本 tab;单 tab → 关本 pane(最后一个可见 pane 由 R3 守门拒绝)
          if (pane.tabs.length > 1) closeTab(tabId)
          else closePane(pane.id)
        }}
        title="关闭标签页"
        className="shrink-0 text-neutral-400 hover:text-red-500 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
