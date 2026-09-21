import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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

import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import {
  isDocsEditorReady,
  getActiveDocsWcId,
  notifyFocusWordDoc,
  notifyWordFileChanged
} from '../../src/main/docx/docsBridge'
import { installMcpBridge } from '../../src/renderer/src/components/word/mcp-bridge'

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
}

const text = (t: string): JsonNode => ({ type: 'text', text: t })
const para = (t: string, aiChanged = false): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: 0, styleId: null, aiChanged },
  content: [text(t)],
})

describe('Word Live Canvas & MCP Bridge Linkage Test Suite', () => {
  let editor: Editor
  let docContext: any
  let reportedMcpResults: any[] = []
  let mcpReadySignaled = false

  beforeEach(() => {
    reportedMcpResults = []
    mcpReadySignaled = false

    editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [para('Initial Paragraph 0'), para('Initial Paragraph 1')]
      }
    })

    docContext = {
      editor,
      doc: {
        filePath: 'D:/test-workspace/live-document.docx',
        fileName: 'live-document.docx',
        parsed: {
          blocks: [
            { type: 'paragraph', docxIndex: 0, runs: [{ text: 'Initial Paragraph 0' }] },
            { type: 'paragraph', docxIndex: 1, runs: [{ text: 'Initial Paragraph 1' }] }
          ]
        },
        isBlank: false
      }
    }

    // Mock window.desktop for mcp-bridge
    ;(globalThis.window as any).desktop = {
      onMcpCommand: (handler: (msg: any) => void) => {
        (globalThis as any).__mcpHandler = handler
        return () => {
          (globalThis as any).__mcpHandler = null
        }
      },
      reportMcpResult: (res: any) => {
        reportedMcpResults.push(res)
      },
      signalMcpReady: () => {
        mcpReadySignaled = true
      }
    }
  })

  afterEach(() => {
    editor.destroy()
    delete (globalThis as any).__mcpHandler
  })

  it('1. mcp-bridge announces readiness when document is loaded', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    expect(mcpReadySignaled).toBe(true)
    unsubscribe()
  })

  it('2. replace_blocks mutates the live editor and preserves yellow aiChanged highlight for visibility', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    const handler = (globalThis as any).__mcpHandler
    expect(handler).toBeDefined()

    // Dispatch replace_blocks command
    handler({
      requestId: 'req-replace-1',
      command: 'replace_blocks',
      payload: {
        startBlockIndex: 0,
        endBlockIndex: 0,
        html: '<p>Agent Live Replaced Text</p>',
        trackChanges: false
      }
    })

    await new Promise((r) => setTimeout(r, 100))

    if (!reportedMcpResults[0]?.ok) {
      console.log('FAIL REASON 2:', reportedMcpResults[0]?.error)
    }

    // 1. Check result reported back
    expect(reportedMcpResults.length).toBe(1)
    expect(reportedMcpResults[0].ok).toBe(true)
    expect(reportedMcpResults[0].requestId).toBe('req-replace-1')

    // 2. Check editor text changed live
    const firstNode = editor.state.doc.child(0)
    expect(firstNode.textContent).toBe('Agent Live Replaced Text')

    // 3. Check that aiChanged highlight flag is retained (not stripped instantly) so user sees yellow highlight
    expect(firstNode.attrs.aiChanged).toBe(true)

    unsubscribe()
  })

  it('3. replace_blocks with trackChanges: true injects native del and ins marks live on screen', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    const handler = (globalThis as any).__mcpHandler
    handler({
      requestId: 'req-track-1',
      command: 'replace_blocks',
      payload: {
        startBlockIndex: 0,
        endBlockIndex: 0,
        html: '<p>Revision New Content</p>',
        trackChanges: true,
        author: 'Nexus Agent'
      }
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(reportedMcpResults.length).toBe(1)
    expect(reportedMcpResults[0].ok).toBe(true)

    // Verify marks in the editor
    let hasDel = false
    let hasIns = false
    editor.state.doc.descendants((node) => {
      for (const m of node.marks) {
        if (m.type.name === 'del' && m.attrs.author === 'Nexus Agent') hasDel = true
        if (m.type.name === 'ins' && m.attrs.author === 'Nexus Agent') hasIns = true
      }
    })

    expect(hasDel).toBe(true)
    expect(hasIns).toBe(true)

    unsubscribe()
  })

  it('4. insert_content appends new block live to editor with aiChanged highlight', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    const handler = (globalThis as any).__mcpHandler
    const initialCount = editor.state.doc.childCount

    handler({
      requestId: 'req-insert-1',
      command: 'insert_content',
      payload: {
        html: '<p>Newly Appended Block by AI</p>',
        afterBlockIndex: initialCount - 1,
        trackChanges: false
      }
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(reportedMcpResults.length).toBe(1)
    expect(reportedMcpResults[0].ok).toBe(true)

    // Last block should be the inserted content with aiChanged: true
    const lastNode = editor.state.doc.child(editor.state.doc.childCount - 1)
    expect(lastNode.textContent).toBe('Newly Appended Block by AI')
    expect(lastNode.attrs.aiChanged).toBe(true)

    unsubscribe()
  })

  it('5. main-process docsBridge helper functions operate safely in headless test environment', () => {
    // In headless test without real Electron window, isDocsEditorReady() safely returns false
    expect(isDocsEditorReady()).toBe(false)
    expect(getActiveDocsWcId()).toBeNull()

    // Calling notifyFocusWordDoc and notifyWordFileChanged executes safely without exceptions
    expect(() => notifyFocusWordDoc('C:/dummy/test.docx')).not.toThrow()
    expect(() => notifyWordFileChanged('C:/dummy/test.docx')).not.toThrow()
  })

  it('6. read_document returns live document skeleton and full-text stats', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    const handler = (globalThis as any).__mcpHandler
    handler({
      requestId: 'req-read-1',
      command: 'read_document',
      payload: {}
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(reportedMcpResults.length).toBe(1)
    expect(reportedMcpResults[0].ok).toBe(true)
    const text = reportedMcpResults[0].result.text
    expect(text).toContain('The document has')
    expect(text).toContain('Full-text stats:')
    expect(text).toContain('0|p|Initial Paragraph 0')
    expect(text).toContain('1|p|Initial Paragraph 1')

    unsubscribe()
  })

  it('7. apply_ops runs atomic operations (findReplace, setFont) on live canvas', async () => {
    const unsubscribe = installMcpBridge({ getCtx: () => docContext })
    await new Promise((r) => setTimeout(r, 60))

    const handler = (globalThis as any).__mcpHandler
    handler({
      requestId: 'req-ops-1',
      command: 'apply_ops',
      payload: {
        ops: [
          {
            op: 'findReplace',
            find: 'Initial Paragraph 0',
            replace: 'Modified By Atomic Op 0',
            target: { blockIndexes: [0] }
          }
        ]
      }
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(reportedMcpResults.length).toBe(1)
    expect(reportedMcpResults[0].ok).toBe(true)

    // Verify block 0 text changed
    const block0 = editor.state.doc.child(0)
    expect(block0.textContent).toBe('Modified By Atomic Op 0')

    unsubscribe()
  })
})
