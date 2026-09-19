/**
 * 多 pane 布局树纯函数(计划 §4.1/4.3,契约 CONTRACT-P1-S2)。
 *
 * 设计要点(全部有测试锁定):
 * - 结构共享:未被操作触及的 pane/group 节点保持引用不变(R1 不 remount 的基础);
 * - 尺寸存树外(sizesByGroupId):split/remove 改变 group children 数量时同步 splice;
 * - 不变量 pane.tabs ≥ 1;最后可见 pane 只能 hide 不能 close(R3);group 深度 ≤ 4(R4);
 * - 根恒为合成 group(R1b):裸 pane root 首次 split 会整树 remount。
 */

export type TabTarget =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'word'; path: string }
  /** 内容选择落地页(分割/新建的初始态,由用户决定变成什么) */
  | { kind: 'new_tab' }
  | { kind: 'terminal' }
  | { kind: 'browser'; startUrl?: string }
  | { kind: 'review'; workspacePath?: string }

export type LayoutDirection = 'horizontal' | 'vertical'
export type SplitPosition = 'left' | 'right' | 'top' | 'bottom'

export interface PaneTab {
  tabId: string
  target: TabTarget
  createdAt: number
}

export interface PaneState {
  id: string
  tabs: PaneTab[]
  focusedTabId: string | null
  hidden?: boolean
}

export interface GroupNode {
  id: string
  direction: LayoutDirection
  children: LayoutNode[]
  sizes: number[]
}

export type LayoutNode =
  | { kind: 'pane'; pane: PaneState }
  | { kind: 'group'; group: GroupNode }

export interface WorkspaceLayout {
  root: LayoutNode
  focusedPaneId: string | null
}

export interface LayoutState {
  layout: WorkspaceLayout
  sizesByGroupId: Record<string, number[]>
}

export interface LayoutIds {
  tab(): string
  pane(): string
  group(): string
}

export const MAX_TREE_DEPTH = 4
export const MIN_SPLIT_SIZE = 0.1
const ROOT_GROUP_ID = 'root'

// ─── 查询助手 ───────────────────────────────────────────────

export function collectAllPanes(node: LayoutNode): PaneState[] {
  if (node.kind === 'pane') return [node.pane]
  const out: PaneState[] = []
  for (const c of node.group.children) out.push(...collectAllPanes(c))
  return out
}

export function findPaneById(node: LayoutNode, paneId: string): PaneState | null {
  if (node.kind === 'pane') return node.pane.id === paneId ? node.pane : null
  for (const c of node.group.children) {
    const hit = findPaneById(c, paneId)
    if (hit) return hit
  }
  return null
}

interface PaneLocation {
  parentGroup: GroupNode | null // null = 目标是根节点
  index: number
}

function locatePane(root: LayoutNode, paneId: string): PaneLocation | null {
  if (root.kind === 'pane') {
    return root.pane.id === paneId ? { parentGroup: null, index: 0 } : null
  }
  for (let i = 0; i < root.group.children.length; i++) {
    const c = root.group.children[i]
    if (c.kind === 'pane' && c.pane.id === paneId) return { parentGroup: root.group, index: i }
    const deep = locatePane(c, paneId)
    if (deep) return deep
  }
  return null
}

function findTab(root: LayoutNode, tabId: string): { pane: PaneState } | null {
  for (const p of collectAllPanes(root)) {
    if (p.tabs.some((t) => t.tabId === tabId)) return { pane: p }
  }
  return null
}

function countVisiblePanes(node: LayoutNode): number {
  if (node.kind === 'pane') return node.pane.hidden === true ? 0 : 1
  return node.group.children.reduce((a, c) => a + countVisiblePanes(c), 0)
}

function groupDepth(node: LayoutNode): number {
  if (node.kind === 'pane') return 0
  return 1 + Math.max(0, ...node.group.children.map(groupDepth))
}

function collectGroupIds(node: LayoutNode, into: Set<string>): void {
  if (node.kind === 'pane') return
  into.add(node.group.id)
  for (const c of node.group.children) collectGroupIds(c, into)
}

export function equalTargets(a: TabTarget, b: TabTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'chat' && b.kind === 'chat') return a.sessionId === b.sessionId
  if (a.kind === 'word' && b.kind === 'word') return a.path === b.path
  return false
}

