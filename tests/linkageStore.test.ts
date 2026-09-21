/**
 * TDD Test Suite: P3-c 联动 store(计划 §6.3/6.4/6.5)
 * pathToTab 路由、lastTouch 记忆、角标、暂停跟随/抑制、旧映射迁移。
 * 注意:zustand getState() 是快照,action 后必须重取。
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useLinkageStore } from '../src/renderer/src/workspace/linkage-store'
import { normalizeKeyPath } from '../src/shared/paths'

// bun node 环境无 localStorage,垫片(仅本套件用)
;(globalThis as any).localStorage = {
  _m: {} as Record<string, string>,
  getItem(k: string) { return (this._m as any)[k] ?? null },
  setItem(k: string, v: string) { (this._m as any)[k] = String(v) },
  removeItem(k: string) { delete (this._m as any)[k] }
}

const key = (p: string) => normalizeKeyPath(p)
const S = () => useLinkageStore.getState()

beforeEach(() => S().resetForTest())

describe('linkage-store — 路由/记忆/角标/取消/迁移', () => {
  it('L1 word tab 开/关登记与注销 pathToTab', () => {
    S().registerWordTab('tab1', 'D:\\论文\\A.docx')
    expect(S().pathToTab[key('d:/论文/a.docx')]).toBe('tab1')
    S().unregisterWordTab('tab1')
    expect(S().pathToTab[key('d:/论文/a.docx')]).toBeUndefined()
  })

  it('L2 lastTouch:last-writer-wins + 清除', () => {
    S().setLastTouch('D:\\a.docx', 'sessA')
    S().setLastTouch('d:/a.docx', 'sessB') // 同一 key(规范化后)
    expect(Object.keys(S().lastTouch).length).toBe(1)
    expect(S().lastTouch[key('d:/a.docx')]).toBe('sessB')
    S().clearLastTouch('D:\\a.docx')
    expect(S().lastTouch[key('d:/a.docx')]).toBeUndefined()
  })

  it('L3 更新角标:markUpdated 置位,clearUpdated 清除', () => {
    S().markUpdated('D:\\a.docx')
    expect(S().isUpdated('D:\\a.docx')).toBe(true)
    S().clearUpdated('D:\\a.docx')
    expect(S().isUpdated('D:\\a.docx')).toBe(false)
  })

  it('L4 暂停跟随 / 抑制自动打开 / 落位记忆', () => {
    S().setFollowPaused('tab1', true)
    expect(S().followPaused['tab1']).toBe(true)
    S().setFollowPaused('tab1', false)
    expect(S().followPaused['tab1']).toBeUndefined() // 解除即删键(稀疏状态)
    S().suppress('D:\\x.docx')
    expect(S().isSuppressed('d:/x.docx')).toBe(true)
    S().setPanePreference('sessA', 'pane9')
    expect(S().panePreference['sessA']).toBe('pane9')
  })

  it('L5 旧映射迁移:nexus_session_word_docs → lastTouch(值过 normalize)', () => {
    localStorage.setItem('nexus_session_word_docs', JSON.stringify({ sessA: 'D:\\Old\\Doc.docx' }))
    S().bootstrapFromLegacy()
    expect(S().lastTouch[key('d:/old/doc.docx')]).toBe('sessA')
    localStorage.removeItem('nexus_session_word_docs')
  })
})
