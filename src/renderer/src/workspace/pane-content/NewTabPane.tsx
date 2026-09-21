import { useLayoutStore } from '../layout-store'
import { getNewTabCards, fireCreateInTab } from '../tab-registry'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * new_tab 落地页("打开标签页",§5.4/D1):
 * 卡片格子列出所有注册了 newCard 的内容类型——点卡即让本 pane 变成那种内容。
 * 注册表驱动:以后新增终端/浏览器等类型,这里自动多一张卡。
 */
export function NewTabPane({ tabId }: TabContentProps<Extract<TabTarget, { kind: 'new_tab' }>>) {
  const tid = tabId ?? ''
  const cards = getNewTabCards()

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
              if (kind === 'word') {
                useLayoutStore.getState().retargetTab(tid, { kind: 'word', path: '' })
              } else {
                fireCreateInTab(kind, tid)
              }
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

