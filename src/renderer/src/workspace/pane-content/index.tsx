import { MessageSquareText, FileText } from 'lucide-react'
import { registerTabKind } from '../tab-registry'
import { useLayoutStore } from '../layout-store'
import { ChatPane } from './ChatPane'
import { WordPane } from './WordPane'
import { NewTabPane } from './NewTabPane'

/**
 * 内置 tab kind 注册(App 启动时调用一次;D1:新类型只加注册项,
 * 自动获得布局/拖拽能力 + new_tab 落地页卡片)。
 */
export function registerBuiltinTabs(): void {
  registerTabKind({
    kind: 'chat',
    title: (t) => `会话 ${String(t.sessionId).slice(0, 8)}`,
    component: ChatPane,
    sidebarSection: 'sessions',
    newCard: { title: '辅助对话', icon: <MessageSquareText className="w-5 h-5" />, description: '新的 Agent 会话' },
    // 卡片点击:新建会话 → 本格变成该会话(创建失败保持落地页)
    onCreateInTab: (tabId) => {
      void (async () => {
        try {
          const sess = await window.electronAPI?.createSession?.('New Conversation')
          if (sess) useLayoutStore.getState().retargetTab(tabId, { kind: 'chat', sessionId: sess.id })
        } catch (err) {
          console.error('[NewTab] Failed to create session:', err)
        }
      })()
    }
  })
  registerTabKind({
    kind: 'word',
    title: (t) => String(t.path).split(/[\\/]/).pop() || '文档',
    component: WordPane,
    sidebarSection: 'docs',
    newCard: { title: '文档', icon: <FileText className="w-5 h-5" />, description: 'Word 文档' }
    // word 的 onCreateInTab 由 NewTabPane 内置文档选择器处理(需要本地交互态)
  })
  registerTabKind({
    kind: 'new_tab',
    title: () => '新建…',
    component: NewTabPane,
    sidebarSection: 'sessions'
  })
}
