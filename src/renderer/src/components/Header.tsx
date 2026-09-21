import React from 'react'
import { FolderOpen, Settings, Square, Sparkles, Terminal } from 'lucide-react'
import { AgentStatus, ModelProvider } from '@shared/types'

import { ModelSelector } from './ModelSelector'

interface HeaderProps {
  workspace: string
  status: AgentStatus
  statusMessage?: string
  currentModelId: string
  onModelChange: (modelId: string, providerId?: string) => void
  onSelectWorkspace: () => void
  onOpenSettings: () => void
  onAbort: () => void
  onToggleTerminal: () => void
  isTerminalOpen: boolean
  providers?: ModelProvider[]
}

export const Header: React.FC<HeaderProps> = ({
  workspace,
  status,
  statusMessage,
  currentModelId,
  onModelChange,
  onSelectWorkspace,
  onOpenSettings,
  onAbort,
  onToggleTerminal,
  isTerminalOpen,
  providers
}) => {

  const getStatusBadge = () => {
    switch (status) {
      case 'thinking':
        return (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
            <Sparkles className="w-3 h-3" />
            <span>Thinking...</span>
          </div>
        )
      case 'tool_executing':
        return (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
            <span>Executing Tool</span>
          </div>
        )
      case 'awaiting_confirmation':
        return (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-bounce">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            <span>Action Awaiting Approval</span>
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
            <span>Error</span>
          </div>
        )
      default:
        return (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Ready</span>
          </div>
        )
    }
  }

  const isBusy = status === 'thinking' || status === 'tool_executing' || status === 'awaiting_confirmation'

  return (
    <header className="h-12 bg-[#16171b] border-b border-[#25262c] flex items-center justify-between px-4 draggable-area">
      {/* App Branding & Status */}
      <div className="flex items-center gap-3 non-draggable">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white font-bold text-xs shadow-md">
            AG
          </div>
          <span className="font-semibold text-sm tracking-tight text-white">Antigravity Code</span>
        </div>
        {getStatusBadge()}
        {statusMessage && (
          <span className="text-xs text-neutral-400 truncate max-w-md hidden md:inline">
            {statusMessage}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 non-draggable">
        {/* Workspace selector */}
        <button
          onClick={onSelectWorkspace}
          className="flex items-center gap-1.5 text-xs bg-[#1f2026] hover:bg-[#282930] text-neutral-300 hover:text-white px-2.5 py-1.5 rounded-md border border-[#2f3038] transition-colors max-w-[200px]"
          title={workspace}
        >
          <FolderOpen className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="truncate">{workspace.split(/[\\/]/).pop() || 'Select Workspace'}</span>
        </button>

        <div className="mx-1 h-4 w-px bg-[#2f3038]" />

        <ModelSelector
          currentModelId={currentModelId}
          onModelChange={onModelChange}
          onOpenSettings={onOpenSettings}
          providers={providers}
        />

        <div className="mx-1 h-4 w-px bg-[#2f3038]" />

        {/* Terminal toggle */}
        <button
          onClick={onToggleTerminal}
          className={`p-1.5 rounded-md border text-xs flex items-center gap-1 transition-colors ${
            isTerminalOpen
              ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
              : 'bg-[#1f2026] hover:bg-[#282930] border-[#2f3038] text-neutral-300'
          }`}
          title="Toggle Terminal"
        >
          <Terminal className="w-3.5 h-3.5" />
        </button>

        {/* Abort button when busy */}
        {isBusy && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 px-2 py-1.5 rounded-md transition-colors"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>Stop</span>
          </button>
        )}

        {/* Settings modal */}
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-md bg-[#1f2026] hover:bg-[#282930] text-neutral-300 hover:text-white border border-[#2f3038] transition-colors"
          title="LLM & Agent Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  )
}
