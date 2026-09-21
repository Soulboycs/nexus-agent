import React from 'react'
import {
  PanelLeft,
  PanelRight,
  ChevronLeft,
  ChevronRight,
  MoreVertical
} from 'lucide-react'

interface AntigravityTopBarProps {
  currentProject?: string
  currentConversationTitle?: string
  onToggleSidebar?: () => void
  isSidebarOpen?: boolean
  onToggleAuxiliaryBar?: () => void
  isAuxiliaryBarOpen?: boolean
}

export const AntigravityTopBar: React.FC<AntigravityTopBarProps> = ({
  currentProject = 'Agent',
  currentConversationTitle = 'AI Agent Reference Projects',
  onToggleSidebar,
  isSidebarOpen = true,
  onToggleAuxiliaryBar,
  isAuxiliaryBarOpen = false
}) => {
  return (
    <header className="flex flex-col bg-white select-none shrink-0 w-full">
      {/* Row 1: Top Desktop Menubar (Draggable window area with right window controls buffer) */}
      <div className="draggable-area flex items-center justify-between pl-3.5 h-7 text-[12px] text-neutral-600 bg-white pr-36">
        <div className="non-draggable flex items-center gap-4">
          <span className="cursor-default text-neutral-700 hover:text-neutral-900 transition-colors">
            Antigravity
          </span>
          <span className="cursor-default hover:text-neutral-900 transition-colors">File</span>
          <span className="cursor-default hover:text-neutral-900 transition-colors">View</span>
          <span className="cursor-default hover:text-neutral-900 transition-colors">Window</span>
        </div>
      </div>

      {/* Row 2: Navigation, Breadcrumbs & Right Utility Actions */}
      <div className="flex items-center h-9 w-full border-b border-neutral-200/70 bg-white">
        {/* Left Section (Sidebar Header Width: w-60 with matching border-r) */}
        <div
          className={`${
            isSidebarOpen ? 'w-60 border-r border-neutral-200/80' : 'w-auto'
          } h-full flex items-center px-3 gap-1 shrink-0 bg-white`}
        >
          {/* Antigravity ^ Logo */}
          <div className="w-5 h-5 flex items-center justify-center text-black mr-1 cursor-default" title="Antigravity">
            <svg
              className="w-3.5 h-3.5 stroke-black stroke-[3] fill-none"
              viewBox="0 0 24 24"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 16 12 8 20 16" />
            </svg>
          </div>

          {/* Toggle Sidebar Icon */}
          <button
            type="button"
            onClick={onToggleSidebar}
            className={`p-1 rounded hover:bg-neutral-100 text-neutral-500 hover:text-neutral-800 transition-colors ${
              !isSidebarOpen ? 'bg-neutral-100 text-neutral-900' : ''
            }`}
            title="Toggle Sidebar"
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          {/* Back Button */}
          <button
            type="button"
            className="p-1 rounded hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 transition-colors"
            title="Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Forward Button */}
          <button
            type="button"
            className="p-1 rounded text-neutral-300 cursor-default"
            title="Forward"
            disabled
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Right Section: Breadcrumbs and Actions */}
        <div className="flex-1 h-full flex items-center justify-between px-3">
          {/* Breadcrumbs */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-neutral-500 hover:text-neutral-800 cursor-pointer transition-colors">
              {currentProject}
            </span>
            <span className="text-neutral-300">/</span>
            <span className="text-neutral-900 font-medium truncate max-w-md cursor-default">
              {currentConversationTitle}
            </span>
          </div>

          {/* Right Action Icons: ⋮, Install IDE, ◫ */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="p-1 rounded hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 transition-colors"
              title="More actions"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-neutral-700 hover:bg-neutral-100 transition-colors font-medium border border-neutral-200/60 shadow-2xs"
              title="Install IDE Extension"
            >
              <span className="text-blue-600 font-bold text-[10px]">▲</span>
              <span className="text-[11px]">Install IDE</span>
            </button>

            <button
              type="button"
              onClick={onToggleAuxiliaryBar}
              className={`p-1 rounded hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 transition-colors ${
                isAuxiliaryBarOpen ? 'bg-neutral-100 text-blue-600' : ''
              }`}
              title="Toggle Word Workbench"
            >
              <PanelRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

export default AntigravityTopBar
