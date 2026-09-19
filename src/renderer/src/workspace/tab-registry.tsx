import React from 'react'
import type { TabTarget } from './layout-model'
import type { MentionCandidate } from '../utils/mentions'

/**
 * Tab 内容注册表(计划 §4.2,D1:pane 不分类型)。
 * 新内容类型只在这里注册,自动获得布局/拖拽/联动全部能力。
 * 内置 kind 的注册在 pane-content/index.tsx(registerBuiltinTabs,App 启动时调用)。
 */

export interface TabContentProps<T extends TabTarget = TabTarget> {
  target: T
  active: boolean
  /** 所属 tab 的 id(new_tab 落地页 retarget 用) */
  tabId?: string
}

export interface TabKindRegistration<T extends TabTarget = TabTarget> {
  kind: T['kind']
  title: (target: T) => string
  component: React.ComponentType<TabContentProps<T>>
  /** 侧栏收纳分区(阶段二拖拽使用) */
  sidebarSection: 'sessions' | 'docs'
  /**
   * new_tab 落地页卡片(§5.4"打开标签页"选择器):
   * 声明了 newCard 的 kind 会在落地页出现一张卡;点击后由 onCreateInTab 决定变成什么。
   */
  newCard?: {
    title: string
    icon: React.ReactNode
    description?: string
  }
  /** 卡片点击 → 该 tab 变成此 kind 的新实例(chat=新建会话;word=进入文档选择) */
  onCreateInTab?: (tabId: string) => void
  /**
   * §6.7 @ 提及扩展点:声明后,该 kind 的实例可作为 @ 候选被解析
   * (内置 chat/word 候选由 ChatPane 聚合;插件 kind 经此接入)
   */
  mentionSource?: () => MentionCandidate[]
}

const registrations = new Map<string, TabKindRegistration<any>>()

export function registerTabKind<T extends TabTarget>(reg: TabKindRegistration<T>): void {
  registrations.set(reg.kind, reg as TabKindRegistration<any>)
}

export function getTabRegistration(kind: TabTarget['kind']): TabKindRegistration | undefined {
  return registrations.get(kind)
}

/** 落地页卡片列表(注册顺序) */
export function getNewTabCards(): Array<{ kind: TabTarget['kind']; card: NonNullable<TabKindRegistration['newCard']> }> {
  const out: Array<{ kind: TabTarget['kind']; card: NonNullable<TabKindRegistration['newCard']> }> = []
  for (const reg of registrations.values()) {
    if (reg.newCard) out.push({ kind: reg.kind, card: reg.newCard })
  }
  return out
}

export function fireCreateInTab(kind: TabTarget['kind'], tabId: string): void {
  registrations.get(kind)?.onCreateInTab?.(tabId)
}

export function collectRegistryMentions(): MentionCandidate[] {
  const out: MentionCandidate[] = []
  for (const reg of registrations.values()) {
    if (!reg.mentionSource) continue
    for (const c of reg.mentionSource()) out.push(c)
  }
  return out
}

export function getTabTitle(target: TabTarget): string {
  return getTabRegistration(target.kind)?.title(target) ?? 'Untitled'
}

export function TabContent(props: { target: TabTarget; active: boolean; tabId?: string }): React.ReactElement | null {
  const reg = getTabRegistration(props.target.kind)
  if (!reg) return null
  const Component = reg.component
  return <Component target={props.target} active={props.active} tabId={props.tabId} />
}
