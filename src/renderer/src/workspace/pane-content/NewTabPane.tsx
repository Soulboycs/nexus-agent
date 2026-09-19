import { useState } from 'react'
import { MessageSquareText, FileText, ChevronLeft } from 'lucide-react'
import { useLayoutStore } from '../layout-store'
import { getNewTabCards, fireCreateInTab } from '../tab-registry'
import { getRecentWordFiles } from '../../components/word/persistence'
import { basenameOf } from './paths'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * new_tab 落地页("打开标签页",§5.4/D1):
 * 卡片格子列出所有注册了 newCard 的内容类型——点卡即让本 pane 变成那种内容。
 * 注册表驱动:以后新增终端/浏览器等类型,这里自动多一张卡。
 */
export function NewTabPane({ tabId }: TabContentProps<Extract<TabTarget, { kind: 'new_tab' }>>) {
  const retargetTab = useLayoutStore((s) => s.retargetTab)
  const [picking, setPicking] = useState<'none' | 'docs'>('none')
  const [recentDocs, setRecentDocs] = useState<string[] | null>(null)

  const tid = tabId ?? ''
  const cards = getNewTabCards()

  const openDocPicker = () => {
    if (recentDocs === null) setRecentDocs(getRecentWordFiles())
    setPicking('docs')
  }

  if (picking === 'docs') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white" data-testid="new-tab-picker-docs">
        <button
          type="button"
          data-testid="picker-back"
          onClick={() => setPicking('none')}
          className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-600 mb-6"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> 返回
        </button>
        <h2 className="text-lg font-semibold text-neutral-900 mb-1">打开文档</h2>
        <p className="text-xs text-neutral-400 mb-5">选择最近打开的 Word 文档</p>
        {recentDocs && recentDocs.length > 0 ? (
          <div className="w-full max-w-md space-y-1.5">
            {recentDocs.slice(0, 6).map((p) => (
              <button
                key={p}
                type="button"
                data-testid={`pick-doc`}
                onClick={() => retargetTab(tid, { kind: 'word', path: p })}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-neutral-200/80 hover:border-blue-300 hover:bg-blue-50/50 text-left transition-colors"
              >
                <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                <span className="text-xs text-neutral-700 truncate flex-1">{basenameOf(p)}</span>
                <span className="text-[10px] text-neutral-300 truncate max-w-[180px]">{p}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-neutral-400">暂无最近文档——先在 Word 抽屉里打开一份,或让 agent 创建</div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white" data-testid="new-tab-landing">
      <h2 className="text-lg font-semibold text-neutral-900 mb-1.5">打开标签页</h2>
      <p className="text-xs text-neutral-400 mb-7">选择要在此窗格中打开的内容。</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg w-full justify-items-stretch">
        {cards.map(({ kind, card }) => (
          <button
            key={kind}
            type="button"
            data-testid={`new-tab-card-${kind}`}
            onClick={() => {
              if (kind === 'word') openDocPicker()
              else fireCreateInTab(kind, tid)
            }}
            className="flex flex-col items-center gap-2 py-6 px-3 rounded-2xl border border-neutral-200/80 bg-white hover:border-blue-300 hover:bg-blue-50/40 hover:shadow-sm transition-all"
          >
            <span className="text-neutral-500">{card.icon}</span>
            <span className="text-xs font-medium text-neutral-700">{card.title}</span>
            {card.description && <span className="text-[10px] text-neutral-400">{card.description}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export const NewTabIcon = MessageSquareText
