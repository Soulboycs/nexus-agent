import React from 'react'
import type { ModelProvider, PermissionMode } from '@shared/types'

/**
 * pane 宿主注入(计划 §8.1):全局性配置经 context 下发,
 * pane 内容组件不得感知布局树。
 */
export interface PaneHostContextValue {
  workspace: string
  providers: ModelProvider[]
  currentModelId: string
  currentProviderId: string
  onModelChange: (modelId: string, providerId?: string) => void
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  onOpenSettings: () => void
  /** chat pane 的 agent 触发 docx_ 工具时请求打开 Word dock(App 级单例) */
  onRequestWordDrawer: () => void
  /** 工具完成等信号 → App 级去抖刷新文件树 */
  notifyFilesDirty: () => void
}

export const PaneHostContext = React.createContext<PaneHostContextValue | null>(null)

export function usePaneHost(): PaneHostContextValue {
  const v = React.useContext(PaneHostContext)
  if (!v) throw new Error('PaneHostContext missing: SplitRenderer must be mounted inside provider')
  return v
}
