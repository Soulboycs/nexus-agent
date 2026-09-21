import React, { useState, useRef, useEffect, useCallback } from 'react'
import { X, Maximize2, Minimize2, FileText, GripVertical } from 'lucide-react'
import { LocaleProvider } from './i18n/locale'
import { App as WordEditorApp } from './App'
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
import './styles.css'
import './fonts/fonts.css'

interface WordWorkbenchDrawerProps {
  isOpen: boolean
  onClose: () => void
}

const DEFAULT_WIDTH = 860
const MIN_WIDTH = 550

export const WordWorkbenchDrawer: React.FC<WordWorkbenchDrawerProps> = ({ isOpen, onClose }) => {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH)
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
      // ignore in tests or re-renders
    }
  }, [])

  // Drag to resize width with rAF and direct DOM manipulation
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
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
        const newWidth = Math.max(
          MIN_WIDTH,
          Math.min(window.innerWidth - 80, dragStartWidthRef.current + delta)
        )
        currentWidthRef.current = newWidth
        if (asideRef.current) {
          asideRef.current.style.width = `${newWidth}px`
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
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    window.addEventListener('mouseup', handleMouseUp)
  }, [])

  if (!isOpen) return null

  const computedWidth = isMaximized ? '100vw' : `${width}px`

  return (
    <aside
      ref={asideRef}
      className={`fixed top-16 right-0 bottom-0 z-40 bg-white border-l border-neutral-200 shadow-2xl flex flex-col ${
        isMaximized ? 'transition-all duration-200' : 'transition-none'
      } ${isDragging ? 'select-none' : ''}`}
      style={{ width: computedWidth, maxWidth: '100vw' }}
      aria-label="Word Workbench"
    >
      {/* Draggable left border handle */}
      {!isMaximized && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute -left-2 top-0 bottom-0 w-4 cursor-col-resize flex items-center justify-center group z-50 hover:bg-blue-500/10 transition-colors"
          title="拖动调整宽度"
        >
          <div className="w-1 h-8 rounded-full bg-neutral-300 group-hover:bg-blue-500 transition-colors flex items-center justify-center">
            <GripVertical className="w-3 h-3 text-neutral-500 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      )}

      {/* Top Drawer Banner / Window Bar */}
      <div className="h-9 bg-neutral-100 border-b border-neutral-200 flex items-center justify-between px-3 select-none shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-white shadow-xs">
            <FileText className="w-3.5 h-3.5" />
          </div>
          <span className="text-xs font-semibold text-neutral-800">Word 文档工作台</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium">
            .docx
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Maximize / Restore */}
          <button
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1 rounded hover:bg-neutral-200 text-neutral-500 hover:text-neutral-800 transition-colors"
            title={isMaximized ? '还原窗口' : '最大化窗口'}
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-red-100 text-neutral-500 hover:text-red-600 transition-colors"
            title="关闭 Word 工作台"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Embedded Full GenOffice Word Editor */}
      <div className="flex-1 overflow-hidden relative bg-[#f3f4f6]">
        <LocaleProvider initial="zh">
          <WordEditorApp />
        </LocaleProvider>
      </div>
    </aside>
  )
}
export default WordWorkbenchDrawer
