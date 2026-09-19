import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  FileText,
  Bot,
  Terminal as TerminalIcon,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Sparkles,
  FileCode2,
  CheckCircle2,
  Clock,
  X,
  Maximize2,
  Minimize2,
  GripVertical
} from 'lucide-react'

// Word Editor dependencies
import { installScreenTips } from '@genoffice/ui'

// Styles for Word Editor
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@genoffice/ui/image-viewer.css'
import './word/styles.css'
import './word/fonts/fonts.css'

export interface SubagentItem {
  id: string
  name: string
  role: string
  status: string
  duration?: string
}

export interface ArtifactItem {
  id: string
  title: string
  type: string
  path?: string
}

export interface RightAuxiliaryBarProps {
  isOpen: boolean
  onClose: () => void
  onOpenTerminal?: () => void
  activeSubagents?: SubagentItem[]
  artifacts?: ArtifactItem[]
  changedFilesCount?: number
}

const DEFAULT_WIDTH = 760
const MIN_WIDTH = 420
const STORAGE_KEY = 'nexus_auxiliary_bar_width'

export const RightAuxiliaryBar: React.FC<RightAuxiliaryBarProps> = ({
  isOpen,
  onClose,
  onOpenTerminal,
  activeSubagents = [
    {
      id: 'qa-auditor',
      name: 'Word 1:1 QA Auditor',
      role: '独立 QA 审查专家',
      status: '已就绪',
      duration: 'Worked for 10m'
    },
    {
      id: 'engine-researcher',
      name: 'Word Engine & Architecture Researcher',
      role: '底层 OOXML 引擎调研',
      status: '已就绪',
      duration: 'Worked for 6m'
    }
  ],
  artifacts = [
    { id: '1', title: 'Walkthrough', type: 'doc' },
    { id: '2', title: 'Agent', type: 'doc' },
    { id: '3', title: 'Implementation Plan', type: 'doc' }
  ],
  changedFilesCount = 402
}) => {
  // Current view mode inside the docked sidebar: 'word' (Word 文档工作台) or 'overview' (Antigravity 概览)
  const [activeTab, setActiveTab] = useState<'word' | 'overview'>(() => {
    try {
      const saved = localStorage.getItem('nexus_auxiliary_active_tab')
      if (saved === 'word' || saved === 'overview') return saved
    } catch {}
    return 'word'
  })

  const handleTabChange = useCallback((tab: 'word' | 'overview') => {
    setActiveTab(tab)
    try {
      localStorage.setItem('nexus_auxiliary_active_tab', tab)
    } catch {}
  }, [])

  // Load persisted width from localStorage or fallback to default
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const val = parseInt(saved, 10)
        if (!isNaN(val) && val >= MIN_WIDTH) return val
      }
    } catch {}
    return DEFAULT_WIDTH
  })

  const [isMaximized, setIsMaximized] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)

  const asideRef = useRef<HTMLElement>(null)
  const dragStartXRef = useRef<number>(0)
  const dragStartWidthRef = useRef<number>(DEFAULT_WIDTH)
  const currentWidthRef = useRef<number>(width)
  const rafIdRef = useRef<number | null>(null)

  useEffect(() => {
    currentWidthRef.current = width
  }, [width])

  useEffect(() => {
    try {
      installScreenTips()
    } catch {
      // ignore
    }
  }, [])

  // High-performance drag handle: direct DOM manipulation + requestAnimationFrame (0 React re-renders during mousemove)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    setIsDragging(true)
    document.body.classList.add('is-sidebar-resizing')
    ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = true
    window.dispatchEvent(new CustomEvent('sidebar-resize-start'))
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    dragStartXRef.current = e.clientX
    const initialWidth = asideRef.current ? asideRef.current.offsetWidth : currentWidthRef.current
    dragStartWidthRef.current = initialWidth
    currentWidthRef.current = initialWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
      rafIdRef.current = requestAnimationFrame(() => {
        const delta = dragStartXRef.current - moveEvent.clientX
        const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 320)
        const nextWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, dragStartWidthRef.current + delta))
        currentWidthRef.current = nextWidth
        if (asideRef.current) {
          asideRef.current.style.width = `${nextWidth}px`
        }
      })
    }

    const handleMouseUp = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      setIsDragging(false)
      document.body.classList.remove('is-sidebar-resizing')
      ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''

      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)

      const finalWidth = currentWidthRef.current
      setWidth(finalWidth)
      window.dispatchEvent(new CustomEvent('sidebar-resize-end', { detail: { width: finalWidth } }))
      try {
        localStorage.setItem(STORAGE_KEY, String(finalWidth))
      } catch {}
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    window.addEventListener('mouseup', handleMouseUp)
  }, [])

  // Accordion states for overview tab
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    subagents: true,
    files: true,
    artifacts: true,
    skills: true
  })

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  useEffect(() => {
    const handleFocus = () => handleTabChange('word')
    window.addEventListener('nexus-word-focus', handleFocus)
    return () => window.removeEventListener('nexus-word-focus', handleFocus)
  }, [handleTabChange])

  const computedWidth = isMaximized ? '100%' : `${width}px`

  return (
    <>
      {/* Global transparent overlay during drag to prevent any DOM event hijacking */}
      {isDragging && (
        <div
          className="fixed inset-0 z-[9999] cursor-col-resize select-none bg-transparent"
          style={{ pointerEvents: 'auto' }}
        />
      )}

      <aside
        ref={asideRef}
        className={`relative shrink-0 h-full border-l border-neutral-200/80 bg-white flex flex-col z-20 text-neutral-800 ${
          isMaximized ? 'transition-all duration-200 ease-out' : 'transition-none'
        } ${isDragging ? 'select-none' : ''} ${!isOpen ? 'hidden' : ''}`}
        style={{
          width: computedWidth,
          maxWidth: isMaximized ? '100%' : 'calc(100vw - 260px)',
          display: isOpen ? 'flex' : 'none'
        }}
        aria-label="Antigravity Right Sidebar"
      >
        {/* Draggable left border handle */}
        {!isMaximized && (
          <div
            onMouseDown={handleMouseDown}
            className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize flex items-center justify-center group z-50 hover:bg-blue-500/10 transition-colors"
            title="拖动调整侧边栏宽度"
          >
            <div className="w-1 h-8 rounded-full bg-neutral-300 opacity-0 group-hover:opacity-100 group-hover:bg-blue-500 transition-all flex items-center justify-center">
              <GripVertical className="w-2.5 h-2.5 text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        )}

        {/* Top Header Controls (1:1 Antigravity Tabs) */}
        <div className="h-9 border-b border-neutral-200/70 flex items-center justify-between px-3 shrink-0 bg-neutral-50/70">
          {/* Left Tabs: [Word 文档] & [概览 & 审查] */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleTabChange('word')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'word'
                  ? 'bg-white text-blue-600 shadow-2xs border border-neutral-200/60'
                  : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/60'
              }`}
            >
              <FileText className="w-3.5 h-3.5 text-blue-600" />
              <span>Word 文档</span>
            </button>

            <button
              type="button"
              onClick={() => handleTabChange('overview')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'overview'
                  ? 'bg-white text-neutral-800 shadow-2xs border border-neutral-200/60'
                  : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/60'
              }`}
            >
              <Bot className="w-3.5 h-3.5" />
              <span>概览 & 审查</span>
            </button>
          </div>

          {/* Right Window Controls: Maximize/Restore & Close */}
          <div className="flex items-center gap-1 text-neutral-400">
            <button
              type="button"
              onClick={() => setIsMaximized(!isMaximized)}
              className="p-1 rounded hover:bg-neutral-200/60 text-neutral-500 hover:text-neutral-800 transition-colors"
              title={isMaximized ? '还原侧边栏宽度' : '最大化侧边栏'}
            >
              {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-neutral-200/60 text-neutral-500 hover:text-red-600 transition-colors"
              title="收起侧边栏"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 🌟 Tab 1: Word 编辑器已迁入工作区窗格(阶段三 §6.4:单实例宿主,避免双实例内存/串扰)。
            此处保留引导文案;文档编辑请在工作区用"文档"卡片或拖拽打开。 */}
        <div
          className={`flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400 bg-white ${
            activeTab === 'word' ? '' : 'hidden'
          } ${isDragging ? 'pointer-events-none select-none' : ''}`}
        >
          <FileText className="w-10 h-10 text-neutral-300" />
          <div className="text-sm">Word 编辑器已移入工作区窗格</div>
          <div className="text-xs text-neutral-300 max-w-xs text-center">
            在工作区分割窗格时选择「文档」卡片即可打开与编辑,agent 改动会自动跟随
          </div>
        </div>

        {/* 🌟 Tab 2: Antigravity 侧边栏概览 (Subagents, Files Changed, Artifacts, Skills) */}
        <div
          className={`flex-1 overflow-y-auto divide-y divide-neutral-100 py-1 ${
            activeTab === 'overview' ? '' : 'hidden'
          } ${isDragging ? 'pointer-events-none select-none' : ''}`}
        >
          {/* Quick Word Launch Card */}
          <div className="p-3 bg-gradient-to-b from-blue-50/60 to-white/40 border-b border-blue-100/60">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-white shadow-2xs">
                  <FileText className="w-3 h-3" />
                </div>
                <span className="text-xs font-semibold text-neutral-900">Word 文档工作台</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-100 text-blue-700 font-medium">
                .docx
              </span>
            </div>
            <p className="text-[11px] text-neutral-500 mb-2">
              Word 当前已内嵌在侧边栏中运行，随时点击即可开始排版编辑。
            </p>
            <button
              type="button"
              onClick={() => handleTabChange('word')}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-xs transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>切换至 Word 文档界面</span>
            </button>
          </div>

          {/* Section: Subagents */}
          <div className="py-1">
            <button
              type="button"
              onClick={() => toggleSection('subagents')}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-neutral-50 text-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                {openSections.subagents ? (
                  <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span>Subagents</span>
                <span className="text-[11px] text-neutral-400 font-normal">
                  {activeSubagents.length}
                </span>
              </div>
            </button>

            {openSections.subagents && (
              <div className="px-3 pb-2 pt-0.5 space-y-1.5">
                {activeSubagents.map((agent) => (
                  <div
                    key={agent.id}
                    className="p-2 rounded-lg bg-neutral-50/80 border border-neutral-200/60 text-xs"
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-medium text-neutral-800 truncate">{agent.name}</span>
                      <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium shrink-0">
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                        {agent.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-neutral-400">
                      <span>{agent.role}</span>
                      {agent.duration && (
                        <span className="flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" />
                          {agent.duration}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section: Files Changed */}
          <div className="py-1">
            <button
              type="button"
              onClick={() => toggleSection('files')}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-neutral-50 text-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                {openSections.files ? (
                  <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span>Files Changed</span>
                <span className="text-[11px] text-neutral-400 font-normal">
                  {changedFilesCount}
                </span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600 font-mono">
                Uncommitted
              </span>
            </button>

            {openSections.files && (
              <div className="px-3 pb-2 pt-1 space-y-1 text-xs text-neutral-600">
                <div className="flex items-center gap-2 py-0.5 text-neutral-700">
                  <FileCode2 className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="truncate font-mono text-[11px]">src/packages/docx-engine</span>
                </div>
                <div className="flex items-center gap-2 py-0.5 text-neutral-700">
                  <FileCode2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="truncate font-mono text-[11px]">src/renderer/components/word</span>
                </div>
                <div className="flex items-center gap-2 py-0.5 text-neutral-700">
                  <FileCode2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  <span className="truncate font-mono text-[11px]">
                    tests/docx/e2e-word-integration
                  </span>
                </div>
                <div className="text-[10px] text-neutral-400 pt-1">
                  See all changes in git status ({changedFilesCount} files)
                </div>
              </div>
            )}
          </div>

          {/* Section: Artifacts */}
          <div className="py-1">
            <button
              type="button"
              onClick={() => toggleSection('artifacts')}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-neutral-50 text-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                {openSections.artifacts ? (
                  <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span>Artifacts</span>
                <span className="text-[11px] text-neutral-400 font-normal">
                  {artifacts.length}
                </span>
              </div>
            </button>

            {openSections.artifacts && (
              <div className="px-3 pb-2 pt-1 space-y-1">
                {artifacts.map((art) => (
                  <div
                    key={art.id}
                    onClick={() => handleTabChange('word')}
                    className="flex items-center justify-between py-1 px-2 rounded-md hover:bg-neutral-100/70 text-xs text-neutral-700 cursor-pointer group"
                    title="在 Word 工作台中打开"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileText className="w-3.5 h-3.5 text-neutral-400 group-hover:text-blue-600 transition-colors shrink-0" />
                      <span className="truncate font-medium">{art.title}</span>
                    </div>
                    <ExternalLink className="w-3 h-3 text-neutral-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section: Skills Used */}
          <div className="py-1">
            <button
              type="button"
              onClick={() => toggleSection('skills')}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-neutral-50 text-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                {openSections.skills ? (
                  <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span>Skills Used</span>
                <span className="text-[11px] text-neutral-400 font-normal">2</span>
              </div>
            </button>

            {openSections.skills && (
              <div className="px-3 pb-2 pt-1 space-y-1.5 text-xs">
                <div className="p-1.5 rounded bg-neutral-50 border border-neutral-200/50">
                  <div className="font-mono text-[11px] font-medium text-neutral-800 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-purple-500" />
                    evidence-driven-engineering
                  </div>
                  <div className="text-[10px] text-neutral-400 truncate">
                    /agent/.agents/skills/evidence-driven-engineering
                  </div>
                </div>
                <div className="p-1.5 rounded bg-neutral-50 border border-neutral-200/50">
                  <div className="font-mono text-[11px] font-medium text-neutral-800 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-blue-500" />
                    genoffice
                  </div>
                  <div className="text-[10px] text-neutral-400 truncate">
                    /genoffice/skills/genoffice
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section: Terminals */}
          <div className="py-1">
            <button
              type="button"
              onClick={onOpenTerminal}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-neutral-50 text-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                <TerminalIcon className="w-3.5 h-3.5 text-neutral-400" />
                <span>Terminals</span>
              </div>
              <span className="text-[11px] text-neutral-400">打开终端</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

export default RightAuxiliaryBar
