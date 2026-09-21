import React, { useState, useEffect, useCallback } from 'react'
import { useDraggable } from '@dnd-kit/core'
import {
  Plus,
  Clock,
  CalendarClock,
  Filter,
  FolderPlus,
  Folder,
  FolderOpen,
  Settings,
  Trash2,
  ChevronRight,
  ChevronDown,
  Pencil,
  Check
} from 'lucide-react'
import { SessionSummary } from '@shared/types'

export interface SidebarProps {
  currentConversationId?: string
  workspace?: string
  refreshTrigger?: number
  onSelectConversation?: (id: string, title: string, projectName: string) => void
  onNewConversation?: () => void
  onOpenSettings?: () => void
  onDeleteConversation?: (id: string) => void
}

interface ProjectGroup {
  id: string
  name: string
  workspacePath: string
  isExpanded: boolean
  sessions: SessionSummary[]
}

function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return ''
  const diff = Date.now() - timestamp
  if (diff < 60 * 1000) return 'now'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}m`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))}h`
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getProjectNameFromPath(pathStr?: string): string {
  if (!pathStr) return 'Agent'
  const clean = pathStr.replace(/[/\\]+$/, '')
  const parts = clean.split(/[/\\]/)
  return parts[parts.length - 1] || 'Agent'
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentConversationId,
  workspace,
  refreshTrigger = 0,
  onSelectConversation,
  onNewConversation,
  onOpenSettings,
  onDeleteConversation
}) => {
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [activeTab, setActiveTab] = useState<'conversations' | 'history' | 'tasks'>('conversations')
  const [filterQuery, setFilterQuery] = useState<string>('')
  const [showFilter, setShowFilter] = useState<boolean>(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState<string>('')

  const handleStartRename = (e: React.MouseEvent, session: SessionSummary) => {
    e.stopPropagation()
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
  }

  const handleSaveRename = async (id: string) => {
    const trimmed = editingTitle.trim()
    if (trimmed && trimmed !== '') {
      await window.electronAPI?.renameSession?.(id, trimmed)
      await loadSessions()
    }
    setEditingSessionId(null)
  }

  const handleCancelRename = () => {
    setEditingSessionId(null)
  }

  // Load real sessions from backend / local sessionStore
  const loadSessions = useCallback(async () => {
    try {
      const list: SessionSummary[] = (await window.electronAPI?.listSessions?.()) || []
      
      // Group sessions by workspacePath
      const groupsMap = new Map<string, ProjectGroup>()
      const currentWsName = getProjectNameFromPath(workspace)

      // Ensure current workspace has a group
      const currentWsKey = workspace || 'default'
      groupsMap.set(currentWsKey, {
        id: currentWsKey,
        name: currentWsName,
        workspacePath: workspace || '',
        isExpanded: true,
        sessions: []
      })

      for (const s of list) {
        const wsKey = s.workspacePath || 'default'
        const projName = getProjectNameFromPath(s.workspacePath)

        if (!groupsMap.has(wsKey)) {
          groupsMap.set(wsKey, {
            id: wsKey,
            name: projName,
            workspacePath: s.workspacePath,
            isExpanded: true,
            sessions: []
          })
        }
        groupsMap.get(wsKey)!.sessions.push(s)
      }

      const groups = Array.from(groupsMap.values())
      // Sort: current workspace first, then others by name
      groups.sort((a, b) => {
        if (a.id === currentWsKey) return -1
        if (b.id === currentWsKey) return 1
        return a.name.localeCompare(b.name)
      })

      setProjectGroups(groups)
    } catch (err) {
      console.error('Failed to load sessions in sidebar:', err)
    }
  }, [workspace])

  useEffect(() => {
    loadSessions()
  }, [loadSessions, refreshTrigger])

  const toggleGroup = (groupId: string) => {
    setProjectGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, isExpanded: !g.isExpanded } : g))
    )
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (onDeleteConversation) {
      onDeleteConversation(id)
    } else {
      window.electronAPI?.deleteSession?.(id).then(() => loadSessions())
    }
  }

  return (
    <aside className="w-60 h-full bg-[#fbfbfb] border-r border-neutral-200/80 flex flex-col select-none text-xs text-neutral-700 shrink-0 font-sans">
      {/* Top Main Action Button: + New Conversation */}
      <div className="p-3 pb-2">
        <button
          type="button"
          onClick={onNewConversation}
          className="w-full flex items-center justify-start gap-2 px-3 py-2 bg-white hover:bg-neutral-50 border border-neutral-200/90 rounded-lg text-xs font-medium text-neutral-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow transition-all group"
        >
          <Plus className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-800 transition-colors" />
          <span>New Conversation</span>
        </button>
      </div>

      {/* Top Navigation Shortcuts */}
      <div className="px-3 py-1 space-y-0.5">
        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 transition-colors ${
            activeTab === 'history' ? 'bg-neutral-100 text-neutral-900 font-medium' : ''
          }`}
        >
          <Clock className="w-3.5 h-3.5 text-neutral-400" />
          <span>Conversation History</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('tasks')}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 transition-colors ${
            activeTab === 'tasks' ? 'bg-neutral-100 text-neutral-900 font-medium' : ''
          }`}
        >
          <CalendarClock className="w-3.5 h-3.5 text-neutral-400" />
          <span>Scheduled Tasks</span>
        </button>
      </div>

      {/* Projects Section Header */}
      <div className="mt-3 px-3.5 py-1 flex items-center justify-between text-neutral-400">
        <span className="text-[11px] font-semibold tracking-wider">Projects</span>
        <div className="flex items-center gap-1.5 text-neutral-400">
          <button
            type="button"
            onClick={() => setShowFilter(!showFilter)}
            className={`hover:text-neutral-700 p-0.5 rounded ${showFilter ? 'text-neutral-900 bg-neutral-200/60' : ''}`}
            title="Filter Conversations"
          >
            <Filter className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onNewConversation}
            className="hover:text-neutral-700 p-0.5 rounded"
            title="New Conversation in Project"
          >
            <FolderPlus className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Optional Search / Filter input */}
      {showFilter && (
        <div className="px-3 py-1">
          <input
            type="text"
            placeholder="Filter conversations..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="w-full px-2 py-1 text-[11px] bg-white border border-neutral-200 rounded-md focus:outline-none focus:border-neutral-400"
            autoFocus
          />
        </div>
      )}

      {/* Projects and Real Conversations Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        {projectGroups.map((group) => {
          const isExpanded = group.isExpanded !== false
          const filteredSessions = group.sessions.filter((s) =>
            filterQuery ? s.title.toLowerCase().includes(filterQuery.toLowerCase()) : true
          )

          return (
            <div key={group.id} className="space-y-0.5">
              {/* Project Title Bar */}
              <div
                onClick={() => toggleGroup(group.id)}
                className="flex items-center gap-1 px-2 py-1 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/70 rounded-md cursor-pointer transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 text-neutral-400 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-neutral-400 shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                )}
                <span className="truncate font-medium text-[11px] flex-1">{group.name}</span>
                <span className="text-[10px] text-neutral-400 font-mono">
                  {filteredSessions.length}
                </span>
              </div>

              {/* Conversations under project */}
              {isExpanded && (
                <div className="pl-4 space-y-0.5">
                  {filteredSessions.length === 0 ? (
                    <div className="px-2 py-1 text-[10px] text-neutral-400 italic">
                      No conversations
                    </div>
                  ) : (
                    filteredSessions.map((session) => {
                      const isSelected = currentConversationId === session.id
                      const timeAgo = formatTimeAgo(session.updatedAt)
                      return (
                        <SessionRowDraggable key={session.id} sessionId={session.id} isEditing={editingSessionId === session.id}>
                        <div
                          onClick={() =>
                            onSelectConversation?.(session.id, session.title, group.name)
                          }
                          className={`group/item flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer transition-colors text-[11px] ${
                            isSelected
                              ? 'bg-neutral-200/75 text-neutral-900 font-medium shadow-2xs'
                              : 'text-neutral-600 hover:bg-neutral-100/80 hover:text-neutral-900'
                          }`}
                          title={session.title}
                        >
                          {editingSessionId === session.id ? (
                            <div className="flex items-center gap-1 flex-1 mr-1" onClick={(e) => e.stopPropagation()}>
                              <input
                                autoFocus
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveRename(session.id)
                                  else if (e.key === 'Escape') handleCancelRename()
                                }}
                                onBlur={() => handleSaveRename(session.id)}
                                className="w-full text-[11px] bg-white border border-blue-400 rounded px-1.5 py-0.5 outline-none font-sans text-neutral-900 shadow-xs"
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveRename(session.id)}
                                className="p-0.5 text-blue-600 hover:text-blue-800 rounded"
                                title="Save title"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            <>
                              <span
                                onDoubleClick={(e) => handleStartRename(e, session)}
                                className="truncate mr-1 flex-1"
                              >
                                {session.title}
                              </span>
                              {/* Blue dot indicator for active session */}
                              {isSelected && (
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 mr-1" />
                              )}
                            </>
                          )}

                          {/* Action / Timestamp area */}
                          <div className="flex items-center gap-0.5 shrink-0">
                            <span className="text-[10px] text-neutral-400 font-mono group-hover/item:hidden">
                              {timeAgo || 'now'}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => handleStartRename(e, session)}
                              className="hidden group-hover/item:flex items-center justify-center p-0.5 text-neutral-400 hover:text-neutral-700 rounded transition-colors"
                              title="Rename conversation"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDelete(e, session.id)}
                              className="hidden group-hover/item:flex items-center justify-center p-0.5 text-neutral-400 hover:text-red-500 rounded transition-colors"
                              title="Delete conversation"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        </SessionRowDraggable>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom Pinned: Settings Button */}
      <div className="p-3 bg-[#fbfbfb] border-t border-neutral-200/50">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-2 px-2 py-1 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-md w-full transition-colors"
        >
          <Settings className="w-3.5 h-3.5 text-neutral-500" />
          <span className="font-medium text-[11px]">Settings</span>
        </button>
      </div>
    </aside>
  )
}

/**
 * 会话行拖拽包装(§5 左右互拖):拖出 = 作为 {kind:'target'} 落到工作区 pane。
 * 重命名态不带监听(输入框 8px 位移会误触发拖拽);拖出后原行仍在(收回语义对称)。
 */
function SessionRowDraggable({
  sessionId,
  isEditing,
  children
}: {
  sessionId: string
  isEditing: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: `sidebar-session:${sessionId}`,
    data: { payload: { kind: 'target' as const, target: { kind: 'chat' as const, sessionId } } }
  })
  return (
    <div
      ref={setNodeRef}
      {...(isEditing ? {} : listeners)}
      {...(isEditing ? {} : attributes)}
      className="touch-none"
    >
      {children}
    </div>
  )
}

export default Sidebar
