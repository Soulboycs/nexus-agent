import { describe, it, expect, beforeEach } from 'bun:test'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.localStorage = win.localStorage as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id) as any

import {
  getLastOpenedWordFile,
  setLastOpenedWordFile,
  clearLastOpenedWordFile,
  getRecentWordFiles,
  addRecentWordFile,
  clearRecentWordFiles,
  getSessionWordDocMap,
  setSessionWordDoc,
  getSessionWordDoc,
  STORAGE_KEYS,
} from '../../src/renderer/src/components/word/persistence'

describe('Word 文档与全场景状态保存测试套件', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('1. 最后打开文档路径状态保存与恢复', () => {
    it('初始无记录时返回 null', () => {
      expect(getLastOpenedWordFile()).toBeNull()
    })

    it('设置最后打开文件能够成功持久化到 localStorage', () => {
      const testPath = 'C:\\Users\\Administrator\\Documents\\论文.docx'
      setLastOpenedWordFile(testPath)
      expect(getLastOpenedWordFile()).toBe(testPath)
      expect(localStorage.getItem(STORAGE_KEYS.LAST_OPENED_FILE)).toBe(testPath)
    })

    it('clearLastOpenedWordFile 能够清理最后打开记录', () => {
      setLastOpenedWordFile('D:\\test.docx')
      expect(getLastOpenedWordFile()).toBe('D:\\test.docx')
      clearLastOpenedWordFile()
      expect(getLastOpenedWordFile()).toBeNull()
    })

    it('无效/空白路径不会写入持久化存储', () => {
      setLastOpenedWordFile('')
      expect(getLastOpenedWordFile()).toBeNull()
      setLastOpenedWordFile('   ')
      expect(getLastOpenedWordFile()).toBeNull()
    })
  })

  describe('2. 最近打开文档 (Recent Documents) 队列与去重置顶', () => {
    it('初始无最近文件时返回空数组', () => {
      expect(getRecentWordFiles()).toEqual([])
    })

    it('添加最近文件时按时间倒序排列并自动去重', () => {
      addRecentWordFile('D:\\docs\\doc1.docx')
      addRecentWordFile('D:\\docs\\doc2.docx')
      addRecentWordFile('D:\\docs\\doc3.docx')

      let recents = getRecentWordFiles()
      expect(recents).toEqual([
        'D:\\docs\\doc3.docx',
        'D:\\docs\\doc2.docx',
        'D:\\docs\\doc1.docx',
      ])

      // 再次打开 doc1，doc1 应被置顶到首位，且不出现重复项
      addRecentWordFile('D:\\docs\\doc1.docx')
      recents = getRecentWordFiles()
      expect(recents).toEqual([
        'D:\\docs\\doc1.docx',
        'D:\\docs\\doc3.docx',
        'D:\\docs\\doc2.docx',
      ])
      expect(recents.length).toBe(3)
    })

    it('最近文件列表自动截断至最大上限 20 个', () => {
      for (let i = 1; i <= 25; i++) {
        addRecentWordFile(`D:\\docs\\file_${i}.docx`)
      }
      const recents = getRecentWordFiles()
      expect(recents.length).toBe(20)
      expect(recents[0]).toBe('D:\\docs\\file_25.docx')
      expect(recents[19]).toBe('D:\\docs\\file_6.docx')
    })

    it('大小写不敏感去重', () => {
      addRecentWordFile('C:\\Test\\Doc.docx')
      addRecentWordFile('c:\\test\\doc.docx')
      const recents = getRecentWordFiles()
      expect(recents.length).toBe(1)
      expect(recents[0].toLowerCase()).toBe('c:\\test\\doc.docx')
    })
  })

  describe('3. 对话/会话 (Session) 与 Word 文档绑定联动机制', () => {
    it('不同会话可以独立记录绑定的文档路径', () => {
      const session1 = 'session-uuid-1'
      const session2 = 'session-uuid-2'

      setSessionWordDoc(session1, 'C:\\Users\\Admin\\DocA.docx')
      setSessionWordDoc(session2, 'C:\\Users\\Admin\\DocB.docx')

      expect(getSessionWordDoc(session1)).toBe('C:\\Users\\Admin\\DocA.docx')
      expect(getSessionWordDoc(session2)).toBe('C:\\Users\\Admin\\DocB.docx')
      expect(getSessionWordDoc('non-existent')).toBeNull()
    })

    it('置空或清除会话绑定的文档', () => {
      const session1 = 'session-uuid-1'
      setSessionWordDoc(session1, 'C:\\doc.docx')
      expect(getSessionWordDoc(session1)).toBe('C:\\doc.docx')

      setSessionWordDoc(session1, '')
      expect(getSessionWordDoc(session1)).toBeNull()
    })

    it('整表序列化与反序列化容错测试', () => {
      localStorage.setItem(STORAGE_KEYS.SESSION_WORD_DOCS, 'invalid-json{{{')
      expect(getSessionWordDocMap()).toEqual({})
      expect(getSessionWordDoc('s1')).toBeNull()
    })
  })

  describe('4. 跨组件事件通知与界面布局状态持久化', () => {
    it('nexus-word-file-opened 能够自动将当前打开文件绑定至对应激活会话', () => {
      let activeSessionId = 'session-123'
      const handleWordFileOpened = (e: Event) => {
        const detail = (e as CustomEvent<{ filePath: string }>).detail
        if (detail?.filePath && activeSessionId) {
          setSessionWordDoc(activeSessionId, detail.filePath)
        }
      }
      window.addEventListener('nexus-word-file-opened', handleWordFileOpened)

      // 模拟 Word 打开文件事件派发
      window.dispatchEvent(
        new CustomEvent('nexus-word-file-opened', {
          detail: { filePath: 'D:\\thesis.docx', fileName: 'thesis.docx' },
        })
      )

      expect(getSessionWordDoc('session-123')).toBe('D:\\thesis.docx')

      // 切换到 session-456 并打开另一个文档
      activeSessionId = 'session-456'
      window.dispatchEvent(
        new CustomEvent('nexus-word-file-opened', {
          detail: { filePath: 'D:\\report.docx', fileName: 'report.docx' },
        })
      )

      expect(getSessionWordDoc('session-456')).toBe('D:\\report.docx')
      // 原 session-123 的绑定保持不变
      expect(getSessionWordDoc('session-123')).toBe('D:\\thesis.docx')

      window.removeEventListener('nexus-word-file-opened', handleWordFileOpened)
    })

    it('布局状态键值（抽屉开关、侧边栏开关、活动标签页）正确存取', () => {
      localStorage.setItem(STORAGE_KEYS.DRAWER_OPEN, 'true')
      expect(localStorage.getItem('nexus_word_drawer_open')).toBe('true')

      localStorage.setItem(STORAGE_KEYS.SIDEBAR_OPEN, 'false')
      expect(localStorage.getItem('nexus_sidebar_open')).toBe('false')

      localStorage.setItem(STORAGE_KEYS.AUXILIARY_TAB, 'word')
      expect(localStorage.getItem('nexus_auxiliary_active_tab')).toBe('word')
    })
  })
})
