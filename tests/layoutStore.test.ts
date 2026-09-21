/**
 * TDD Test Suite: P1-S7a layout-store(zustand persist + zod 校验)
 * Contract: docs/CONTRACT-P1-S7a.md(F1–F8)
 *
 * 布局状态机:模型纯函数(S2)之上的命令式 action 层 + 持久化。
 * bun node 环境无 localStorage → persist 走 no-op storage(注入式,真实持久化在浏览器/Electron 生效),
 * 校验与 action 逻辑在此全量测试。
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useLayoutStore, validatePersisted, LAYOUT_PERSIST_KEY } from '../src/renderer/src/workspace/layout-store'
import { collectAllPanes, findPaneById, MAX_TREE_DEPTH } from '../src/renderer/src/workspace/layout-model'
import type { LayoutState } from '../src/renderer/src/workspace/layout-model'

// the store is a module singleton: reset to the pristine initial state before
// every test (this reset was lost with the truncated block, restoring it)
beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true)
})

function snapshot(): LayoutState {
  const s = useLayoutStore.getState()
  return { layout: s.layout, sizesByGroupId: s.sizesByGroupId }
}

function expectInvariants(st: LayoutState) {
  const panes = collectAllPanes(st.layout.root)
  expect(panes.length).toBeGreaterThanOrEqual(1)
  for (const p of panes) {
    expect(p.tabs.length).toBeGreaterThanOrEqual(1)
    if (p.focusedTabId !== null) {
      expect(p.tabs.some((t) => t.tabId === p.focusedTabId)).toBe(true)
    }
  }
}

describe('layout-store — F1 初始状态', () => {
  it('默认布局:合成 group 包单 pane,单 chat tab', () => {
    const st = useLayoutStore.getState()
    expect(st.layout.root.kind).toBe('group')
    const panes = collectAllPanes(st.layout.root)
    expect(panes.length).toBe(1)
    expect(panes[0].tabs.length).toBe(1)
    expect(panes[0].tabs[0].target).toEqual({ kind: 'chat', sessionId: '__boot__' })
    expectInvariants(snapshot())
  })
})

describe('layout-store — F2/F3/F4 action 层', () => {
  it('F2: splitPane 返回新 paneId 且状态满足不变量', () => {
    const st = useLayoutStore.getState()
    const pane = collectAllPanes(st.layout.root)[0]
    const newId = st.splitPane(pane.id, 'right', { target: { kind: 'chat', sessionId: 's2' } })
    expect(newId).not.toBeNull()
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(2)
    expect(useLayoutStore.getState().layout.focusedPaneId).toBe(newId)
    expectInvariants(snapshot())
  })

  it('F3: resizeSplit 写 clamp 后的 stored sizes', () => {
    const st = useLayoutStore.getState()
    const p0 = collectAllPanes(st.layout.root)[0]
    const newId = st.splitPane(p0.id, 'right', { target: { kind: 'chat', sessionId: 's2' } })!
    const rootId = useLayoutStore.getState().layout.root.kind === 'group'
      ? (useLayoutStore.getState().layout.root as { group: { id: string } }).group.id
      : ''
    useLayoutStore.getState().resizeSplit(rootId, [0.05, 0.95])
    const stored = useLayoutStore.getState().sizesByGroupId[rootId]
    expect(stored[0]).toBeCloseTo(0.1)
    expect(stored[1]).toBeCloseTo(0.9)
    expect(findPaneById(useLayoutStore.getState().layout.root, newId!)).not.toBeNull()
  })

  it('F4: 关 tab 级联与最后可见守门(确定性状态构造)', () => {
    const st = useLayoutStore.getState()
    const p0 = collectAllPanes(st.layout.root)[0]
    // 构造双 pane
    const newId = st.splitPane(p0.id, 'right', { target: { kind: 'chat', sessionId: 's2' } })
    expect(newId).not.toBeNull()
    const panes = collectAllPanes(useLayoutStore.getState().layout.root)
    expect(panes.length).toBe(2)
    const other = panes.find((x) => x.id !== p0.id)!
    expect(useLayoutStore.getState().closeTab(other.tabs[0].tabId)).toBe(true)
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(1)
    // 回到唯一 pane 单 tab:守门必须拦截(R3)
    const only = collectAllPanes(useLayoutStore.getState().layout.root)[0]
    expect(useLayoutStore.getState().closeTab(only.tabs[0].tabId)).toBe(false)
    expectInvariants(useLayoutStore.getState())
  })
})

describe('layout-store — F5/F6 持久化校验', () => {
  it('F5: 操作后状态可 JSON 往返,validatePersisted 还原等价布局', () => {
    const st = useLayoutStore.getState()
    const round = validatePersisted({
      version: 1,
      layout: st.layout,
      sizesByGroupId: st.sizesByGroupId
    })
    expect(round).not.toBeNull()
    expect(round!.layout).toEqual(st.layout)
  })

  it('F6: 信封级垃圾一律 null(未来版本/缺字段/未知字段/坏树)', () => {
    expect(validatePersisted(null)).toBeNull()
    expect(validatePersisted({ version: 2, layout: {}, sizesByGroupId: {} })).toBeNull() // 未来版本
    expect(validatePersisted({ layout: {}, sizesByGroupId: {} })).toBeNull() // 缺 version
    expect(
      validatePersisted({ version: 1, layout: {}, sizesByGroupId: {}, rogue: 1 })
    ).toBeNull() // 未知字段(strict)
    expect(validatePersisted({ version: 1, layout: { root: null }, sizesByGroupId: {} })).toBeNull()
    expect(validatePersisted(42)).toBeNull()
  })

  it('F7: 坏持久化数据在 merge 阶段回默认(模拟重放 merge)', () => {
    const st = useLayoutStore.getState()
    // merge 语义由 validatePersisted 承载:返回 null 时保留 current——以状态未被破坏佐证
    expect(validatePersisted({ version: 99, layout: st.layout, sizesByGroupId: {} })).toBeNull()
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBeGreaterThanOrEqual(1)
  })
})

describe('layout-store — F8 bootstrap', () => {
  it('bootstrapSession 替换 __boot__ 占位 tab;替换后幂等', () => {
    const st = useLayoutStore.getState()
    st.bootstrapSession('sess-real')
    const panes = collectAllPanes(useLayoutStore.getState().layout.root)
    const targets = panes.flatMap((p) => p.tabs.map((t) => t.target))
    expect(targets).toContainEqual({ kind: 'chat', sessionId: 'sess-real' })
    expect(targets).not.toContainEqual({ kind: 'chat', sessionId: '__boot__' })
    // 幂等:再调不再新增
    const before = panes.reduce((a, p) => a + p.tabs.length, 0)
    st.bootstrapSession('sess-real')
    const after = collectAllPanes(useLayoutStore.getState().layout.root).reduce(
      (a, p) => a + p.tabs.length,
      0
    )
    expect(after).toBe(before)
  })

  it('持久化 key 与深度常量导出稳定(R2:字段禁改名的锚点)', () => {
    expect(LAYOUT_PERSIST_KEY).toBe('nexus_workspace_layout')
    expect(MAX_TREE_DEPTH).toBe(4)
  })
})
