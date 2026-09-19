import React, { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Trash2, X } from 'lucide-react'

interface TerminalViewProps {
  isOpen: boolean
  onClose?: () => void
  /** pane 内嵌模式:占满容器、隐藏关闭按钮(T1 终端 pane) */
  variant?: 'drawer' | 'pane'
}

export const TerminalView: React.FC<TerminalViewProps> = ({ isOpen, onClose, variant = 'drawer' }) => {
  const lineRef = useRef('')
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      theme: {
        background: '#0d0e12',
        foreground: '#e5e7eb',
        cursor: '#3b82f6',
        black: '#1f2937',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#f3f4f6'
      },
      fontFamily: 'Consolas, "Fira Code", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    term.writeln('\x1b[38;5;39m[Antigravity Terminal Ready]\x1b[0m Type or watch agent command output here.')

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    // Subscribe to IPC terminal data
    const unsubscribe = window.electronAPI?.onTerminalData?.((data: string) => {
      term.write(data)
    })

    // 行模式(T1):管道 shell 无 TTY 回显,本地编辑整行、回车发送
    term.onData((data) => {
      if (data === '\r') {
        term.write('\r\n')
        const line = lineRef.current
        lineRef.current = ''
        if (line.trim()) window.electronAPI?.sendTerminalInput?.(line)
        return
      }
      if (data === '\x7f') {
        if (lineRef.current.length > 0) {
          lineRef.current = lineRef.current.slice(0, -1)
          term.write('\b \b')
        }
        return
      }
      for (const ch of data) {
        if (ch >= ' ') {
          lineRef.current += ch
          term.write(ch)
        }
      }
    })

    const handleResize = () => {
      try {
        fitAddon.fit()
      } catch {}
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      unsubscribe?.()
      term.dispose()
    }
  }, [])

  useEffect(() => {
    if (isOpen && fitAddonRef.current) {
      setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
        } catch {}
      }, 100)
    }
  }, [isOpen])

  const handleClear = () => {
    xtermRef.current?.clear()
  }

  if (!isOpen) return null

  const paneMode = variant === 'pane'
  return (
    <div className={`${paneMode ? 'h-full w-full' : 'h-64 border-t border-[#262833]'} bg-[#0d0e12] flex flex-col shrink-0 animate-in slide-in-from-bottom-2`}>
      {/* Terminal Bar */}
      <div className="h-8 bg-[#15161c] px-3 flex items-center justify-between border-b border-[#22242c] text-xs text-neutral-400">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
          <span>Embedded Shell Output</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleClear}
            className="p-1 hover:bg-[#22242c] rounded text-neutral-400 hover:text-white transition-colors"
            title="Clear Terminal"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-[#22242c] rounded text-neutral-400 hover:text-white transition-colors"
              title="Close Terminal"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Terminal View Container */}
      <div ref={containerRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  )
}
