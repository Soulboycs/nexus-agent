/**
 * TDD Test Suite: P1-S2 layout-model(布局树纯函数)
 * Contract: docs/CONTRACT-P1-S2-layout-model.md(B1–B16 + 不变量 1–6)
 *
 * 这些测试锁定的是持久化布局的正确性边界:结构共享(R1/remount)、
 * 最后可见 pane 守门(R3)、深度上限(R4)、树外 sizes 同步、normalize 打捞。
 */
import { describe, it, expect } from 'bun:test'
import {
  createDefaultLayout,
  openTabInLayout,
  focusPaneInLayout,
  selectTabInPaneInLayout,
  reorderTabsInPaneInLayout,
  splitPaneInLayout,
  moveTabToPaneInLayout,
  closeTabInLayout,
  closePaneInLayout,
  setPaneHiddenInLayout,
  clampNormalizedSizes,
  normalizeLayout,
  collectAllPanes,
  findPaneById,
  type LayoutIds,
  type LayoutState,
  type TabTarget
} from '../src/renderer/src/workspace/layout-model'

let n = 0
const ids = (): LayoutIds => {
  const p = `p${++n}`
  return {
    tab: () => `t${++n}`,
    pane: () => p,
    group: () => `g${++n}`
  }
}
const chat = (sessionId: string): TabTarget => ({ kind: 'chat', sessionId })
const doc = (path: string): TabTarget => ({ kind: 'word', path })

function fresh(): { state: LayoutState; paneId: string; tabId: string } {
  const st = createDefaultLayout(chat('s1'), ids())
  const pane = collectAllPanes(st.layout.root)[0]
  return { state: st, paneId: pane.id, tabId: pane.tabs[0].tabId }
}

/** 不变量检查器:契约不变量 1–3 */
function expectInvariants(st: LayoutState) {
  const panes = collectAllPanes(st.layout.root)
  expect(panes.length).toBeGreaterThanOrEqual(1)
  const walk = (node: typeof st.layout.root): number => {
    if (node.kind === 'pane') {
      expect(node.pane.tabs.length).toBeGreaterThanOrEqual(1)
      const idsInPane = node.pane.tabs.map((t) => t.tabId)
      if (node.pane.focusedTabId !== null) {
        expect(idsInPane).toContain(node.pane.focusedTabId)
      }
      return 0
    }
    expect(node.group.sizes.length).toBe(node.group.children.length)
    const sum = node.group.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
    const stored = st.sizesByGroupId[node.group.id]
    if (stored !== undefined) {
      expect(stored.length).toBe(node.group.children.length)
    }
    return 1 + Math.max(...node.group.children.map(walk))
  }
  walk(st.layout.root)
  if (st.layout.focusedPaneId !== null) {
    expect(findPaneById(st.layout.root, st.layout.focusedPaneId)).not.toBeNull()
  }
}

describe('layout-model — B1 默认布局', () => {
  it('根为合成 group 包单 pane(R1b),tabs/focused 就位,不变量成立', () => {
    const st = createDefaultLayout(chat('s1'), ids())
    expect(st.layout.root.kind).toBe('group')
    if (st.layout.root.kind === 'group') {
      expect(st.layout.root.group.direction).toBe('horizontal')
      expect(st.layout.root.group.children.length).toBe(1)
      expect(st.layout.root.group.sizes).toEqual([1])
    }
    const pane = collectAllPanes(st.layout.root)[0]
    expect(pane.tabs.length).toBe(1)
    expect(pane.tabs[0].target).toEqual(chat('s1'))
    expect(pane.focusedTabId).toBe(pane.tabs[0].tabId)
    expect(st.layout.focusedPaneId).toBe(pane.id)
    expectInvariants(st)
  })
})

describe('layout-model — B2/B3 openTab', () => {
  it('B2: 同 target 已存在 → 不新建,只 select+focus', () => {
    const { state } = fresh()
    const out = openTabInLayout(state.layout, chat('s1'), {}, ids())
    expect(out).not.toBeNull()
    const panes = collectAllPanes(out!.root)
    const totalTabs = panes.reduce((a, p) => a + p.tabs.length, 0)
    expect(totalTabs).toBe(1) // 没有新建
    expect(panes[0].focusedTabId).toBe(panes[0].tabs[0].tabId)
    expectInvariants({ layout: out!, sizesByGroupId: {} })
  })

  it('B2b: 不同 target → 新建 tab 并聚焦', () => {
    const { state } = fresh()
    const out = openTabInLayout(state.layout, doc('a.docx'), {}, ids())!
    const pane = collectAllPanes(out.root)[0]
    expect(pane.tabs.length).toBe(2)
    expect(pane.focusedTabId).toBe(pane.tabs[1].tabId)
  })

  it('B3: afterTabId 指定插入位置', () => {
    const { state } = fresh()
    let st = openTabInLayout(state.layout, doc('a.docx'), {}, ids())!
    st = openTabInLayout(st, doc('b.docx'), {}, ids())!
    const pane = collectAllPanes(st.root)[0]
    const firstTab = pane.tabs[0].tabId
    st = openTabInLayout(st, doc('c.docx'), { afterTabId: firstTab }, ids())!
    const tabs = collectAllPanes(st.root)[0].tabs
    expect(tabs[1].target).toEqual(doc('c.docx'))
  })
})

