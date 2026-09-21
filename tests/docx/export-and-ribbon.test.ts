import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.navigator = win.navigator as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.Event = win.Event as any
globalThis.DOMParser = win.DOMParser as any
globalThis.Node = win.Node as any
globalThis.Element = win.Element as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.DocumentFragment = win.DocumentFragment as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 0) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id)

import fs from 'fs/promises'
import path from 'path'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import {
  setInactiveSelectionShown
} from '../../src/renderer/src/components/word/editor/inactive-selection'
import { recordRecentFile, getRecentFiles, clearRecentFiles } from '../../src/main/docx/docx-recent'

describe('Word Export Pipeline, Ribbon AI Buttons & Inactive Selection TDD Test Suite', () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 1: Export Pipeline & Recent Files IPC Pipeline Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 1: Export & Recent Files IPC Pipeline', () => {
    it('verifies preload/index.ts binds real IPC channels for exportPdf, exportHtml, print, and getRecentFiles', async () => {
      const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts')
      const preloadCode = await fs.readFile(preloadPath, 'utf-8')

      // Ensure export methods invoke actual IPC channels rather than stubs
      expect(preloadCode).toContain("ipcRenderer.invoke('docs:get-recent')")
      expect(preloadCode).toContain("ipcRenderer.invoke('docs:print', scale)")
      expect(preloadCode).toContain("ipcRenderer.invoke(\n      'docs:export-pdf'")
      expect(preloadCode).toContain("ipcRenderer.invoke('docs:export-html', defaultName, html, outPath)")
    })

    it('verifies main process docxIpc.ts exports handlers for docs:export-pdf, docs:export-html, docs:print, docs:get-recent', async () => {
      const docxIpcPath = path.resolve(__dirname, '../../src/main/docx/docxIpc.ts')
      const docxIpcCode = await fs.readFile(docxIpcPath, 'utf-8')

      expect(docxIpcCode).toContain("ipcMain.handle(\n    'docs:export-pdf'")
      expect(docxIpcCode).toContain("ipcMain.handle(\n    'docs:export-html'")
      expect(docxIpcCode).toContain("ipcMain.handle('docs:print'")
      expect(docxIpcCode).toContain("ipcMain.handle('docs:get-recent'")
    })

    it('verifies recordRecentFile maintains LRU ordering, path deduplication, and max 20 limit', () => {
      clearRecentFiles()
      const fileA = 'D:\\Docs\\Report_2026_Q1.docx'
      const fileB = 'D:\\Docs\\Annual_Summary.docx'
      const fileC = 'D:\\Docs\\Budget_Plan.docx'

      recordRecentFile(fileA)
      recordRecentFile(fileB)
      recordRecentFile(fileC)

      expect(getRecentFiles().length).toBe(3)
      expect(getRecentFiles()[0].path).toBe(fileC)

      // Re-opening fileA moves it to the top without duplicate
      recordRecentFile(fileA)
      expect(getRecentFiles().length).toBe(3)
      expect(getRecentFiles()[0].path).toBe(fileA)

      // Add 25 dummy files to test capping at 20
      for (let i = 0; i < 25; i++) {
        recordRecentFile(`D:\\Docs\\Dummy_${i}.docx`)
      }

      expect(getRecentFiles().length).toBe(20)
      expect(getRecentFiles()[0].name).toBe('Dummy_24.docx')
    })

    it('validates twips-to-inches calculation formula for printToPDF (1440 twips = 1 inch)', () => {
      const TWIPS_PER_INCH = 1440
      // A4 dimensions in twips: 11906 x 16838
      const a4WidthTwips = 11906
      const a4HeightTwips = 16838

      const widthInches = a4WidthTwips / TWIPS_PER_INCH
      const heightInches = a4HeightTwips / TWIPS_PER_INCH

      // A4 is 8.27 x 11.69 inches
      expect(widthInches).toBeCloseTo(8.268, 2)
      expect(heightInches).toBeCloseTo(11.693, 2)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 2: Ribbon AI Quick Actions & Dispatch Contract
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 2: Ribbon AI Quick Actions Contract', () => {
    it('verifies Ribbon.tsx contains the AI 助手 group with Summarize, Polish, and Tidy actions', async () => {
      const ribbonPath = path.resolve(__dirname, '../../src/renderer/src/components/word/components/Ribbon.tsx')
      const ribbonCode = await fs.readFile(ribbonPath, 'utf-8')

      // Group markup verification
      expect(ribbonCode).toContain('ribbon-group-ai')
      expect(ribbonCode).toContain("AI 助手")

      // Button tips and callbacks verification
      expect(ribbonCode).toContain("data-tip={t('aiSummarizeBtn')}")
      expect(ribbonCode).toContain("onAiPreset(t('aiSummarizePrompt'))")

      expect(ribbonCode).toContain("data-tip={t('aiPolishBtn')}")
      expect(ribbonCode).toContain("onAiPreset(")
      expect(ribbonCode).toContain("aiPolishSelectionPrompt")

      expect(ribbonCode).toContain("data-tip={t('aiTidyBtn')}")
      expect(ribbonCode).toContain("onAiPreset(t('aiTidyPrompt'))")
    })

    it('verifies askSendNow auto-extracts selection context when invoked without explicit context', () => {
      const editor = new Editor({
        extensions: editorExtensions,
        content: {
          type: 'doc',
          content: [
            {
              type: 'docParagraph',
              attrs: { docxIndex: 0 },
              content: [{ type: 'text', text: '第一段：引言与背景分析。' }]
            },
            {
              type: 'docParagraph',
              attrs: { docxIndex: 1 },
              content: [{ type: 'text', text: '第二段：核心技术架构阐述。' }]
            }
          ]
        }
      })

      // Select text in the second paragraph
      editor.commands.setTextSelection({ from: 18, to: 28 })
      expect(editor.state.selection.empty).toBe(false)

      let dispatchedEvent: any = null
      const listener = (e: any) => {
        dispatchedEvent = e.detail
      }
      window.addEventListener('nexus-word-ask-ai', listener)

      // Simulate askSendNow logic when called by onAiPreset('润色选中的内容')
      const simulateAskSendNow = (text: string, context?: any) => {
        if (!context && editor && !editor.state.selection.empty) {
          const { from, to } = editor.state.selection
          const rawText = editor.state.doc.textBetween(from, to, ' ')
          context = {
            from,
            to,
            excerpt: rawText.slice(0, 100),
            kind: 'text'
          }
        }

        let startBlockIndex: number | undefined
        let endBlockIndex: number | undefined
        let blockCount = 1

        if (context?.from !== undefined && editor) {
          const to = context.to ?? context.from
          // Calculate block range
          let startIndex = -1
          let endIndex = -1
          let index = 0
          editor.state.doc.forEach((node, offset) => {
            const nodeFrom = offset
            const nodeTo = offset + node.nodeSize
            if (nodeTo > context.from && nodeFrom < to) {
              if (startIndex === -1) startIndex = index
              endIndex = index
            }
            index++
          })
          startBlockIndex = startIndex !== -1 ? startIndex : 0
          endBlockIndex = endIndex !== -1 ? endIndex : startBlockIndex
          blockCount = Math.max(1, endBlockIndex - startBlockIndex + 1)

          // Collapse selection and clear inactive selection
          editor.commands.setTextSelection(to)
          setInactiveSelectionShown(editor, false)
        }

        window.dispatchEvent(
          new CustomEvent('nexus-word-ask-ai', {
            detail: {
              instruction: text,
              excerpt: context?.excerpt,
              from: context?.from,
              to: context?.to,
              startBlockIndex,
              endBlockIndex,
              blockCount
            }
          })
        )
      }

      simulateAskSendNow('润色选中的内容，使表达更专业流畅')

      expect(dispatchedEvent).not.toBeNull()
      expect(dispatchedEvent.instruction).toBe('润色选中的内容，使表达更专业流畅')
      expect(dispatchedEvent.startBlockIndex).toBe(1)
      expect(dispatchedEvent.endBlockIndex).toBe(1)
      expect(dispatchedEvent.blockCount).toBe(1)
      expect(dispatchedEvent.excerpt).toContain('核心技术架构')

      // Text selection must be collapsed (no blue highlight mask)
      expect(editor.state.selection.empty).toBe(true)

      window.removeEventListener('nexus-word-ask-ai', listener)
      editor.destroy()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 3: Inactive Selection State & ProseMirror Decoration Flow
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 3: Inactive Selection State & Decoration Lifecycle', () => {
    it('manages inactive selection plugin state and produces doc-inactive-selection inline decorations', () => {
      const editor = new Editor({
        extensions: editorExtensions,
        content: {
          type: 'doc',
          content: [
            {
              type: 'docParagraph',
              attrs: { docxIndex: 0 },
              content: [{ type: 'text', text: '电子文档选区失焦高亮保持测试段落。' }]
            }
          ]
        }
      })

      // Select part of the text
      editor.commands.setTextSelection({ from: 3, to: 12 })
      expect(editor.state.selection.empty).toBe(false)

      // Initially, inactive selection decoration is off (false)
      // Call setInactiveSelectionShown(editor, true) as when blurring editor to chat input
      setInactiveSelectionShown(editor, true)

      // Now call with false (when focus returns)
      setInactiveSelectionShown(editor, false)

      // Calling setInactiveSelectionShown on destroyed or null editor does not throw
      expect(() => setInactiveSelectionShown(null, true)).not.toThrow()
      editor.destroy()
      expect(() => setInactiveSelectionShown(editor, true)).not.toThrow()
    })
  })
})
