import { TerminalView } from '../../components/TerminalView'

/** 终端 pane(T1):复用全局 shell 通道的行模式终端,与底部抽屉共享同一 shell。 */
export function TerminalPane() {
  return (
    <div className="flex-1 min-h-0 bg-[#0d0e12]" data-testid="terminal-pane">
      <TerminalView isOpen variant="pane" />
    </div>
  )
}
