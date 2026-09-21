import { useRef, useState } from 'react'
import { ArrowLeft, Globe, Search } from 'lucide-react'
import type { TabContentProps } from '../tab-registry'
import type { TabTarget } from '../layout-model'

/**
 * 浏览器 pane(T2):Electron webview 标签 + 地址栏。
 * 轻量内置浏览器(默认会话分区,不隔离代理/Cookie 策略)。
 */
export function BrowserPane({
  target
}: TabContentProps<Extract<TabTarget, { kind: 'browser' }>>) {
  const [url, setUrl] = useState<string>(target.startUrl || '')
  const [committed, setCommitted] = useState<string>(target.startUrl || '')
  const webviewRef = useRef<Electron.WebviewTag | null>(null)

  const go = (raw: string) => {
    let u = raw.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u) && !u.startsWith('about:')) u = 'https://' + u
    setCommitted(u)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white" data-testid="browser-pane">
      <div className="h-9 shrink-0 flex items-center gap-1.5 px-2 border-b border-neutral-200 bg-neutral-50">
        <button
          type="button"
          aria-label="Back"
          onClick={() => webviewRef.current?.goBack()}
          className="p-1 rounded hover:bg-neutral-200/70 text-neutral-500"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <form
          className="flex-1 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            go(url)
          }}
        >
          <Search className="w-3.5 h-3.5 text-neutral-400" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="输入网址,如 example.com"
            className="flex-1 text-xs px-2 py-1 rounded-md border border-neutral-200 focus:border-blue-400 outline-none bg-white"
          />
        </form>
      </div>
      {committed ? (
        <webview
          ref={webviewRef as never}
          src={committed}
          className="flex-1 min-h-0 w-full"
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-neutral-300">
          <Globe className="w-10 h-10" />
          <div className="text-xs">在上方输入网址开始浏览</div>
        </div>
      )}
    </div>
  )
}