// ─── 不可变更新原语(路径拷贝,未触及节点保持引用) ─────────────

function mapGroup(root: LayoutNode, groupId: string, fn: (g: GroupNode) => GroupNode): LayoutNode {
  if (root.kind === 'pane') return root
  if (root.group.id === groupId) return { kind: 'group', group: fn(root.group) }
  return {
    kind: 'group',
    group: { ...root.group, children: root.group.children.map((c) => mapGroup(c, groupId, fn)) }
  }
}

function mapPane(root: LayoutNode, paneId: string, fn: (p: PaneState) => PaneState): LayoutNode {
  if (root.kind === 'pane') return root.pane.id === paneId ? { kind: 'pane', pane: fn(root.pane) } : root
  return {
    kind: 'group',
    group: { ...root.group, children: root.group.children.map((c) => mapPane(c, paneId, fn)) }
  }
}

function firstVisiblePaneId(root: LayoutNode): string | null {
  const vis = collectAllPanes(root).filter((p) => p.hidden !== true)
  return (vis[0] ?? collectAllPanes(root)[0])?.id ?? null
}

// ─── 创建 ───────────────────────────────────────────────────

export function createDefaultLayout(target: TabTarget, ids: LayoutIds): LayoutState {
  const paneId = ids.pane()
  const tabId = ids.tab()
  const pane: PaneState = {
    id: paneId,
    tabs: [{ tabId, target, createdAt: Date.now() }],
    focusedTabId: tabId
  }
  return {
    layout: {
      root: { kind: 'group', group: { id: ROOT_GROUP_ID, direction: 'horizontal', children: [{ kind: 'pane', pane }], sizes: [1] } },
      focusedPaneId: paneId
    },
    sizesByGroupId: {}
  }
}

// ─── layout-only 操作 ────────────────────────────────────────

/** 打开 tab:同 target 去重(只 select+focus);否则新建并聚焦 */
export function openTabInLayout(
  layout: WorkspaceLayout,
  target: TabTarget,
  opts: { paneId?: string; afterTabId?: string } = {},
  ids: LayoutIds
): WorkspaceLayout | null {
  // 去重:已存在同 target 的 tab → 只选中+聚焦
  for (const pane of collectAllPanes(layout.root)) {
    const hit = pane.tabs.find((t) => equalTargets(t.target, target))
    if (hit) {
      const sel = selectTabInPaneInLayout(layout, pane.id, hit.tabId)
      return focusPaneInLayout(sel, pane.id)
    }
  }
  const targetPaneId = opts.paneId ?? layout.focusedPaneId
  if (!targetPaneId) return null
  const pane = findPaneById(layout.root, targetPaneId)
  if (!pane) return null
  let insertAt = pane.tabs.length
  if (opts.afterTabId !== undefined) {
    const i = pane.tabs.findIndex((t) => t.tabId === opts.afterTabId)
    if (i < 0) return null
    insertAt = i + 1
  }
  const newTab: PaneTab = { tabId: ids.tab(), target, createdAt: Date.now() }
  let next = mapPane(layout.root, pane.id, (p) => ({
    ...p,
    tabs: [...p.tabs.slice(0, insertAt), newTab, ...p.tabs.slice(insertAt)],
    focusedTabId: newTab.tabId
  }))
  return focusPaneInLayout({ ...layout, root: next }, pane.id)
}

export function focusPaneInLayout(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (!findPaneById(layout.root, paneId)) return layout
  return layout.focusedPaneId === paneId ? layout : { ...layout, focusedPaneId: paneId }
}

/** 原位替换某 tab 的 target(new_tab 落地页 → 用户选定内容);tabId 不存在 → null */
export function retargetTabInLayout(
  layout: WorkspaceLayout,
  tabId: string,
  target: TabTarget
): WorkspaceLayout | null {
  const hit = findTab(layout.root, tabId)
  if (!hit) return null
  return {
    ...layout,
    root: mapPane(layout.root, hit.pane.id, (p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t.tabId === tabId ? { ...t, target, createdAt: Date.now() } : t))
    }))
  }
}

