import React, { useState } from 'react'
import {
  collectAllPanes,
  clampNormalizedSizes,
  type GroupNode,
  type LayoutNode,
  type PaneState
} from './layout-model'
import { useLayoutStore } from './layout-store'
import { ResizeHandle } from './ResizeHandle'
import { RetainedPanel } from './RetainedPanel'
import { TabBar } from './TabBar'
import { TabContent } from './tab-registry'
import { bumpRenderCount } from '../utils/perfProbe'
import { PaneDropZone, DropPreviewOverlay } from './WorkspaceDnd'

export interface SplitRendererHostProps {
  /** TabBar "+" 新建会话(App 提供:创建 session → openTab) */
  onCreateChat?: () => void
  /** 分割语义(App 提供:新建会话 → splitPane 带该 target);缺省回退分屏同内容 */
  onSplit?: (position: 'left' | 'right' | 'top' | 'bottom', paneId: string) => void
}

/**
 * 布局树递归渲染器(计划 §4.4)。
 *
 * - group → flex row/column;子项 flexBasis:0 + minWidth/minHeight:0,
 *   宽度只由归一化 flexGrow 表达(hidden 子项 grow=0 + display:none 让位);
 * - 尺寸读取 stored ?? tree.sizes;拖宽走本地 preview 态覆盖(pointerup 才 commit store);
 * - ResizeHandle 只插在两个可见子项之间;
 * - pane → TabBar + RetainedPanel(tab 栈保活叠放)。
 */
export function SplitRenderer({ onCreateChat, onSplit }: SplitRendererHostProps) {
  const root = useLayoutStore((s) => s.layout.root)
  return (
    <div className="flex-1 min-w-0 min-h-0 flex" data-testid="split-renderer">
      <SplitNodeView node={root} onCreateChat={onCreateChat} onSplit={onSplit} />
    </div>
  )
}

function SplitNodeView({
  node,
  onCreateChat,
  onSplit
}: {
  node: LayoutNode
  onCreateChat?: () => void
  onSplit?: (position: 'left' | 'right' | 'top' | 'bottom', paneId: string) => void
}) {
  if (node.kind === 'group') {
    return <SplitGroupView group={node.group} onCreateChat={onCreateChat} onSplit={onSplit} />
  }
  return <SplitPaneView pane={node.pane} onCreateChat={onCreateChat} onSplit={onSplit} />
}

function SplitGroupView({
  group,
  onCreateChat,
  onSplit
}: {
  group: GroupNode
  onCreateChat?: () => void
  onSplit?: (position: 'left' | 'right' | 'top' | 'bottom', paneId: string) => void
}) {
  const stored = useLayoutStore((s) => s.sizesByGroupId[group.id])
  const base = stored ?? group.sizes
  // 本地预览态:拖动中覆盖 store 值,pointerup 才写 store(单一权威,§4.4)
  const [preview, setPreview] = useState<number[] | null>(null)
  const resizeSplit = useLayoutStore((s) => s.resizeSplit)

  const effective = preview ?? base
  const horizontal = group.direction === 'horizontal'

  const visibleIdx = group.children
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !(c.kind === 'pane' && c.pane.hidden === true))
  const visibleSum = visibleIdx.reduce((a, { i }) => a + (effective[i] ?? 1 / group.children.length), 0) || 1

  return (
    <div
      className={`flex min-w-0 min-h-0 flex-1 ${horizontal ? 'flex-row' : 'flex-col'}`}
      data-testid={`split-group-${group.id}`}
    >
      {group.children.map((child, i) => {
        const hidden = child.kind === 'pane' && child.pane.hidden === true
        const prev = i > 0 ? group.children[i - 1] : null
        const prevVisible = !!prev && !(prev.kind === 'pane' && prev.pane.hidden === true)
        const flex = hidden ? 0 : (effective[i] ?? 1 / group.children.length) / visibleSum
        return (
          <React.Fragment key={child.kind === 'pane' ? child.pane.id : child.group.id}>
            {i > 0 && !hidden && prevVisible && (
              <ResizeHandle
                direction={group.direction}
                index={i - 1}
                sizes={effective}
                onPreview={setPreview}
                onCommit={(finalSizes) => {
                  resizeSplit(group.id, finalSizes)
                  setPreview(null)
                }}
              />
            )}
            <div
              className="flex min-w-0 min-h-0"
              style={{
                flexBasis: 0,
                flexGrow: flex,
                flexShrink: 1,
                ...(horizontal ? { minWidth: 0 } : { minHeight: 0 }),
                ...(hidden ? { display: 'none' } : null)
              }}
              data-visible-group-child={!hidden}
            >
              <SplitNodeView node={child} onCreateChat={onCreateChat} onSplit={onSplit} />
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function SplitPaneView({
  pane,
  onCreateChat,
  onSplit
}: {
  pane: PaneState
  onCreateChat?: () => void
  onSplit?: (position: 'left' | 'right' | 'top' | 'bottom', paneId: string) => void
}) {
  const onRender = React.useCallback(
    (_id: string, _phase: string, actualDuration: number) => {
      if (import.meta.env.DEV) {
        // §8.3 验收计数:单 pane 流式时其余 pane 计数不增
        bumpRenderCount(pane.id)
        void actualDuration
      }
    },
    [pane.id]
  )
  const content = (
    <div
      data-testid={`pane-${pane.id}`}
      className="flex flex-col min-w-0 min-h-0 w-full bg-white relative"
    >
      <TabBar pane={pane} onCreateChat={onCreateChat} onSplit={onSplit} />
      <div className="flex-1 min-h-0 relative">
        {pane.tabs.map((tab) => (
          <RetainedPanel key={tab.tabId} active={pane.focusedTabId === tab.tabId}>
            <TabContent target={tab.target} active={pane.focusedTabId === tab.tabId} tabId={tab.tabId} />
          </RetainedPanel>
        ))}
        {/* Snap 拖拽(§5):落点命中区 + 半透明预览 */}
        <PaneDropZone paneId={pane.id} />
        <DropPreviewOverlay paneId={pane.id} />
      </div>
    </div>
  )
  if (!import.meta.env.DEV) return content
  return (
    <React.Profiler id={pane.id} onRender={onRender}>
      {content}
    </React.Profiler>
  )
}

/** 供 App 查询当前布局快照(诊断/测试辅助) */
export function getLayoutSnapshot() {
  const s = useLayoutStore.getState()
  return { panes: collectAllPanes(s.layout.root), sizes: s.sizesByGroupId, raw: clampNormalizedSizes([1]) }
}
