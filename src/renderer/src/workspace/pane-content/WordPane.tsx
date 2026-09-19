import { useEffect, useRef } from 'react'
import { acquireWordHost, openWordPath } from '../wordHost'
import { useLinkageStore } from '../linkage-store'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * word kind 真实实现(阶段三,计划 §6.4/§8.2):
 * - 激活时把全局单实例编辑器宿主化进本 pane,并确保打开目标路径;
 * - 路径→tabId 登记进联动路由表(pathToTab),agent docx 事件据此路由;
 * - 同路径全局唯一实例由宿主保证;后台 tab 由 RetainedPanel 隐藏保活。
 */
export function WordPane({ target, active, tabId }: TabContentProps<Extract<TabTarget, { kind: 'word' }>>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const registerWordTab = useLinkageStore((s) => s.registerWordTab)
  const unregisterWordTab = useLinkageStore((s) => s.unregisterWordTab)
  const clearUpdated = useLinkageStore((s) => s.clearUpdated)

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

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white" data-testid="word-pane">
      <div ref={containerRef} className="flex-1 min-h-0" data-word-container={target.path} />
    </div>
  )
}