export function selectTabInPaneInLayout(
  layout: WorkspaceLayout,
  paneId: string,
  tabId: string
): WorkspaceLayout {
  const pane = findPaneById(layout.root, paneId)
  if (!pane || !pane.tabs.some((t) => t.tabId === tabId)) return layout
  if (pane.focusedTabId === tabId) return layout
  return { ...layout, root: mapPane(layout.root, paneId, (p) => ({ ...p, focusedTabId: tabId })) }
}

/** 行内重排;tabIds 必须是当前 pane tab 集合的排列,否则 null(fail-closed) */
export function reorderTabsInPaneInLayout(
  layout: WorkspaceLayout,
  paneId: string,
  tabIds: string[]
): WorkspaceLayout | null {
  const pane = findPaneById(layout.root, paneId)
  if (!pane) return null
  const current = new Set(pane.tabs.map((t) => t.tabId))
  if (tabIds.length !== current.size || tabIds.some((id) => !current.has(id))) return null
  const byId = new Map(pane.tabs.map((t) => [t.tabId, t] as const))
  return {
    ...layout,
    root: mapPane(layout.root, paneId, (p) => ({
      ...p,
      tabs: tabIds.map((id) => byId.get(id)!)
    }))
  }
}

// ─── 尺寸 ───────────────────────────────────────────────────

export function clampNormalizedSizes(sizes: number[], min = MIN_SPLIT_SIZE): number[] {
  const n = sizes.length
  if (n === 0) return []
  if (n * min >= 1) return new Array(n).fill(1 / n)
  let out = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 1 / n))
  const sum = out.reduce((a, b) => a + b, 0) || 1
  out = out.map((s) => s / sum)
  const locked = new Array<boolean>(n).fill(false)
  for (;;) {
    let changed = false
    for (let i = 0; i < n; i++) {
      if (!locked[i] && out[i] < min) {
        out[i] = min
        locked[i] = true
        changed = true
      }
    }
    if (!changed) break
    const freeIdx: number[] = []
    let freeSum = 0
    let lockedCount = 0
    for (let i = 0; i < n; i++) {
      if (locked[i]) lockedCount++
      else {
        freeIdx.push(i)
        freeSum += out[i]
      }
    }
    const target = 1 - min * lockedCount
    if (freeSum > 0) {
      const scale = target / freeSum
      for (const i of freeIdx) out[i] = out[i] * scale
    } else {
      for (const i of freeIdx) out[i] = target / freeIdx.length
    }
  }
  const finalSum = out.reduce((a, b) => a + b, 0) || 1
  return out.map((s) => s / finalSum)
}

function spliceHalfSlot(sizes: number[], index: number, insertAfter: boolean): number[] {
  const half = sizes[index] / 2
  const out = [...sizes]
  out[index] = half
  out.splice(insertAfter ? index + 1 : index, 0, half)
  return out
}

function renormalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return sizes.map(() => 1 / sizes.length)
  return sizes.map((s) => s / sum)
}

// ─── split ──────────────────────────────────────────────────

/**
 * 分割 pane。payload 二选一:tabId=移动该 tab 进新 pane;target=新建 tab。
 * 同向(父 group 方向与 position 一致)→ 父内相邻插入、槽位对半;
 * 垂直 → 包裹进新 group [P, new] / [new, P](父 children 数不变)。
 * 超过 MAX_TREE_DEPTH → null(R4)。
 */
