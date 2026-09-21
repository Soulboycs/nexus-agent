import { useEffect, useState } from 'react'
import { File as FileIcon, Folder, MessageSquare } from 'lucide-react'
import type { FileTreeNode, SessionSummary } from '@shared/types'
import { usePaneHost } from '../pane-host-context'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * 审查/概览 pane(T3,真实数据):工作区文件树(顶层)+ 会话摘要列表。
 * 数据来自既有 IPC(readWorkspaceFiles / listSessions),无 mock。
 */
export function ReviewPane(_props: TabContentProps<Extract<TabTarget, { kind: 'review' }>>) {
  const host = usePaneHost()
  const [files, setFiles] = useState<FileTreeNode[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])

  useEffect(() => {
    if (!host.workspace) return
    let cancelled = false
    window.electronAPI
      ?.readWorkspaceFiles?.(host.workspace)
      .then((tree) => {
        if (!cancelled) setFiles(tree || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [host.workspace])

  useEffect(() => {
    void (async () => {
      try {
        const list = (await window.electronAPI?.listSessions?.(host.workspace || undefined)) || []
        setSessions(list.slice(0, 12))
      } catch {}
    })()
  }, [host.workspace, host.workspace])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-white p-4 space-y-5" data-testid="review-pane">
      <section>
        <h3 className="text-xs font-semibold text-neutral-700 mb-2">工作区文件(顶层)</h3>
        {files.length === 0 ? (
          <div className="text-xs text-neutral-400">当前工作区无文件或未选择工作区</div>
        ) : (
          <ul className="space-y-1">
            {files.slice(0, 40).map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-xs text-neutral-600">
                {f.isDirectory ? (
                  <Folder className="w-3.5 h-3.5 text-blue-400" />
                ) : (
                  <FileIcon className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span className="truncate">{f.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="text-xs font-semibold text-neutral-700 mb-2">会话摘要</h3>
        {sessions.length === 0 ? (
          <div className="text-xs text-neutral-400">暂无会话</div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-xs text-neutral-600">
                <MessageSquare className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                <span className="truncate flex-1">{s.title}</span>
                <span className="text-[10px] text-neutral-300 shrink-0">{s.messageCount ?? 0} 条</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