describe('layout-model — B4/B5/B6/B16 split', () => {
  it('B4: 同向 split → 父 group 相邻插入,树内+树外 sizes 同步对半', () => {
    const { state, paneId } = fresh()
    // 先 resize 存 stored sizes:模拟用户拖过 [0.3, 0.7]
    const rootId = state.layout.root.kind === 'group' ? state.layout.root.group.id : ''
    const stored: LayoutState = {
      layout: state.layout,
      sizesByGroupId: { [rootId]: [1] }
    }
    const r = splitPaneInLayout(stored, paneId, 'right', { target: doc('a.docx') }, ids())
    expect(r).not.toBeNull()
    const root = r!.state.layout.root
    expect(root.kind).toBe('group')
    if (root.kind === 'group') {
      expect(root.group.children.length).toBe(2)
      expect(root.group.sizes).toEqual([0.5, 0.5])
      expect(r!.state.sizesByGroupId[root.group.id]).toEqual([0.5, 0.5]) // stored 同步 splice
    }
    expectInvariants(r!.state)
  })

  it('B5: split 带 target → 新 pane 持新 tab 并聚焦', () => {
    const { state, paneId } = fresh()
    const r = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())
    const panes = collectAllPanes(r!.state.layout.root)
    expect(panes.length).toBe(2)
    const newPane = findPaneById(r!.state.layout.root, r!.paneId)!
    expect(newPane.tabs[0].target).toEqual(chat('s2'))
    expect(r!.state.layout.focusedPaneId).toBe(r!.paneId)
    expectInvariants(r!.state)
  })

  it('B6: 垂直 split → 目标 pane 被新 group 包裹,父 children 数不变', () => {
    const { state, paneId } = fresh()
    // 先水平 split 一次,再对同 pane 垂直 split → 方向不一致触发包裹
    const r1 = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())!
    const r2 = splitPaneInLayout(r1.state, paneId, 'bottom', { target: chat('s3') }, ids())!
    const root = r2.state.layout.root
    expect(root.kind).toBe('group')
    if (root.kind === 'group') expect(root.group.children.length).toBe(2) // 未变
    // paneId 现在应在嵌套 group 里,且新 pane 在其下方
    const wrap = findGroupContaining(root, paneId)
    expect(wrap).not.toBeNull()
    expect(wrap!.direction).toBe('vertical')
    expect(wrap!.children.length).toBe(2)
    expectInvariants(r2.state)
  })

  it('B7 (R1): 连续 split 后原 pane 节点引用不变(不 remount)', () => {
    const { state, paneId } = fresh()
    const original = findPaneById(state.layout.root, paneId)!
    const r1 = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())!
    const r2 = splitPaneInLayout(r1.state, r1.paneId, 'right', { target: chat('s3') }, ids())!
    const r3 = splitPaneInLayout(r2.state, paneId, 'bottom', { target: chat('s4') }, ids())!
    expect(findPaneById(r3.state.layout.root, paneId)).toBe(original)
    expectInvariants(r3.state)
  })

  it('B16: 用户 resize 过的 stored sizes 再 split → 新 pane 槽位对半且长度匹配', () => {
    const { state, paneId } = fresh()
    const r1 = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())!
    const rootId = r1.state.layout.root.kind === 'group' ? r1.state.layout.root.group.id : ''
    // 模拟用户拖到 [0.3, 0.7]
    const resized: LayoutState = {
      layout: r1.state.layout,
      sizesByGroupId: { [rootId]: [0.3, 0.7] }
    }
    const leftPane = collectAllPanes(resized.layout.root)[0]
    const r2 = splitPaneInLayout(resized, leftPane.id, 'right', { target: chat('s3') }, ids())!
    const root = r2.state.layout.root
    if (root.kind === 'group') {
      expect(root.group.children.length).toBe(3)
      // stored(用户拖过的权威值)按槽位对半 splice;树内默认 sizes 独立维护(渲染读 stored ?? tree)
      const stored = r2.state.sizesByGroupId[root.group.id]
      expect(stored.length).toBe(3)
      expect(stored[0]).toBeCloseTo(0.15)
      expect(stored[1]).toBeCloseTo(0.15)
      expect(stored[2]).toBeCloseTo(0.7)
      expect(root.group.sizes.length).toBe(3) // 树内同步 splice,长度匹配
    }
    expectInvariants(r2.state)
  })
})

