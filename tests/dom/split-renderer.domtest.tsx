// @vitest-environment happy-dom
/**
 * P1-S7b DOM 测试(G1–G6,契约 CONTRACT-P1-S7b-c):
 * SplitRenderer/TabBar/RetainedPanel 真实渲染 + layout-store 真实状态机。
 * 覆盖:默认布局、按钮 split、tab 切换、closeTab 级联、ChatPane 事件投递。
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 单实例宿主测试只验证"挂载机制",不验证编辑器本体(mock 掉 288KB 的 Tiptap 应用)
vi.mock('../../src/renderer/src/components/word/App', () => ({
  App: () => <div data-testid="word-editor-mock" />
}))
import { render, fireEvent, screen, act } from '@testing-library/react'
import { SplitRenderer } from '../../src/renderer/src/workspace/SplitRenderer'
import { RetainedPanel } from '../../src/renderer/src/workspace/RetainedPanel'
import { useLayoutStore } from '../../src/renderer/src/workspace/layout-store'
import { registerBuiltinTabs } from '../../src/renderer/src/workspace/pane-content'
import { PaneHostContext } from '../../src/renderer/src/workspace/pane-host-context'
import { sessionEventBus } from '../../src/renderer/src/utils/sessionEventBus'
import { collectAllPanes } from '../../src/renderer/src/workspace/layout-model'
import type { AgentEvent } from '../../../src/shared/types'

registerBuiltinTabs()

function resetLayout() {
  // 直接重置为默认单 chat pane 布局(隔离用例间状态)
  useLayoutStore.setState({
    ...useLayoutStore.getInitialState(),
    hydrated: true
  })
}

function host(partial: Record<string, unknown> = {}) {
  const value = {
    workspace: 'D:/Agent',
    providers: [],
    currentModelId: 'm',
    currentProviderId: 'p',
    onModelChange: () => {},
    permissionMode: 'bypass' as const,
    onPermissionModeChange: () => {},
    onOpenSettings: () => {},
    onRequestWordDrawer: () => {},
    notifyFilesDirty: () => {},
    ...partial
  }
  return value as React.ComponentProps<typeof PaneHostContext.Provider>['value']
}

function renderTree() {
  return render(
    <PaneHostContext.Provider value={host()}>
      <SplitRenderer
        onSplit={(position, paneId) =>
          useLayoutStore.getState().splitPane(paneId, position, { target: { kind: 'new_tab' } })
        }
      />
    </PaneHostContext.Provider>
  )
}

beforeEach(() => {
  resetLayout()
  window.localStorage.clear()
})

describe('SplitRenderer — G1 默认布局', () => {
  it('渲染单 pane + TabBar 单 chip(合成 group 结构)', () => {
    renderTree()
    expect(screen.getByTestId('split-renderer')).toBeTruthy()
    const st = useLayoutStore.getState()
    const panes = collectAllPanes(st.layout.root)
    expect(panes.length).toBe(1)
    expect(screen.getByTestId(`tabbar-${panes[0].id}`)).toBeTruthy()
    expect(screen.getAllByTestId(/^tab-/).filter((el) => el.dataset.testid?.startsWith('tab-tab_')).length).toBe(1)
  })
})

describe('SplitRenderer — G2 按钮触发 split', () => {
  it('菜单 Split Right → 两个 pane,宽度 flex 各半', () => {
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    fireEvent.click(screen.getByTestId(`pane-menu-${p0.id}`))
    fireEvent.click(screen.getByTestId('menu-split-right'))
    const st1 = useLayoutStore.getState()
    expect(collectAllPanes(st1.layout.root).length).toBe(2)
    // 两个 tabbar 都在
    for (const p of collectAllPanes(st1.layout.root)) {
      expect(screen.getByTestId(`tabbar-${p.id}`)).toBeTruthy()
    }
  })

  it('G2b: 下方分割 → 垂直 flex-col 容器', () => {
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    fireEvent.click(screen.getByTestId(`pane-menu-${p0.id}`))
    fireEvent.click(screen.getByTestId('menu-split-down'))
    const st1 = useLayoutStore.getState()
    expect(collectAllPanes(st1.layout.root).length).toBe(2)
  })

  it('G2c: TabBar 一键分割按钮(无需开菜单)→ 立即出双 pane', () => {
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    fireEvent.click(screen.getByTestId(`split-right-btn-${p0.id}`))
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(2)
    const p1 = collectAllPanes(useLayoutStore.getState().layout.root)[0]
    fireEvent.click(screen.getByTestId(`split-down-btn-${p1.id}`))
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(3)
  })
})

describe('TabBar — G4/G5 tab 切换与关闭', () => {
  it('G4: 点击 chip 切换 focusedTabId;RetainedPanel 保活另一 tab', () => {
    const st = useLayoutStore.getState()
    const p0 = collectAllPanes(st.layout.root)[0]
    act(() => {
      useLayoutStore.getState().openTab({ kind: 'word', path: 'D:/doc.docx' })
    })
    const pane = collectAllPanes(useLayoutStore.getState().layout.root)[0]
    expect(pane.tabs.length).toBe(2)
    renderTree()
    const chip2 = screen.getByTestId(`tab-${pane.tabs[1].tabId}`)
    fireEvent.click(chip2)
    const after = collectAllPanes(useLayoutStore.getState().layout.root)[0]
    expect(after.focusedTabId).toBe(pane.tabs[1].tabId)
    // 两个内容面板都渲染(word 实编辑器宿主可见,chat 隐藏保活)
    expect(screen.getByTestId('word-pane')).toBeTruthy()
    const panes = screen.getAllByTestId(`chat-pane-${p0.tabs[0].target.kind === 'chat' ? p0.tabs[0].target.sessionId : ''}`)
    expect(panes.length).toBeGreaterThanOrEqual(1)
  })

  it('G5: closeTab 级联——关唯一 pane 唯一 tab 被守门拦截', () => {
    renderTree()
    const st = useLayoutStore.getState()
    const p0 = collectAllPanes(st.layout.root)[0]
    const ok = st.closeTab(p0.tabs[0].tabId)
    expect(ok).toBe(false)
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(1)
  })

  it('G5b: 双 pane 时关闭其中一个 → 布局回到单 pane', () => {
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    act(() => {
      st0.splitPane(p0.id, 'right', { target: { kind: 'chat', sessionId: 's2' } })
    })
    const st1 = useLayoutStore.getState()
    const panes1 = collectAllPanes(st1.layout.root)
    expect(panes1.length).toBe(2)
    const other = panes1.find((p) => p.id !== p0.id)!
    act(() => {
      st1.closeTab(other.tabs[0].tabId)
    })
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(1)
  })
})

describe('ChatPane — G6 事件总线投递(会话隔离)', () => {
  it('A 会话 delta 渲染在 A 的 pane;B 会话 pane 不受影响', async () => {
    // 两个 chat pane:A(默认)+ B(split 出来)
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    const sidA = (p0.tabs[0].target as { sessionId: string; kind: string }).sessionId
    act(() => {
      st0.splitPane(p0.id, 'right', { target: { kind: 'chat', sessionId: 'sess-B' } })
    })
    // 向 A 派发一轮流式(delta 的打字机 pacing 需要真实时间显影)
    await act(async () => {
      sessionEventBus.ingestBatch([
        { sessionId: sidA, seq: 1, event: { type: 'start_turn', prompt: 'hi', turnId: 't1' } as unknown as AgentEvent },
        { sessionId: sidA, seq: 2, event: { type: 'message_delta', delta: 'hello' } }
      ])
      await new Promise((r) => setTimeout(r, 250))
    })
    const paneA = screen.getByTestId(`chat-pane-${sidA}`)
    expect(paneA.textContent).toContain('hello')
    const paneB = screen.getByTestId('chat-pane-sess-B')
    expect(paneB.textContent).not.toContain('hello')
  })
})

describe('RetainedPanel — 保活语义', () => {
  it('active=false 时 display:none 但子树仍渲染', () => {
    const { container } = render(
      <RetainedPanel active={false}>
        <div data-testid="inner">x</div>
      </RetainedPanel>
    )
    const inner = container.querySelector('[data-testid="inner"]')
    expect(inner).toBeTruthy()
    const wrapper = inner!.parentElement as HTMLElement
    expect(wrapper.style.display).toBe('none')
  })
})

describe('NewTabPane — 落地页卡片(G7,打开标签页)', () => {
  it('G7: 分割出新格子显示卡片落地页;点"辅助对话"建新会话 retarget', async () => {
    // mock createSession(落地页卡片点击会调用)
    let created = 0
    ;(window as any).electronAPI = {
      ...(window as any).electronAPI,
      createSession: async () => {
        created++
        return { id: `sess-new-${created}`, title: 'New Conversation' }
      }
    }
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    fireEvent.click(screen.getByTestId(`split-right-btn-${p0.id}`))
    // 新 pane 是 new_tab 落地页
    expect(screen.getByTestId('new-tab-landing')).toBeTruthy()
    // 卡片存在(注册表驱动)
    expect(screen.getByTestId('new-tab-card-chat')).toBeTruthy()
    expect(screen.getByTestId('new-tab-card-word')).toBeTruthy()
    // 点"辅助对话"卡 → 创建会话 → 本格 retarget 为 chat
    fireEvent.click(screen.getByTestId('new-tab-card-chat'))
    await act(async () => {})
    const st1 = useLayoutStore.getState()
    const panes = collectAllPanes(st1.layout.root)
    expect(panes.length).toBe(2)
    const newPane = panes.find((p) => p.id !== p0.id)!
    expect(newPane.tabs[0].target.kind).toBe('chat')
    expect((newPane.tabs[0].target as { sessionId: string }).sessionId).toContain('sess-new')
    expect(created).toBe(1)
  })

  it('G7b: 点"文档"卡进入最近文档选择,选中文档 retarget 为 word', async () => {
    ;(window as any).electronAPI = { ...(window as any).electronAPI }
    localStorage.setItem('nexus_word_recent_files', JSON.stringify(['D:/docs/博士论文.docx', 'D:/docs/数据.docx']))
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    fireEvent.click(screen.getByTestId(`split-right-btn-${p0.id}`))
    fireEvent.click(screen.getByTestId('new-tab-card-word'))
    expect(screen.getByTestId('new-tab-picker-docs')).toBeTruthy()
    const docs = screen.getAllByTestId('pick-doc')
    expect(docs.length).toBe(2)
    fireEvent.click(docs[0])
    const st1 = useLayoutStore.getState()
    const panes = collectAllPanes(st1.layout.root)
    const newPane = panes.find((p) => p.id !== p0.id)!
    expect(newPane.tabs[0].target).toEqual({ kind: 'word', path: 'D:/docs/博士论文.docx' })
    expect(screen.getByTestId('word-pane')).toBeTruthy()
  })
})

describe('TabBar — G8 关闭按钮常显与注册表标题(回归:App 漏调 registerBuiltinTabs 曾致全 "Untitled")', () => {
  it('G8: chip 标题来自注册表(chat → "会话 …"),不回退 Untitled', () => {
    renderTree()
    const chip = screen.getAllByTestId(/^tab-tab_/)[0]
    expect(chip.textContent).toContain('会话')
    expect(chip.textContent).not.toContain('Untitled')
  })

  it('G8b: 单 tab pane 的 × 关闭该 pane;最后一个可见 pane 的 × 无效(R3)', () => {
    renderTree()
    const st0 = useLayoutStore.getState()
    const p0 = collectAllPanes(st0.layout.root)[0]
    // 分割出第二个 pane(落地页),其单 tab 的 × 应关掉整个 pane
    fireEvent.click(screen.getByTestId(`split-right-btn-${p0.id}`))
    const st1 = useLayoutStore.getState()
    const p1 = collectAllPanes(st1.layout.root).find((p) => p.id !== p0.id)!
    const p1Tab = p1.tabs[0].tabId
    fireEvent.click(screen.getByTestId(`close-tab-${p1Tab}`))
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(1)
    // 唯一 pane 的单 tab × → 守门拒绝,pane 仍在
    const only = collectAllPanes(useLayoutStore.getState().layout.root)[0]
    fireEvent.click(screen.getByTestId(`close-tab-${only.tabs[0].tabId}`))
    expect(collectAllPanes(useLayoutStore.getState().layout.root).length).toBe(1)
    // × 是常显的(不依赖 hover):渲染即可点击
    expect(screen.getByTestId(`close-tab-${only.tabs[0].tabId}`)).toBeTruthy()
  })
})
