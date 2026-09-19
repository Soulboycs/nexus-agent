import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles } from 'lucide-react'
import type { AgentEvent, AgentStatus, ApprovalRequest } from '@shared/types'
import { extractSessionTitle } from '@shared/sessionUtils'
import { ChatTimeline } from '../../components/ChatTimeline'
import { ApprovalCard } from '../../components/ApprovalCard'
import { FloatingInputDock } from '../../components/FloatingInputDock'
import { createScrollFollower, type ScrollFollower } from '../../utils/scrollFollower'
import { useSessionChat } from '../../hooks/useSessionChat'
import { sessionEventBus } from '../../utils/sessionEventBus'
import { useLayoutStore } from '../layout-store'
import { useLinkageStore } from '../linkage-store'
import { useDroppable } from '@dnd-kit/core'
import { findPaneById, collectAllPanes as collectPanes } from '../layout-model'
import { usePaneHost } from '../pane-host-context'
import { getSessionWordDoc, getRecentWordFiles } from '../../components/word/persistence'
import { resolveMentions, buildSessionLabel, type MentionCandidate } from '../../utils/mentions'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

const TERMINAL_STATUSES: AgentStatus[] = ['completed', 'error', 'idle']

/**
 * 会话 pane 内容(计划 §8.1):App.tsx 主区按 sessionId 参数化。
 *
 * 每 pane 一份:chat 状态(useSessionChat)、status、待审批卡、输入草稿、
 * 滚动跟随、落盘去重集合——互相隔离,A pane 流式 B pane 零渲染。
 * 落盘沿用 appendMessage 逐条去重(main 侧 turn 批量落盘为后续切片)。
 */