describe('layout-model — B8/B9/B15 关闭与移动', () => {
  function twoPanes() {
    const { state, paneId } = fresh()
    const r = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())!
    return { st: r.state, left: paneId, right: r.paneId }
  }

  it('B8: 关非最后 pane 的最后一个 tab → 该 pane 移除;关唯一 pane 最后 tab → null(R3)', () => {
    const { st, right } = twoPanes()
    const rightPane = findPaneById(st.layout.root, right)!
    const out = closeTabInLayout(st, rightPane.tabs[0].tabId)
    expect(out).not.toBeNull()
    expect(collectAllPanes(out!.layout.root).length).toBe(1)
    expect(findPaneById(out!.layout.root, right)).toBeNull()
    expectInvariants(out!)

    const { state } = fresh()
    const only = collectAllPanes(state.layout.root)[0]
    expect(closeTabInLayout(state, only.tabs[0].tabId)).toBeNull() // 最后可见守门
  })

  it('B9: closePane 最后可见 pane → null;非最后 → 移除+stored 清理+单子折叠', () => {
    const { state } = fresh()
    const only = collectAllPanes(state.layout.root)[0]
    expect(closePaneInLayout(state, only.id)).toBeNull()

    const { st, right } = twoPanes()
    const out = closePaneInLayout(st, right)!
    expect(collectAllPanes(out.layout.root).length).toBe(1)
    // 回到单 pane:根应折叠回单子(仍为合成 group 包裹)
    expect(out.layout.root.kind).toBe('group')
    expectInvariants(out)
  })

  it('B15: moveTab 源 pane 清空 → 源 pane 移除;afterTabId 插入位置正确', () => {
    const { st, left, right } = twoPanes()
    const leftTab = findPaneById(st.layout.root, left)!.tabs[0].tabId
    const rightPane = findPaneById(st.layout.root, right)!
    const out = moveTabToPaneInLayout(st, leftTab, right, rightPane.tabs[0].tabId)!
    expect(findPaneById(out.layout.root, left)).toBeNull() // 源清空被移除
    const target = findPaneById(out.layout.root, right)!
    expect(target.tabs.length).toBe(2)
    expect(target.tabs[1].tabId).toBe(leftTab) // 插在 afterTabId 之后
    expectInvariants(out)
  })

  it('B15b: split 传 tabId → tab 移入新 pane,旧空 pane 收掉(净效果=tab 移到旁边)', () => {
    const { state, paneId, tabId } = fresh()
    const r = splitPaneInLayout(state, paneId, 'right', { tabId }, ids())
    expect(r).not.toBeNull()
    const panes = collectAllPanes(r!.state.layout.root)
    expect(panes.length).toBe(1) // 源清空删除,只剩新 pane
    expect(panes[0].tabs[0].tabId).toBe(tabId)
    expectInvariants(r!.state)
  })
})

describe('layout-model — B10/B11 hide 与重排', () => {
  it('B10: 藏最后一个可见 pane → null;隐藏不改 stored sizes;unhide 恢复', () => {
    const { state } = fresh()
    const only = collectAllPanes(state.layout.root)[0]
    expect(setPaneHiddenInLayout(state, only.id, true)).toBeNull()

    const { st, right } = (function () {
      const f = fresh()
      const r = splitPaneInLayout(f.state, f.paneId, 'right', { target: chat('s2') }, ids())!
      return { st: r.state, right: r.paneId }
    })()
    const rootId = st.layout.root.kind === 'group' ? st.layout.root.group.id : ''
    const stored: LayoutState = { layout: st.layout, sizesByGroupId: { [rootId]: [0.3, 0.7] } }
    const hidden = setPaneHiddenInLayout(stored, right, true)!
    expect(hidden.sizesByGroupId[rootId]).toEqual([0.3, 0.7]) // 隐藏不动 sizes
    const back = setPaneHiddenInLayout(hidden, right, false)!
    expect(back.sizesByGroupId[rootId]).toEqual([0.3, 0.7])
    expectInvariants(back)
  })

  it('B11: reorder 合法排列生效;非法排列 → null(fail-closed)', () => {
    const { state } = fresh()
    let st = openTabInLayout(state.layout, doc('a.docx'), {}, ids())!
    st = openTabInLayout(st, doc('b.docx'), {}, ids())!
    const pane = collectAllPanes(st.root)[0]
    const order = [...pane.tabs.map((t) => t.tabId)].reverse()
    const out = reorderTabsInPaneInLayout(st, pane.id, order)!
    expect(collectAllPanes(out.root)[0].tabs.map((t) => t.tabId)).toEqual(order)

    expect(reorderTabsInPaneInLayout(out, pane.id, ['bogus'])).toBeNull()
  })
})