export function splitPaneInLayout(
  state: LayoutState,
  paneId: string,
  position: SplitPosition,
  payload: { tabId?: string; target?: TabTarget },
  ids: LayoutIds
): { state: LayoutState; paneId: string } | null {
  const hasTab = payload.tabId !== undefined
  const hasTarget = payload.target !== undefined
  if (hasTab === hasTarget) return null // 恰好一个
  if (hasTab && !findTab(state.layout.root, payload.tabId!)) return null
  if (!findPaneById(state.layout.root, paneId)) return null

  const direction: LayoutDirection = position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
  const insertAfter = position === 'right' || position === 'bottom'
  const newTab: PaneTab | null = hasTarget
    ? { tabId: ids.tab(), target: payload.target!, createdAt: Date.now() }
    : null
  const newPane: PaneState = {
    id: ids.pane(),
    tabs: newTab ? [newTab] : [],
    focusedTabId: newTab?.tabId ?? null
  }

  const loc = locatePane(state.layout.root, paneId)!
  let nextRoot: LayoutNode
  let nextSizes = { ...state.sizesByGroupId }

  if (loc.parentGroup !== null && loc.parentGroup.direction === direction) {
    // 同向:父 group 内相邻插入,槽位对半(树内 + 树外同步)
    const gid = loc.parentGroup.id
    const idx = loc.index
    nextRoot = mapGroup(state.layout.root, gid, (g) => {
      const children = [...g.children]
      children.splice(insertAfter ? idx + 1 : idx, 0, { kind: 'pane', pane: newPane })
      return { ...g, children, sizes: clampNormalizedSizes(spliceHalfSlot(g.sizes, idx, insertAfter)) }
    })
    const stored = nextSizes[gid]
    if (stored) nextSizes[gid] = clampNormalizedSizes(spliceHalfSlot(stored, idx, insertAfter))
  } else {
    // 垂直:包裹。left/top → [new, P];right/bottom → [P, new]
    const child: LayoutNode = loc.parentGroup
      ? loc.parentGroup.children[loc.index]
      : state.layout.root
    const wrap: GroupNode = {
      id: ids.group(),
      direction,
      children: insertAfter ? [child, { kind: 'pane', pane: newPane }] : [{ kind: 'pane', pane: newPane }, child],
      sizes: [0.5, 0.5]
    }
    if (loc.parentGroup === null) {
      nextRoot = { kind: 'group', group: wrap }
    } else {
      const gid = loc.parentGroup.id
      const idx = loc.index
      nextRoot = mapGroup(state.layout.root, gid, (g) => {
        const children = [...g.children]
        children[idx] = { kind: 'group', group: wrap }
        return { ...g, children }
      })
    }
  }

  if (groupDepth(nextRoot) > MAX_TREE_DEPTH) return null

  let nextState: LayoutState = {
    layout: { root: nextRoot, focusedPaneId: newPane.id },
    sizesByGroupId: nextSizes
  }

  if (hasTab) {
    const moved = moveTabToPaneInLayout(nextState, payload.tabId!, newPane.id)
    if (!moved) return null
    nextState = moved
    if (!findPaneById(nextState.layout.root, newPane.id)) return null // 防御:目标 pane 不应消失
  }
  return { state: nextState, paneId: newPane.id }
}

// ─── 移除(共享路径:closeTab 级联 / closePane / moveTab 源清空) ──

function removePaneRecursive(node: LayoutNode, paneId: string, isRoot: boolean): LayoutNode | null {
  if (node.kind === 'pane') return node.pane.id === paneId ? null : node
  const children: LayoutNode[] = []
  let removedIndex = -1
  for (let i = 0; i < node.group.children.length; i++) {
    const c = node.group.children[i]
    if (c.kind === 'pane' && c.pane.id === paneId) {
      removedIndex = i
      continue
    }
    const r = removePaneRecursive(c, paneId, false)
    if (r !== null) children.push(r)
  }
  if (removedIndex === -1 && children.length === node.group.children.length) {
    // 本子树未发生变化:保持原引用(结构共享)
    let changed = children.length !== node.group.children.length
    if (!changed) {
      for (let i = 0; i < children.length; i++) {
        if (children[i] !== node.group.children[i]) {
          changed = true
          break
        }
      }
    }
    if (!changed) return node
  }
  if (children.length === 0) return null
  if (children.length === 1 && !isRoot) return children[0] // 单子折叠(根除外,R1b)
  let sizes = [...node.group.sizes]
  if (removedIndex >= 0) sizes.splice(removedIndex, 1)
  else if (sizes.length !== children.length) sizes = children.map(() => 1 / children.length)
  return { kind: 'group', group: { ...node.group, children, sizes: renormalize(sizes) } }
}

function removePaneFromState(state: LayoutState, paneId: string): LayoutState | null {
  const newRoot = removePaneRecursive(state.layout.root, paneId, true)
  if (newRoot === null) return null
  const oldIds = new Set<string>()
  collectGroupIds(state.layout.root, oldIds)
  const newIds = new Set<string>()
  collectGroupIds(newRoot, newIds)
  const sizesByGroupId: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(state.sizesByGroupId)) {
    const g = findGroupById(newRoot, k)
    if (!g) continue // 折叠/删除的 group → 条目删除
    if (v.length === g.children.length) {
      sizesByGroupId[k] = v
    } else {
      // 该 group 丢了子节点:树内 sizes 已正确 splice+归一化,stored 以树为准修复
      sizesByGroupId[k] = [...g.sizes]
    }
  }
  const focused = findPaneById(newRoot, state.layout.focusedPaneId ?? '')
    ? state.layout.focusedPaneId
    : firstVisiblePaneId(newRoot)
  return { layout: { root: newRoot, focusedPaneId: focused }, sizesByGroupId }
}