export function ChatPane({ target, active }: TabContentProps<Extract<TabTarget, { kind: 'chat' }>>) {
  const sessionId = target.sessionId
  const host = usePaneHost()
  const { state: chatState, dispatch } = useSessionChat(sessionId)
  const messages = chatState.messages

  const [status, setStatus] = useState<AgentStatus>('idle')
  const [promptInput, setPromptInput] = useState('')
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [title, setTitle] = useState<string>('New Conversation')
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([])

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollFollowerRef = useRef<ScrollFollower | null>(null)
  const persistedMessageIdsRef = useRef<Set<string>>(new Set())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const statusRef = useRef<AgentStatus>('idle')
  statusRef.current = status

  // —— 会话历史装载(挂载/切会话时)——
  useEffect(() => {
    let cancelled = false
    setStatus('idle')
    setPendingApproval(null)
    window.electronAPI
      ?.getSession?.(sessionId)
      .then((session) => {
        if (cancelled || !session) return
        setTitle(session.title || 'New Conversation')
        persistedMessageIdsRef.current = new Set((session.messages || []).map((m) => m.id))
        dispatch({ type: 'load_history', messages: session.messages || [] })
        const boundDoc = getSessionWordDoc(sessionId)
        if (boundDoc) {
          window.dispatchEvent(new CustomEvent('nexus-word-open-file', { detail: { path: boundDoc } }))
        }
      })
      .catch((err) => console.error('[ChatPane] Failed to load session history:', err))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // —— @ 提及候选(§6.7):会话 + 最近文档 ——
  useEffect(() => {
    void (async () => {
      try {
        const sessions = (await window.electronAPI?.listSessions?.(host.workspace || undefined)) || []
        const docs = getRecentWordFiles()
        const used = new Map<string, number>()
        setMentionCandidates([
          ...sessions
            .filter((s) => s.id !== sessionId)
            .slice(0, 10)
            .map((s) => ({
              type: 'session' as const,
              id: s.id,
              name: buildSessionLabel(s.title, s.lastPrompt, s.id, used)
            })),
          ...docs.map((p) => ({ type: 'doc' as const, id: p, name: p.split(/[\/]/).pop() || p }))
        ])
      } catch {}
    })()
  }, [host.workspace])

  // 拖会话 tab 到本输入框 → 注入委派 token(§6.7/条目28)
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ composerSessionId: string; droppedSessionId: string }>).detail
      if (!d || d.composerSessionId !== sessionId) return
      const cand = mentionCandidates.find((c) => c.type === 'session' && c.id === d.droppedSessionId)
      const token = cand ? `@${cand.name} ` : `@${d.droppedSessionId.slice(0, 8)} `
      setPromptInput((prev) => (prev.startsWith('@') ? prev : token + prev))
    }
    window.addEventListener('nexus-composer-mention', handler)
    return () => window.removeEventListener('nexus-composer-mention', handler)
  }, [sessionId, mentionCandidates])

  // —— 滚动跟随 ——
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const follower = createScrollFollower(el)
    scrollFollowerRef.current = follower
    return () => {
      follower.detach()
      scrollFollowerRef.current = null
    }
  }, [])

  useEffect(() => {
    scrollFollowerRef.current?.follow()
  }, [messages, pendingApproval])

  // —— 会话级副作用:status/审批/落盘/docx 联动(仅本会话事件)——
  useEffect(() => {
    const unsubscribe = sessionEventBus.subscribe(sessionId, (event: AgentEvent) => {
      if (event.type === 'status_change') {
        setStatus(event.status)
        if (TERMINAL_STATUSES.includes(event.status)) {
          setPendingApproval(null)
          host.notifyFilesDirty()
          void saveActiveSessionRef.current?.()
        }
      } else if (event.type === 'error') {
        setStatus('error')
      } else if (event.type === 'approval_required') {
        // bypass 的自动批准由 App 级全局 responder 处理(pane 可能被收回);
        // 这里只负责非 bypass 的 pane 内审批卡。
        if (host.permissionMode !== 'bypass') {
          setPendingApproval(event.request)
        }
      } else if (event.type === 'tool_call_start') {
        if (event.toolCall.name.startsWith('docx_')) {
          // 零配置联动路由(§6.4):lastTouch 记忆 + word tab 自动打开(去重;抑制名单跳过)
          const link = useLinkageStore.getState()
          const fp = (event.toolCall.arguments as { filePath?: string })?.filePath
          if (fp) {
            link.setLastTouch(fp, sessionId)
            if (!link.isSuppressed(fp)) placeWordTab(fp)
          }
        }
      } else if (event.type === 'tool_call_complete') {
        // R5 正名双覆盖：Bash/Read/Write/Edit/Glob/Grep/LS + 旧名
        const n = event.result.name
        if (
          ['Bash', 'run_command', 'Write', 'Edit', 'Read', 'Grep', 'Glob', 'LS'].includes(n) ||
          n.includes('file') ||
          n.includes('File') ||
          n.startsWith('docx_')
        ) {
          host.notifyFilesDirty()
        }
      }
    })
    return unsubscribe
  }, [sessionId, host])

  // 落位策略(§6.2 规则2):记忆 pane → 本会话 pane 旁新 split(此后复用)→ 聚焦 pane 兜底
  const placeWordTab = (fp: string): void => {
    const st = useLayoutStore.getState()
    const link2 = useLinkageStore.getState()
    const pref = link2.panePreference[sessionId]
    if (pref && findPaneById(st.layout.root, pref)) {
      st.openTab({ kind: 'word', path: fp }, { paneId: pref })
      return
    }
    const ownPane = collectPanes(st.layout.root).find((p) =>
      p.tabs.some((t) => t.target.kind === 'chat' && t.target.sessionId === sessionId)
    )
    if (ownPane) {
      const r = st.splitPane(ownPane.id, 'right', { target: { kind: 'word', path: fp } })
      if (r) {
        link2.setPanePreference(sessionId, r)
        return
      }
    }
    st.openTab({ kind: 'word', path: fp })
  }

  const saveActiveSessionRef = useRef<(() => Promise<void>) | null>(null)
  // F7:pane 卸载(收回/关闭)前冲刷当前转录;之后持久化所有权交回 main(onTurnEnd)
  useEffect(() => {
    return () => {
      void saveActiveSessionRef.current?.()
      void window.electronAPI?.releasePersistOwner?.(sessionId)
    }
  }, [sessionId])
  // 本 pane 存续期间由 renderer 负责落盘(main 跳过)
  useEffect(() => {
    void window.electronAPI?.claimPersistOwner?.(sessionId)
  }, [sessionId])
  saveActiveSessionRef.current = async () => {
    const msgs = messagesRef.current
    if (!sessionId || msgs.length === 0) return
    try {
      for (const msg of msgs) {
        if (msg.isStreaming) continue
        if (persistedMessageIdsRef.current.has(msg.id)) continue
        const ok = await window.electronAPI?.appendMessage?.(sessionId, msg)
        if (ok) persistedMessageIdsRef.current.add(msg.id)
      }
    } catch (err) {
      console.error('[ChatPane] Failed to auto-save session:', err)
    }
  }

  // —— 发送(按会话)——
  const submitPrompt = useCallback(
    async (text: string) => {
      const prompt = text.trim()
      if (!prompt || statusRef.current === 'thinking' || statusRef.current === 'tool_executing') return
      if (statusRef.current === 'awaiting_confirmation') {
        try {
          await window.electronAPI?.abort?.(sessionId)
        } catch {}
      }
      const now = Date.now()
      scrollFollowerRef.current?.forceFollow()
      dispatch({ type: 'start_turn', prompt, turnId: `asst_${now}_${Math.random().toString(36).slice(2, 6)}` })
      setPromptInput('')

      if (!title || title === 'New Conversation' || title === 'New Session') {
        const derived = extractSessionTitle([{ id: 'temp', role: 'user', content: prompt, timestamp: now }])
        setTitle(derived)
      }

      // Word 活动文档上下文注入(沿用单实例 __aidocs;阶段三改 per-chip 预算)
      let outgoingPrompt = prompt
      const aidocs = (window as unknown as Record<string, unknown>).__aidocs as
        | { getFilePath?: () => string | undefined; filePath?: string; getDocumentContext?: () => string }
        | undefined
      const activeDocPath = aidocs?.getFilePath ? aidocs.getFilePath() : aidocs?.filePath
      if (activeDocPath) {
        const isDocRelated = /文档|word|docx|段落|标题|表格|字数|全文|大纲|章节|润色|改写|翻译|修改|审阅|修订/i.test(prompt)
        if (isDocRelated && !prompt.includes(activeDocPath)) {
          const liveContext = aidocs?.getDocumentContext?.() || ''
          outgoingPrompt += `\n\n【当前 Word 画布活动文档】：${activeDocPath}`
          if (liveContext) outgoingPrompt += `\n${liveContext}`
        }
      }

      try {
        // P4 委派(§6.6 L3):@会话 → 任务发给目标会话(带来源标注),聚焦其 pane
        const resolved = resolveMentions(prompt, mentionCandidates)
        if (resolved.delegatedSessionIds.length === 0 && resolved.docPaths.length > 0) {
          // F3:@仅文档 → 上下文随本会话任务注入(评审缺口修复)
          outgoingPrompt += '\n\n【涉及文档】(可直接用 docx 工具读写):\n' + resolved.docPaths.map((p) => '- ' + p).join('\n')
        }
        if (resolved.delegatedSessionIds.length > 0) {
          const docLines = resolved.docPaths.length
            ? '\n\n【涉及文档】:\n' + resolved.docPaths.map((p) => '- ' + p).join('\n')
            : ''
          for (const sid of resolved.delegatedSessionIds) {
            await window.electronAPI?.sendMessage?.(
              `【来自会话 ${sessionId} 的委派】\n${outgoingPrompt}${docLines}`,
              host.workspace || undefined,
              sid
            )
          }
          setPromptInput('')
          useLayoutStore.getState().openTab({ kind: 'chat', sessionId: resolved.delegatedSessionIds[0] })
          return
        }
        await window.electronAPI?.sendMessage?.(outgoingPrompt, host.workspace || undefined, sessionId)
      } catch (err) {
        dispatch({ type: 'error', message: (err as Error)?.message || 'Failed to send message' })
      }
    },
    [sessionId, dispatch, host.workspace, title, mentionCandidates]
  )

  const handleForkMessage = useCallback(
    async (messageId: string) => {
      try {
        const created = await window.electronAPI?.forkSession?.(sessionId, messageId)
        if (created) useLayoutStore.getState().openTab({ kind: 'chat', sessionId: created.id })
      } catch (err) {
        console.error('[ChatPane] Fork failed:', err)
      }
    },
    [sessionId]
  )

  const handleAbort = useCallback(async () => {
    try {
      await window.electronAPI?.abort?.(sessionId)
    } catch (e) {
      console.error('[ChatPane] Failed to abort:', e)
    }
  }, [sessionId])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid={`chat-pane-${sessionId}`}>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto relative">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center max-w-xl mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 mb-4 shadow-xs">
              <Sparkles className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-semibold text-neutral-900 mb-1.5">How can I help you code today?</h2>
            <p className="text-xs text-neutral-500 max-w-sm mb-6 leading-relaxed">
              I can inspect and edit your codebase, execute commands, run tests, and architect systems autonomously.
            </p>
            <div className="grid grid-cols-2 gap-2.5 w-full text-left">
              {[
                'Explain the project architecture',
                'Write an automated test suite',
                'Refactor utilities for error resilience',
                'Scan for security vulnerabilities'
              ].map((tip) => (
                <button
                  key={tip}
                  type="button"
                  onClick={() => setPromptInput(tip)}
                  className="p-3 rounded-xl bg-neutral-50 hover:bg-neutral-100 border border-neutral-200/80 text-xs text-neutral-700 hover:text-neutral-900 transition-all text-left truncate shadow-2xs"
                >
                  {tip}
                </button>
              ))}
            </div>
          </div>
        )}
        <ChatTimeline messages={messages} onForkMessage={handleForkMessage} streamInstant={!active} />
      </div>

      {pendingApproval && (
        <div className="px-4 pb-2">
          <ApprovalCard
            key={pendingApproval.id}
            request={pendingApproval}
            onRespond={(approved, reason, updatedInput) => {
              // 无 sessionId:主进程按 callId 路由到最近发出该审批的会话(§7.1)
              window.electronAPI?.respondApproval?.(pendingApproval.id, approved, reason, updatedInput)
              setPendingApproval(null)
            }}
          />
        </div>
      )}

      {(() => {
        const composerDrop = useDroppable({
          id: `composer:${sessionId}`,
          data: { kind: 'composer', sessionId }
        })
        return (
        <div
          ref={composerDrop.setNodeRef}
          className={`shrink-0 ${composerDrop.isOver ? 'ring-2 ring-inset ring-blue-300 rounded-b-2xl' : ''}`}
          data-testid={`composer-drop-${sessionId}`}
        >
      <FloatingInputDock
        promptInput={promptInput}
        onChange={(e) => setPromptInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submitPrompt(promptInput)
          }
        }}
        onSend={() => void submitPrompt(promptInput)}
        onAbort={handleAbort}
        onScrollToBottom={() => scrollFollowerRef.current?.forceFollow()}
        currentModelId={host.currentModelId}
        currentProviderId={host.currentProviderId}
        onModelChange={host.onModelChange}
        status={status}
        onOpenSettings={host.onOpenSettings}
        providers={host.providers}
        permissionMode={host.permissionMode}
        onPermissionModeChange={host.onPermissionModeChange}
        mentionCandidates={mentionCandidates}
      />
        </div>
        )
      })()}
    </div>
  )
}

