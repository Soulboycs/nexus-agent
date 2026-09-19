import React, { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  pointerWithin
} from '@dnd-kit/core'
import { collectAllPanes, type LayoutNode, type SplitPosition, type TabTarget } from './layout-model'
import { useLayoutStore } from './layout-store'
import { resolveSplitDropPosition, type SplitDropPosition } from './drag-geometry'
import { getTabTitle } from './tab-registry'

/** 统一拖拽数据协议(§5.1,D8:所有 tab 一视同仁) */
export type DragPayload =
  | { kind: 'target'; target: TabTarget } // 侧栏条目/落地页来源(未必已开)
  | { kind: 'tab'; tabId: string } // 已打开的 tab chip

export interface DndUIState {
  preview: { paneId: string; position: SplitDropPosition } | null
  active: { title: string } | null
}

const DndUIContext = React.createContext<DndUIState>({ preview: null, active: null })
export const useDndUI = () => React.useContext(DndUIContext)

export function findTabTitle(root: LayoutNode, tabId: string): string {
  for (const p of collectAllPanes(root)) {
    const t = p.tabs.find((x) => x.tabId === tabId)
    if (t) return getTabTitle(t.target)
  }
  return 'Tab'
}

/** tab chip 行优先于 pane 落点,pane 落点优先于侧栏;无兜底=指针在一切之外即取消 */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const by = (k: string) =>
    hits.filter((h) => (h.data?.droppableContainer.data.current as { kind?: string } | undefined)?.kind === k)
  return by('tab-chip').length ? by('tab-chip') : by('pane-drop').length ? by('pane-drop') : by('sidebar-section')
}

/**
 * 工作区统一拖拽域(§5):
 * - 全应用唯一 DndContext(Sidebar 与 SplitRenderer 同域);
 * - drop 才写 store,拖拽过程零布局写入;预览状态经 DndUIContext 下发;
 * - 语义:pane 边缘=split(被拖 tab 带入)/中央=堆叠、chip=插到该 chip 旁、侧栏=收回。
 */
export function WorkspaceDnd({ children }: { children: React.ReactNode }) {
  const [preview, setPreview] = useState<DndUIState['preview']>(null)
  const [active, setActive] = useState<DndUIState['active']>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const onDragStart = (e: DragStartEvent) => {
    const payload = e.active.data.current?.payload as DragPayload | undefined
    if (!payload) return
    const title =
      payload.kind === 'tab'
        ? findTabTitle(useLayoutStore.getState().layout.root, payload.tabId)
        : getTabTitle(payload.target)
    setActive({ title })
  }

  const onDragOver = (e: DragOverEvent) => {
    const over = e.over?.data.current as { kind?: string; paneId?: string; rect?: DOMRect } | undefined
    if (!over || over.kind !== 'pane-drop' || !over.paneId || !e.over?.rect) {
      setPreview(null)
      return
    }
    // 位置判定用被拖物中心(指针已选定 pane)
    const r = e.over.rect
    const tr = e.active.rect.current.translated
    const ax = tr ? tr.left + tr.width / 2 : r.left + r.width / 2
    const ay = tr ? tr.top + tr.height / 2 : r.top + r.height / 2
    const position = resolveSplitDropPosition(ax, ay, { x: r.left, y: r.top, width: r.width, height: r.height })
    setPreview({ paneId: over.paneId, position })
  }

  const onDragEnd = (e: DragEndEvent) => {
    setPreview(null)
    setActive(null)
    const payload = e.active.data.current?.payload as DragPayload | undefined
    if (!payload) return
    const store = useLayoutStore.getState()
    const over = e.over?.data.current as
      | { kind?: string; paneId?: string; tabId?: string }
      | undefined
    if (!over) return

    if (over.kind === 'sidebar-section') {
      // 收回:tab → 关 tab(级联/守门由模型保证);侧栏条目落到侧栏=无操作
      if (payload.kind === 'tab') store.closeTab(payload.tabId)
      return
    }

    if (over.kind === 'tab-chip' && over.paneId && over.tabId) {
      if (payload.kind === 'tab') {
        store.moveTabToPane(payload.tabId, over.paneId, over.tabId) // 插到该 chip 之后
      } else {
        store.openTab(payload.target, { paneId: over.paneId, afterTabId: over.tabId })
      }
      return
    }

    if (over.kind === 'pane-drop' && over.paneId) {
      const r = (e.over!.rect as DOMRect) ?? null
      if (r) {
        const ax = e.active.rect.current.translated
          ? e.active.rect.current.translated!.left + e.active.rect.current.translated!.width / 2
          : r.left + r.width / 2
        const ay = e.active.rect.current.translated
          ? e.active.rect.current.translated!.top + e.active.rect.current.translated!.height / 2
          : r.top + r.height / 2
        const position = resolveSplitDropPosition(ax, ay, {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height
        })
        if (position === 'center') {
          if (payload.kind === 'tab') store.moveTabToPane(payload.tabId, over.paneId)
          else store.openTab(payload.target, { paneId: over.paneId })
          return
        }
        // 边缘:split,被拖内容带入新 pane
        if (payload.kind === 'tab') store.splitPane(over.paneId, position, { tabId: payload.tabId })
        else store.splitPane(over.paneId, position, { target: payload.target })
      }
    }
  }

  const ui = useMemo(() => ({ preview, active }), [preview, active])

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <DndUIContext.Provider value={ui}>{children}</DndUIContext.Provider>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div className="px-2.5 py-1 rounded-md bg-white border border-blue-300 shadow-lg text-xs text-neutral-700 select-none">
            {active.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** pane 落点覆盖层(纯几何命中,dnd-kit 按注册 rect 计算,无需真实指针事件) */
export function PaneDropZone({ paneId }: { paneId: string }) {
  const { setNodeRef } = useDroppable({
    id: `pane-drop:${paneId}`,
    data: { kind: 'pane-drop', paneId }
  })
  return <div ref={setNodeRef} className="absolute inset-0 z-30 pointer-events-none" data-testid={`drop-zone-${paneId}`} />
}

/** Snap 预览(两层:半透明填充 + 描边;§5.2) */
export function DropPreviewOverlay({ paneId }: { paneId: string }) {
  const { preview } = useDndUI()
  if (!preview || preview.paneId !== paneId) return null
  const p = preview.position
  const style: React.CSSProperties =
    p === 'left'
      ? { left: 0, top: 0, bottom: 0, width: '50%' }
      : p === 'right'
        ? { right: 0, top: 0, bottom: 0, width: '50%' }
        : p === 'top'
          ? { left: 0, right: 0, top: 0, height: '50%' }
          : p === 'bottom'
            ? { left: 0, right: 0, bottom: 0, height: '50%' }
            : { inset: 8 }
  return (
    <div className="absolute inset-0 z-40 pointer-events-none" data-testid={`drop-preview-${paneId}`}>
      <div className="absolute bg-blue-400/25 border-2 border-blue-400 rounded-md" style={style} />
    </div>
  )
}

/** 侧栏收纳区(任意 tab 拖回=收回,§5.2);整区高亮由内部 useDroppable isOver 驱动 */
export function SidebarDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'sidebar-section', data: { kind: 'sidebar-section' } })
  return (
    <div ref={setNodeRef} className={isOver ? 'ring-2 ring-inset ring-blue-300' : ''} data-testid="sidebar-drop-zone">
      {children}
    </div>
  )
}

export type { SplitPosition, TabTarget, LayoutNode }