function findGroupById(node: LayoutNode, groupId: string): GroupNode | null {
  if (node.kind === 'pane') return null
  if (node.group.id === groupId) return node.group
  for (const c of node.group.children) {
    const hit = findGroupById(c, groupId)
    if (hit) return hit
  }
  return null
}

/** 关 pane;最后一个可见 pane → null(R3) */
export function closePaneInLayout(state: LayoutState, paneId: string): LayoutState | null {
  const pane = findPaneById(state.layout.root, paneId)
  if (!pane) return null
  if (pane.hidden !== true && countVisiblePanes(state.layout.root) <= 1) return null
  return removePaneFromState(state, paneId)
}

/** 关 tab;-pane 内最后一个 tab 时级联关 pane(走同一守门) */
export function closeTabInLayout(state: LayoutState, tabId: string): LayoutState | null {
  const hit = findTab(state.layout.root, tabId)
  if (!hit) return null
  if (hit.pane.tabs.length > 1) {
    const next = mapPane(state.layout.root, hit.pane.id, (p) => {
      const tabs = p.tabs.filter((t) => t.tabId !== tabId)
      const focused = p.focusedTabId === tabId ? (tabs[0]?.tabId ?? null) : p.focusedTabId
      return { ...p, tabs, focusedTabId: focused }
    })
    return { ...state, layout: { ...state.layout, root: next } }
  }
  return closePaneInLayout(state, hit.pane.id)
}

/** 藏/显 pane;藏掉最后一个可见 pane → null(R3);隐藏不动任何 sizes */
export function setPaneHiddenInLayout(
  state: LayoutState,
  paneId: string,
  hidden: boolean
): LayoutState | null {
  const pane = findPaneById(state.layout.root, paneId)
  if (!pane) return null
  if (hidden && pane.hidden !== true && countVisiblePanes(state.layout.root) <= 1) return null
  if (pane.hidden === hidden) return state
  const next = mapPane(state.layout.root, paneId, (p) => ({ ...p, hidden: hidden ? true : undefined }))
  let focused = state.layout.focusedPaneId
  if (hidden && focused === paneId) focused = firstVisiblePaneId(next)
  return { ...state, layout: { root: next, focusedPaneId: focused } }
}

/** 跨 pane 移动 tab;源 pane 清空 → 移除该 pane;afterTabId 不在目标 pane → null */
export function moveTabToPaneInLayout(
  state: LayoutState,
  tabId: string,
  toPaneId: string,
  afterTabId?: string,
  front?: boolean
): LayoutState | null {
  const hit = findTab(state.layout.root, tabId)
  if (!hit) return null
  const target = findPaneById(state.layout.root, toPaneId)
  if (!target) return null
  if (hit.pane.id === toPaneId) {
    // 同 pane = 行内重排到 afterTabId 之后
    if (afterTabId === undefined) return state
    const order = hit.pane.tabs.filter((t) => t.tabId !== tabId).map((t) => t.tabId)
    const i = order.indexOf(afterTabId)
    if (i < 0) return null
    order.splice(i + 1, 0, tabId)
    const next = reorderTabsInPaneInLayout(state.layout, toPaneId, order)
    return next ? { ...state, layout: next } : null
  }
  const tab = hit.pane.tabs.find((t) => t.tabId === tabId)!
  let insertAt = target.tabs.length
  if (front) {
    insertAt = 0
  } else if (afterTabId !== undefined) {
    const i = target.tabs.findIndex((t) => t.tabId === afterTabId)
    if (i < 0) return null
    insertAt = i + 1
  }
  let nextRoot = mapPane(state.layout.root, hit.pane.id, (p) => {
    const tabs = p.tabs.filter((t) => t.tabId !== tabId)
    return { ...p, tabs, focusedTabId: p.focusedTabId === tabId ? (tabs[0]?.tabId ?? null) : p.focusedTabId }
  })
  nextRoot = mapPane(nextRoot, toPaneId, (p) => ({
    ...p,
    tabs: [...p.tabs.slice(0, insertAt), tab, ...p.tabs.slice(insertAt)],
    focusedTabId: tabId
  }))
  let nextState: LayoutState = { ...state, layout: { ...state.layout, root: nextRoot } }
  if (hit.pane.tabs.length === 1) {
    // 源 pane 清空 → 移除(此时树中它 tabs 已空,removePane 按 paneId 删节点)
    const removed = removePaneFromState(nextState, hit.pane.id)
    if (!removed) return null
    nextState = removed
  }
  return { ...nextState, layout: focusPaneInLayout(nextState.layout, toPaneId) }
}