describe('layout-model — B12 clampNormalizedSizes', () => {
  it('低于 min 的锁到 min,其余按比例让位', () => {
    const a = clampNormalizedSizes([0.05, 0.95])
    expect(a[0]).toBeCloseTo(0.1)
    expect(a[1]).toBeCloseTo(0.9)
    const b = clampNormalizedSizes([0.02, 0.02, 0.96])
    expect(b[0]).toBeCloseTo(0.1)
    expect(b[1]).toBeCloseTo(0.1)
    expect(b[2]).toBeCloseTo(0.8)
    const c = clampNormalizedSizes([0.5, 0.5])
    expect(c[0]).toBeCloseTo(0.5)
    expect(c[1]).toBeCloseTo(0.5)
  })
  it('非法输入兜底:n*min>=1 等分;空数组原样', () => {
    const out = clampNormalizedSizes([0.4, 0.4, 0.4])
    out.forEach((v) => expect(v).toBeCloseTo(1 / 3))
    expect(clampNormalizedSizes([])).toEqual([])
  })
})

describe('layout-model — B13 深度上限(R4)', () => {
  it('连续嵌套 split 到第 5 层 group → null', () => {
    const { state, paneId } = fresh()
    let st = state
    let pid = paneId
    // 深度计数:根=1;交替方向强制嵌套
    const positions = ['right', 'bottom'] as const
    let last: ReturnType<typeof splitPaneInLayout> = null
    for (let i = 0; i < 5; i++) {
      last = splitPaneInLayout(st, pid, positions[i % 2], { target: chat(`s${i}`) }, ids())
      if (last === null) break
      // 继续对"新 pane"分割以加深
      st = last.state
      pid = last.paneId
    }
    // 根(1)+3 层嵌套=4 允许;第 5 次(会造 5 层)→ null
    // 具体:循环 5 次,前 4 次成功?按 MAX=4,第 4 次 split 产生深度 4,第 5 次 → null
    expect(last).toBeNull()
  })
})

describe('layout-model — B14 normalizeLayout 打捞', () => {
  it('信封级垃圾 → null', () => {
    expect(normalizeLayout(null)).toBeNull()
    expect(normalizeLayout(42)).toBeNull()
    expect(normalizeLayout('x')).toBeNull()
  })

  it('合法布局原样通过(引用语义)', () => {
    const { state } = fresh()
    expect(normalizeLayout(state.layout)).toEqual(state.layout)
  })

  it('dangling focusedTabId/focusedPaneId 回落;单子 group 折叠;bare pane root 包裹', () => {
    const raw = {
      kind: 'pane',
      pane: { id: 'p1', tabs: [{ tabId: 't1', target: chat('s1'), createdAt: 1 }], focusedTabId: 'bogus' }
    }
    const out = normalizeLayout(raw)!
    expect(out.root.kind).toBe('group') // 包裹
    const pane = collectAllPanes(out.root)[0]
    expect(pane.focusedTabId).toBe('t1')
    expect(out.focusedPaneId).toBe('p1')
  })

  it('空 tabs pane 丢弃;坏 tab 丢弃;全灭 → null', () => {
    const raw = {
      root: {
        kind: 'group',
        group: {
          id: 'g1',
          direction: 'horizontal',
          children: [
            { kind: 'pane', pane: { id: 'p1', tabs: [], focusedTabId: null } },
            {
              kind: 'pane',
              pane: {
                id: 'p2',
                tabs: [
                  { tabId: 't1', target: { kind: 'bogus' }, createdAt: 1 },
                  { tabId: 't2', target: chat('ok'), createdAt: 2 }
                ],
                focusedTabId: 't2'
              }
            }
          ],
          sizes: [0.5, 0.5]
        }
      },
      focusedPaneId: 'p1' // dangling → 回落
    }
    const out = normalizeLayout(raw)!
    const panes = collectAllPanes(out.root)
    expect(panes.length).toBe(1)
    expect(panes[0].id).toBe('p2')
    expect(panes[0].tabs.length).toBe(1)
    expect(out.focusedPaneId).toBe('p2')
    expect(out.root.kind).toBe('group')

    expect(
      normalizeLayout({ root: { kind: 'group', group: { id: 'g', direction: 'horizontal', children: [], sizes: [] } } })
    ).toBeNull()
  })

  it('B16b: remove 后 stored sizes 同步(长度匹配且归一)', () => {
    const { state, paneId } = fresh()
    const r = splitPaneInLayout(state, paneId, 'right', { target: chat('s2') }, ids())!
    const rootId = r.state.layout.root.kind === 'group' ? r.state.layout.root.group.id : ''
    // 三格
    const r2 = splitPaneInLayout(
      { layout: r.state.layout, sizesByGroupId: { [rootId]: [0.5, 0.5] } },
      r.paneId,
      'right',
      { target: chat('s3') },
      ids()
    )!
    expect(r2.state.sizesByGroupId[rootId].length).toBe(3)
    const midPaneId = r.paneId
    const closed = closePaneInLayout(r2.state, midPaneId)!
    expect(closed.sizesByGroupId[rootId].length).toBe(2)
    const sum = closed.sizesByGroupId[rootId].reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1)
    expectInvariants(closed)
  })
})

