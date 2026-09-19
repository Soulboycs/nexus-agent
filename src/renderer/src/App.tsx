import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  AgentEvent,
  FileTreeNode,
  ModelProvider,
  PermissionMode,
  normalizePermissionMode
} from '@shared/types'
import { AntigravityTopBar } from './components/AntigravityTopBar'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { SettingsModal } from './components/SettingsModal'
import { RightAuxiliaryBar } from './components/RightAuxiliaryBar'
import {
  useLayoutStore
} from './workspace/layout-store'
import { SplitRenderer } from './workspace/SplitRenderer'
import { registerBuiltinTabs } from './workspace/pane-content'

// 注册内置 tab kind(必须在模块加载期执行:注册表驱动标题/内容/落地页卡片。
// 回归教训:此前该调用被误删,所有 tab 标题回退 "Untitled" 且 pane 内容渲染为空)
registerBuiltinTabs()
import { PaneHostContext } from './workspace/pane-host-context'
import { sessionEventBus } from './utils/sessionEventBus'
import { collectAllPanes } from './workspace/layout-model'
import { installFrameProbe, uninstallFrameProbe } from './utils/perfProbe'
import { WorkspaceDnd, SidebarDropZone } from './workspace/WorkspaceDnd'
import { useLinkageStore } from './workspace/linkage-store'
import { normalizeKeyPath } from '@shared/paths'

// 多 pane 工作台(计划 §8.1/§10 阶段一):
// - chat 状态全部下沉到 ChatPane(每 pane 独立 useReducer + sessionEventBus 按 sessionId 投递)
// - App 保留:布局开关、provider 配置、Sidebar、Word dock、全局副作用(自动批准 responder/
//   文件刷新去抖/Word 联动雏形)、批量事件管道接线
// - RightAuxiliaryBar/TerminalView 原样保留(阶段三才退役 word dock)

/** 全局自动批准 responder(§8.1:bypass 模式下 pane 收回也不丢审批) */
function installAutoApprover(permissionModeRef: React.RefObject<PermissionMode>) {
  return sessionEventBusSubscribe((event) => {
    if (event.type === 'approval_required' && permissionModeRef.current === 'bypass') {
      window.electronAPI?.respondApproval?.(event.request.id, true)
    }
  })
}

/** 批量通道 → 总线(传输层单订阅点) */
function installEventBatchPipe() {
  return sessionEventBusSubscribeRaw((batch) => sessionEventBus.ingestBatch(batch))
}

function sessionEventBusSubscribe(fn: (e: AgentEvent) => void) {
  return window.electronAPI?.onAgentEvent?.(fn) ?? (() => {})
}
function sessionEventBusSubscribeRaw(
  fn: (batch: Array<{ sessionId: string; seq: number; event: AgentEvent }>) => void
) {
  return window.electronAPI?.onAgentEventBatch?.(fn) ?? (() => {})
}