// ─── normalizeLayout(持久化恢复的逐节点打捞) ───────────────────

function isValidTarget(t: unknown): t is TabTarget {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  if (o.kind === 'chat') return typeof o.sessionId === 'string' && o.sessionId.length > 0
  if (o.kind === 'word') return typeof o.path === 'string' && o.path.length > 0
  if (o.kind === 'new_tab' || o.kind === 'terminal' || o.kind === 'review') return true
  if (o.kind === 'browser') return o.startUrl === undefined || typeof o.startUrl === 'string'
  return false
}

function salvagePane(raw: unknown): PaneState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return null
  if (!Array.isArray(o.tabs)) return null
  const tabs: PaneTab[] = []
  for (const t of o.tabs) {
    if (typeof t !== 'object' || t === null) continue
    const to = t as Record<string, unknown>
    if (typeof to.tabId !== 'string' || !isValidTarget(to.target) || typeof to.createdAt !== 'number') continue
    if (tabs.some((x) => x.tabId === to.tabId)) continue // 全局重复 tabId 去重
    tabs.push({ tabId: to.tabId, target: to.target, createdAt: to.createdAt })
  }
  if (tabs.length === 0) return null
  const focused = typeof o.focusedTabId === 'string' && tabs.some((t) => t.tabId === o.focusedTabId)
    ? (o.focusedTabId as string)
    : tabs[0].tabId
  const pane: PaneState = { id: o.id, tabs, focusedTabId: focused }
  if (o.hidden === true) pane.hidden = true
  return pane
}

function salvageNode(raw: unknown): LayoutNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'pane') {
    const pane = salvagePane(o.pane)
    return pane ? { kind: 'pane', pane } : null
  }
  if (o.kind === 'group') {
    const g = o.group
    if (typeof g !== 'object' || g === null) return null
    const go = g as Record<string, unknown>
    if (typeof go.id !== 'string' || go.id.length === 0) return null
    if (go.direction !== 'horizontal' && go.direction !== 'vertical') return null
    if (!Array.isArray(go.children)) return null
    const children: LayoutNode[] = []
    for (const c of go.children) {
      const s = salvageNode(c)
      if (s) children.push(s)
    }
    if (children.length === 0) return null
    if (children.length === 1) return children[0] // 单子折叠(salvage 层全部折叠)
    const sizes =
      Array.isArray(go.sizes) && go.sizes.length === children.length &&
      go.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)
        ? renormalize(go.sizes as number[])
        : children.map(() => 1 / children.length)
    return { kind: 'group', group: { id: go.id, direction: go.direction, children, sizes } }
  }
  return null
}

/**
 * 恢复持久化布局:逐节点打捞(坏 tab/空 pane/单子 group/dangling focus 修复)。
 * 不可救(无有效 pane / 信封垃圾)→ null,由调用方回退 createDefaultLayout。
 */
export function normalizeLayout(raw: unknown): WorkspaceLayout | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  let nodeRaw: unknown = o
  if (o.root !== undefined) nodeRaw = o.root
  let node = salvageNode(nodeRaw)
  if (!node) return null
  if (node.kind === 'pane') {
    // 裸 pane root → 包合成 group(R1b)
    node = { kind: 'group', group: { id: ROOT_GROUP_ID, direction: 'horizontal', children: [node], sizes: [1] } }
  }
  let focusedPaneId: string | null = null
  if (typeof o.focusedPaneId === 'string' && findPaneById(node, o.focusedPaneId)) {
    focusedPaneId = o.focusedPaneId
  } else {
    focusedPaneId = firstVisiblePaneId(node)
  }
  return { root: node, focusedPaneId }
}