// —— 助手 ——
function findGroupContaining(
  node: import('../src/renderer/src/workspace/layout-model').LayoutNode,
  paneId: string
): import('../src/renderer/src/workspace/layout-model').GroupNode | null {
  if (node.kind === 'group') {
    if (node.group.children.some((c) => c.kind === 'pane' && c.pane.id === paneId)) return node.group
    for (const c of node.group.children) {
      const hit = findGroupContaining(c, paneId)
      if (hit) return hit
    }
  }
  return null
}

describe('layout-model — B17 new_tab 与 retargetTab(S8+ 内容选择落地页)', () => {
  it('new_tab 是合法 target;retargetTab 原位替换 tab 的 target', async () => {
    const m = await import('../src/renderer/src/workspace/layout-model')
    const st = m.createDefaultLayout({ kind: 'new_tab' }, ids())
    const pane = m.collectAllPanes(st.layout.root)[0]
    expect(pane.tabs[0].target).toEqual({ kind: 'new_tab' })
    expect(m.normalizeLayout(st.layout)).not.toBeNull() // normalize 接受 new_tab

    const out = m.retargetTabInLayout(
      st.layout,
      pane.tabs[0].tabId,
      { kind: 'word', path: 'D:/论文.docx' }
    )
    expect(out).not.toBeNull()
    const after = m.collectAllPanes(out!.root)[0]
    expect(after.tabs[0].target).toEqual({ kind: 'word', path: 'D:/论文.docx' })
    expect(after.tabs[0].tabId).toBe(pane.tabs[0].tabId) // tabId 不变(引用替换)
  })

  it('retargetTab 不存在的 tabId → null', async () => {
    const m = await import('../src/renderer/src/workspace/layout-model')
    const st = m.createDefaultLayout({ kind: 'chat', sessionId: 's1' }, ids())
    expect(m.retargetTabInLayout(st.layout, 'nope', { kind: 'new_tab' })).toBeNull()
  })
})

describe('layout-model — T 系列新增 kind 持久化接受(终端/浏览器/审查)', () => {
  it('normalizeLayout 接受 terminal/browser/review target', async () => {
    const m = await import('../src/renderer/src/workspace/layout-model')
    const raw = {
      root: { kind: 'group', group: { id: 'g', direction: 'horizontal',
        children: [
          { kind: 'pane', pane: { id: 'p1', tabs: [{ tabId: 't1', target: { kind: 'terminal' }, createdAt: 1 }], focusedTabId: 't1' } },
          { kind: 'pane', pane: { id: 'p2', tabs: [{ tabId: 't2', target: { kind: 'browser', startUrl: 'https://x.com' }, createdAt: 2 }], focusedTabId: 't2' } },
          { kind: 'pane', pane: { id: 'p3', tabs: [{ tabId: 't3', target: { kind: 'review' }, createdAt: 3 }], focusedTabId: 't3' } }
        ], sizes: [1/3, 1/3, 1/3] } },
      focusedPaneId: 'p2'
    }
    const out = m.normalizeLayout(raw)!
    expect(out.focusedPaneId).toBe('p2')
    const panes = m.collectAllPanes(out.root)
    expect(panes.length).toBe(3)
    expect(panes.map((p) => p.tabs[0].target.kind)).toEqual(['terminal', 'browser', 'review'])
  })
})