export default function App() {
  const [workspace, setWorkspace] = useState<string>('')
  const [, setFiles] = useState<FileTreeNode[]>([])

  const [isWordDrawerOpen, setIsWordDrawerOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nexus_word_drawer_open') === 'true'
    } catch {
      return false
    }
  })
  const [currentModelId, setCurrentModelId] = useState<string>('deepseek-chat')
  const [currentProviderId, setCurrentProviderId] = useState<string>('deepseek')
  const [providers, setProviders] = useState<ModelProvider[]>([])

  const [currentProject, setCurrentProject] = useState<string>('Agent')
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState<number>(0)
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nexus_sidebar_open') !== 'false'
    } catch {
      return true
    }
  })

  // 布局 hydration 门(§4.4:hydrate 完成前不渲染布局,防默认布局闪现)
  const hydrated = useLayoutStore((s) => s.hydrated)
  const setHydrated = useLayoutStore((s) => s.setHydrated)
  const bootstrapSession = useLayoutStore((s) => s.bootstrapSession)
  const openTab = useLayoutStore((s) => s.openTab)

  // 派生"聚焦会话"(Sidebar 高亮/Word 绑定/breadcrumb 过渡期用)
  const layout = useLayoutStore((s) => s.layout)
  const focusedSessionId = React.useMemo(() => {
    for (const p of collectAllPanes(layout.root)) {
      if (p.id === layout.focusedPaneId) {
        const focused = p.tabs.find((t) => t.tabId === p.focusedTabId)
        if (focused && focused.target.kind === 'chat') return focused.target.sessionId
      }
    }
    return null
  }, [layout])

  const workspaceRef = useRef<string>('')
  workspaceRef.current = workspace

  const focusedSessionIdRef = useRef<string>('')
  focusedSessionIdRef.current = focusedSessionId ?? ''

  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)

  // Permission Mode(三模式;全局语义 → SessionManager 默认值)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    return normalizePermissionMode(localStorage.getItem('nexus_permission_mode'))
  })
  const permissionModeRef = useRef<PermissionMode>(permissionMode)

  useEffect(() => {
    permissionModeRef.current = permissionMode
    window.electronAPI?.setPermissionMode?.(permissionMode)
  }, [permissionMode])

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode)
    permissionModeRef.current = mode
    localStorage.setItem('nexus_permission_mode', mode)
    window.electronAPI?.setPermissionMode?.(mode)
  }, [])

  // —— 全局文件刷新(300ms trailing 去抖,§8.1 副作用三分)——
  const filesDirtyRef = useRef(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshFiles = useCallback(async (dir?: string) => {
    const targetDir = dir || workspaceRef.current
    if (!targetDir) return
    try {
      const tree = await window.electronAPI?.readWorkspaceFiles?.(targetDir)
      if (tree) setFiles(tree)
    } catch (e) {
      console.error('Failed to refresh files:', e)
    }
  }, [])
  const notifyFilesDirty = useCallback(() => {
    filesDirtyRef.current = true
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      if (filesDirtyRef.current) {
        filesDirtyRef.current = false
        void refreshFiles()
        setSidebarRefreshTrigger((v) => v + 1)
      }
    }, 300)
  }, [refreshFiles])

  const getProjectName = (pathStr?: string): string => {
    if (!pathStr) return 'Agent'
    const clean = pathStr.replace(/[/\\]+$/, '')
    const parts = clean.split(/[/\\]/)
    return parts[parts.length - 1] || 'Agent'
  }

  // —— 启动:workspace 检测 + 布局迁移 + 事件管道 ——

  // 旧 localStorage → 布局 store 迁移(hydrate 后;首次 persist 落盘成功才删旧 key,§4.4/R9)
  const migrateLegacyRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const offPipe = installEventBatchPipe()
    const offApprover = installAutoApprover(permissionModeRef)
    // 性能钩子(dev only,§8.3):帧探针供 Playwright 读取验收口径
    let probe: ReturnType<typeof installFrameProbe> | null = null
    if (import.meta.env.DEV || localStorage.getItem('nexus_perf_probe') === '1') probe = installFrameProbe()
    return () => {
      offPipe?.()
      offApprover?.()
      if (probe) uninstallFrameProbe()
    }
  }, [])

  useEffect(() => {
    if (hydrated) return
    const stop = useLayoutStore.persist.onFinishHydration(() => {
      setHydrated()
    })
    // 已完成 hydrate 的情况(persist 同步完成时可能错过事件)
    if (useLayoutStore.persist.hasHydrated()) setHydrated()
    return () => stop()
  }, [hydrated, setHydrated])

  useEffect(() => {
    if (!hydrated) return
    // 旧会话↔文档映射 → lastTouch(§6.5 迁移)
    useLinkageStore.getState().bootstrapFromLegacy()
    // docs:file-changed(FileChangeHub)→ 联动:角标 + 跟随
    const offChanged = window.docsApi?.onWordFileChanged?.(({ filePath }: { filePath: string }) => {
      const link = useLinkageStore.getState()
      link.markUpdated(filePath)
    })
    return () => {
      offChanged?.()
    }
  }, [hydrated])

  // 启动:workspace 检测 + 布局会话恢复/迁移(原启动 effect 主体)
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void (async () => {
      let folder: string | null = null
      try {
        folder = (await window.electronAPI?.getCurrentWorkspace?.()) ?? null
      } catch {}
      if (cancelled) return
      if (folder) {
        setWorkspace(folder)
        void refreshFiles(folder)
        setCurrentProject(getProjectName(folder))
      }

      // 1) 恢复持久化布局里的会话 tab(重启恢复)
      const st = useLayoutStore.getState()
      const persistedSessions = collectAllPanes(st.layout.root)
        .flatMap((p) => p.tabs)
        .filter((t) => t.target.kind === 'chat')
        .map((t) => (t.target as { sessionId: string }).sessionId)
      const hasBoot = persistedSessions.includes('__boot__')
      const realSessions = persistedSessions.filter((id) => id !== '__boot__' && id !== '')

      // 2) 旧 key 迁移:__boot__ 占位 → 上次活动会话
      let legacyId: string | null = null
      try {
        legacyId = localStorage.getItem('nexus_active_session_id')
      } catch {}

      let bootTarget = legacyId
      if (!bootTarget && realSessions.length === 0) {
        // 无持久化、无旧 key → 找/建一个会话
        try {
          const sessions = folder ? (await window.electronAPI?.listSessions?.(folder)) || [] : []
          if (sessions.length > 0) bootTarget = sessions[0].id
          else if (folder) {
            const created = await window.electronAPI?.createSession?.('New Conversation', folder)
            bootTarget = created?.id ?? null
          }
        } catch (e) {
          console.error('Failed to initialize session:', e)
        }
      }

      if (hasBoot && bootTarget) {
        bootstrapSession(bootTarget)
      } else if (!hasBoot && realSessions.length === 0 && bootTarget) {
        openTab({ kind: 'chat', sessionId: bootTarget })
      }

      // 3) 首次 persist 落盘成功后删旧 key(只读保留一版);落盘由 zustand persist 自动发生
      if (legacyId) {
        setTimeout(() => {
          try {
            localStorage.removeItem('nexus_active_session_id')
          } catch {}
        }, 1500)
      }
      migrateLegacyRef.current = null
    })()
    return () => {
      cancelled = true
    }
  }, [hydrated, bootstrapSession, openTab, refreshFiles])

  // Provider 配置装载
  useEffect(() => {
    window.electronAPI?.getProviderConfig?.().then((config) => {
      if (config) {
        if (config.providers) setProviders(config.providers)
        if (config.activeModelId) setCurrentModelId(config.activeModelId)
        else if ((config as { model?: string }).model) setCurrentModelId((config as { model?: string }).model!)
        if (config.activeProviderId) setCurrentProviderId(config.activeProviderId)
      }
    })
  }, [])

  // Word 联动雏形:焦点会话绑定文档 + drawer 开关(阶段三迁 pane)
  useEffect(() => {
    const handleWordFileOpened = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath: string }>).detail
      if (detail?.filePath && focusedSessionIdRef.current) {
        import('./components/word/persistence').then(({ setSessionWordDoc }) => {
          setSessionWordDoc(focusedSessionIdRef.current, detail.filePath)
        })
      }
    }
    const handleWordFocus = () => {
      setIsWordDrawerOpen(true)
      try {
        localStorage.setItem('nexus_word_drawer_open', 'true')
      } catch {}
    }
    window.addEventListener('nexus-word-file-opened', handleWordFileOpened)
    window.addEventListener('nexus-word-focus', handleWordFocus)
    return () => {
      window.removeEventListener('nexus-word-file-opened', handleWordFileOpened)
      window.removeEventListener('nexus-word-focus', handleWordFocus)
    }
  }, [])

  // Word 编辑器"问 AI":反向路由(§6.4)——lastTouch[path] 优先,聚焦该会话 pane 并发送;
  // 无记忆 → 聚焦会话兜底;发送后写 lastTouch(发送后记忆)
  useEffect(() => {
    const handleWordAskAi = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      const { instruction, filePath } = detail
      const promptText = filePath
        ? `请对 Word 文档（${filePath}）执行以下修改：${instruction}`
        : `请执行：${instruction}`
      const link = useLinkageStore.getState()
      const remembered = filePath ? link.lastTouch[normalizeKeyPath(filePath)] : undefined
      const target = remembered || focusedSessionIdRef.current
      if (!target) return
      if (remembered) {
        // 聚焦被记忆的会话 pane(去重:已开则只聚焦)
        useLayoutStore.getState().openTab({ kind: 'chat', sessionId: target })
      }
      void window.electronAPI?.sendMessage?.(promptText, workspaceRef.current || undefined, target)
      if (filePath) link.setLastTouch(filePath, target)
    }
    window.addEventListener('nexus-word-ask-ai', handleWordAskAi)
    return () => window.removeEventListener('nexus-word-ask-ai', handleWordAskAi)
  }, [])

  const handleSelectConversation = useCallback(
    (id: string, _title: string, projectName: string) => {
      setCurrentProject(projectName)
      openTab({ kind: 'chat', sessionId: id }) // 去重:已开则只聚焦(S2 openTabInLayout)
    },
    [openTab]
  )

  const handleNewConversation = useCallback(async () => {
    try {
      const newSess = await window.electronAPI?.createSession?.('New Conversation', workspaceRef.current)
      if (newSess) {
        openTab({ kind: 'chat', sessionId: newSess.id })
        try {
          localStorage.setItem('nexus_active_session_id', newSess.id)
        } catch {}
        setSidebarRefreshTrigger((prev) => prev + 1)
      }
    } catch (err) {
      console.error('Failed to create new conversation:', err)
    }
  }, [openTab, setSidebarRefreshTrigger])

  // 分割语义(§5.4 + "打开标签页"落地页):新格子先显示内容选择卡,点卡决定变成什么。
  // 同步瞬时、不急切创建会话;创建失败无副作用。
  const handleSplitPane = useCallback((position: 'left' | 'right' | 'top' | 'bottom', paneId: string) => {
    useLayoutStore.getState().splitPane(paneId, position, { target: { kind: 'new_tab' } })
  }, [])

  // 快捷键(§5.4 最小集):Ctrl+\ 右侧分割、Ctrl+Shift+\ 下方分割、Ctrl+W 关 tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault()
        const focused = useLayoutStore.getState().layout.focusedPaneId
        if (focused) void handleSplitPane(e.shiftKey ? 'bottom' : 'right', focused)
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        const st = useLayoutStore.getState()
        const pane = collectAllPanes(st.layout.root).find((p) => p.id === st.layout.focusedPaneId)
        if (pane?.focusedTabId) st.closeTab(pane.focusedTabId) // R3 守门:最后可见 pane 拒绝
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSplitPane])

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      try {
        await window.electronAPI?.deleteSession?.(id)
        // 关掉布局里该会话的所有 tab(R3 守门保护最后可见 pane)
        const st = useLayoutStore.getState()
        for (const p of collectAllPanes(st.layout.root)) {
          for (const t of p.tabs) {
            if (t.target.kind === 'chat' && t.target.sessionId === id) {
              st.closeTab(t.tabId)
            }
          }
        }
        setSidebarRefreshTrigger((prev) => prev + 1)
      } catch (err) {
        console.error('Failed to delete conversation:', err)
      }
    },
    [setSidebarRefreshTrigger]
  )

  const handleModelChange = useCallback((modelId: string, providerId?: string) => {
    setCurrentModelId(modelId)
    if (providerId) setCurrentProviderId(providerId)
    window.electronAPI?.switchModel?.(modelId, providerId)
  }, [])

  // —— 渲染 ——
  const hostValue = React.useMemo(
    () => ({
      workspace,
      providers,
      currentModelId,
      currentProviderId,
      onModelChange: handleModelChange,
      permissionMode,
      onPermissionModeChange: handlePermissionModeChange,
      onOpenSettings: () => setIsSettingsOpen(true),
      onRequestWordDrawer: () => setIsWordDrawerOpen(true),
      notifyFilesDirty
    }),
    [
      workspace,
      providers,
      currentModelId,
      currentProviderId,
      handleModelChange,
      permissionMode,
      handlePermissionModeChange,
      notifyFilesDirty
    ]
  )

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white text-neutral-900 font-sans select-text antialiased">
      <AntigravityTopBar
        currentProject={currentProject}
        currentConversationTitle={focusedSessionId ? `会话 ${focusedSessionId.slice(0, 8)}` : 'New Conversation'}
        onToggleSidebar={() => {
          setIsSidebarOpen((prev) => {
            const next = !prev
            try {
              localStorage.setItem('nexus_sidebar_open', String(next))
            } catch {}
            return next
          })
        }}
        isSidebarOpen={isSidebarOpen}
        onToggleAuxiliaryBar={() => {
          setIsWordDrawerOpen((prev) => {
            const next = !prev
            try {
              localStorage.setItem('nexus_word_drawer_open', String(next))
            } catch {}
            return next
          })
        }}
        isAuxiliaryBarOpen={isWordDrawerOpen}
      />

        {/* Main Workspace Body(统一拖拽域:Sidebar 与 SplitRenderer 同域互拖) */}
        <WorkspaceDnd>
        <div className="flex flex-1 overflow-hidden relative">
          <SidebarDropZone>
            {isSidebarOpen && (
              <Sidebar
                currentConversationId={focusedSessionId ?? ''}
                workspace={workspace}
                refreshTrigger={sidebarRefreshTrigger}
                onSelectConversation={handleSelectConversation}
                onNewConversation={() => void handleNewConversation()}
                onDeleteConversation={(id) => void handleDeleteConversation(id)}
                onOpenSettings={() => setIsSettingsOpen(true)}
              />
            )}
          </SidebarDropZone>

        {/* Center: 多 pane 工作台(SplitRenderer,PaneHost context 包裹) */}
        <main className="flex-1 flex flex-col h-full overflow-hidden bg-white relative">
          {hydrated ? (
            <PaneHostContext.Provider value={hostValue}>
              <SplitRenderer
                onCreateChat={() => void handleNewConversation()}
                onSplit={(position, paneId) => void handleSplitPane(position, paneId)}
              />
            </PaneHostContext.Provider>
          ) : (
            <div className="flex-1" aria-busy="true" data-testid="layout-hydrating" />
          )}
          {/* Bottom Embedded Terminal Drawer */}
          <TerminalView isOpen={isTerminalOpen} onClose={() => setIsTerminalOpen(false)} />
        </main>

        <RightAuxiliaryBar
          isOpen={isWordDrawerOpen}
          onClose={() => {
            setIsWordDrawerOpen(false)
            try {
              localStorage.setItem('nexus_word_drawer_open', 'false')
            } catch {}
          }}
          onOpenTerminal={() => setIsTerminalOpen(true)}
        />
        </div>
        </WorkspaceDnd>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onConfigUpdated={(cfg) => {
          if (cfg.providers) setProviders(cfg.providers)
          if (cfg.activeModelId) setCurrentModelId(cfg.activeModelId)
          if (cfg.activeProviderId) setCurrentProviderId(cfg.activeProviderId)
        }}
      />
    </div>
  )
}
