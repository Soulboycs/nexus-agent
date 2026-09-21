import { useEffect, useRef } from 'react'
import { FolderOpen } from 'lucide-react'
import { acquireWordHost, openWordPath } from '../wordHost'
import { useLinkageStore } from '../linkage-store'
import { useLayoutStore } from '../layout-store'
import { addRecentWordFile } from '../../components/word/persistence'
import { basenameOf } from './paths'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * word kind 真实实现(阶段三,计划 §6.4/§8.2):
 * - 工具条:「打开…」(文件选择框)与「最近」列表——换文档的入口(用户实测反馈);
 * - 激活时把全局单实例编辑器宿主化进本 pane 并打开目标路径(直通 API + 就绪轮询);
 * - 路径→tabId 登记联动路由表(pathToTab);同路径全局唯一实例由宿主保证。
 */
export function WordPane({ target, active, tabId }: TabContentProps<Extract<TabTarget, { kind: 'word' }>>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const registerWordTab = useLinkageStore((s) => s.registerWordTab)
  const unregisterWordTab = useLinkageStore((s) => s.unregisterWordTab)
  const clearUpdated = useLinkageStore((s) => s.clearUpdated)
  const retargetTab = useLayoutStore((s) => s.retargetTab)

  // 激活:宿主化 + 打开路径 + 清角标
  useEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (el) acquireWordHost(el)
    openWordPath(target.path)
    clearUpdated(target.path)
  }, [active, target.path, clearUpdated])

  // 路由登记:挂载登记、卸载注销
  useEffect(() => {
    const tid = tabId ?? `word:${target.path}`
    registerWordTab(tid, target.path)
    return () => unregisterWordTab(tid)
  }, [tabId, target.path, registerWordTab, unregisterWordTab])

  const switchDoc = (path: string) => {
    addRecentWordFile(path)
    // 本 tab 原位换成新文档(retarget 驱动 effect 重新打开)
    retargetTab(tabId ?? '', { kind: 'word', path })
  }

  const pickDoc = async () => {
    try {
      const path = await window.desktop?.pickDocxPath?.()
      if (path) switchDoc(path)
    } catch (e) {
      console.error('[WordPane] pick docx failed:', e)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white" data-testid="word-pane">
      {/* 工具条:打开… */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-neutral-200 bg-neutral-50 select-none">
        <button
          type="button"
          data-testid="word-open-file"
          onClick={() => void pickDoc()}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-neutral-600 hover:bg-neutral-200/70"
          title="从磁盘选择 Word 文档"
        >
          <FolderOpen className="w-3.5 h-3.5" /> 打开…
        </button>
        <span className="ml-auto text-[11px] text-neutral-400 truncate max-w-[40%]" title={target.path}>
          {basenameOf(target.path)}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" data-word-container={target.path} />
    </div>
  )
}
