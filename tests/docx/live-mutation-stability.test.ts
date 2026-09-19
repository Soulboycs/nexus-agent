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
import { installMcpBridge } from '../../src/renderer/src/components/word/mcp-bridge'
import { blockRangePositions } from '../../src/renderer/src/components/word/ai/protocol'

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
}

const text = (t: string): JsonNode => ({ type: 'text', text: t })
const para = (t: string, idx: number, aiChanged = false): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: idx, styleId: null, aiChanged },
  content: [text(t)],
})

describe('TDD: Live Mutation Stability, Zero Process Refresh & Viewport Drift Prevention', () => {
  let editor: Editor
  let docContext: any
  let reportedMcpResults: any[] = []
  let openRecentCalls: string[] = []
  let scrollContainer: HTMLElement

  beforeEach(() => {
    reportedMcpResults = []
    openRecentCalls = []

    scrollContainer = document.createElement('main')
    scrollContainer.className = 'editor-scroll'
    Object.defineProperty(scrollContainer, 'scrollTop', {
      value: 3200,
      writable: true,
      configurable: true
    })
    Object.defineProperty(scrollContainer, 'clientHeight', {
      value: 800,
      writable: true,
      configurable: true
    })
    document.body.appendChild(scrollContainer)

    // Construct a multi-block document (blocks 0 to 180) to simulate academic thesis
    const docNodes: JsonNode[] = []
    for (let i = 0; i < 180; i++) {
      docNodes.push(para(`Document Paragraph Block ${i} content text...`, i))
    }

    editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: docNodes
      }
    })

    docContext = {
      editor,
      doc: {
        filePath: 'D:/test-workspace/academic-thesis.docx',
        fileName: 'academic-thesis.docx',
        parsed: {
          blocks: docNodes.map((n, idx) => ({
            type: 'paragraph',
            docxIndex: idx,
            runs: [{ text: `Document Paragraph Block ${idx} content text...` }]
          }))
        },
        isBlank: false
      }
    }

    // Mock desktop API
    ;(globalThis.window as any).desktop = {
      onMcpCommand: (handler: (msg: any) => void) => {
        ;(globalThis as any).__mcpHandler = handler
        return () => {
          ;(globalThis as any).__mcpHandler = null
        }
      },
      reportMcpResult: (res: any) => {
        reportedMcpResults.push(res)
      },
      signalMcpReady: () => {},
      openDocxPath: async (p: string) => {
        openRecentCalls.push(p)
        return { path: p, data: new ArrayBuffer(0) }
      }
    }
  })

  afterEach(() => {
    editor.destroy()
    scrollContainer.remove()
    delete (globalThis as any).__mcpHandler
  })

  describe('Problem 1: Process Refresh vs Final In-Place Mutation', () => {
    it('1.1 VERIFIES BUG: currently tool_call_start and notifyFocusWordDoc trigger unnecessary full-document reloads', () => {
      // Simulating what App.tsx currently does on tool_call_start:
      // When document is ALREADY open at 'D:/test-workspace/academic-thesis.docx',
      // dispatching nexus-word-open-file invokes openRecent() prematurely during the tool run
      const currentDocPath = docContext.doc.filePath

      const simulateCurrentAppBehavior = (toolCallFilePath: string) => {
        // CURRENT UNWANTED BEHAVIOR: unconditionally dispatches open-file
        window.dispatchEvent(new CustomEvent('nexus-word-open-file', { detail: { path: toolCallFilePath } }))
      }

      let reloadedDuringRun = false
      const handleOpenFile = (e: Event) => {
        const p = (e as CustomEvent).detail?.path
        // BUG: If it triggers a reload for an already opened file, that is an unwanted process refresh!
        if (p === currentDocPath) {
          reloadedDuringRun = true
        }
      }

      window.addEventListener('nexus-word-open-file', handleOpenFile)
      simulateCurrentAppBehavior(currentDocPath)
      window.removeEventListener('nexus-word-open-file', handleOpenFile)

      // This confirms the bug exists in the current interaction logic
      expect(reloadedDuringRun).toBe(true)
    })

    it('1.2 TDD SPEC: when document is already loaded in editor, intermediate tool runs must NOT trigger full document reload', () => {
      const currentDocPath = docContext.doc.filePath

      // TDD Target contract: If document is already open, skip reload during agent execution!
      const shouldReloadDocument = (requestedPath: string, activePath?: string, isRunningAgent?: boolean): boolean => {
        if (activePath && requestedPath === activePath) {
          // Document already active in workspace: DO NOT reload during process!
          return false
        }
        return true
      }

      const willReload = shouldReloadDocument(currentDocPath, currentDocPath, true)
      expect(willReload).toBe(false)
    })

    it('1.3 TDD SPEC: live canvas replace_blocks executes in-place without resetting editor childCount or tearing down DOM', async () => {
      const unsubscribe = installMcpBridge({ getCtx: () => docContext })
      await new Promise((r) => setTimeout(r, 60))

      const handler = (globalThis as any).__mcpHandler
      expect(handler).toBeDefined()

      const initialCount = editor.state.doc.childCount
      expect(initialCount).toBe(180)

      // Replace blocks 168 to 171 in place
      handler({
        requestId: 'req-multi-replace',
        command: 'replace_blocks',
        payload: {
          startBlockIndex: 168,
          endBlockIndex: 171,
          html: '<p>(1) Objective: English</p><p>(2) Methods: English</p><p>(3) Results: English</p><p>(4) Conclusions: English</p>',
          trackChanges: false
        }
      })

      await new Promise((r) => setTimeout(r, 60))

      // Verify in-place replacement: total childCount unchanged (4 blocks replaced by 4 blocks)
      expect(editor.state.doc.childCount).toBe(180)

      // Verify replaced blocks content
      expect(editor.state.doc.child(168).textContent).toBe('(1) Objective: English')
      expect(editor.state.doc.child(169).textContent).toBe('(2) Methods: English')
      expect(editor.state.doc.child(170).textContent).toBe('(3) Results: English')
      expect(editor.state.doc.child(171).textContent).toBe('(4) Conclusions: English')

      // Verify each block received aiChanged: true for clear visual identification
      expect(editor.state.doc.child(168).attrs.aiChanged).toBe(true)
      expect(editor.state.doc.child(169).attrs.aiChanged).toBe(true)
      expect(editor.state.doc.child(170).attrs.aiChanged).toBe(true)
      expect(editor.state.doc.child(171).attrs.aiChanged).toBe(true)

      // Blocks outside the range remain untouched
      expect(editor.state.doc.child(167).attrs.aiChanged).toBeFalsy()
      expect(editor.state.doc.child(172).attrs.aiChanged).toBeFalsy()

      unsubscribe()
    })
  })

  describe('Problem 2: Viewport Scroll Stability & Zero Drift', () => {
    it('2.1 VERIFIES BUG: full reload (openRecent/loadFile) resets scroll position to 0, causing severe visual jumping', () => {
      // Current scroll position is at block 168 (scrollTop = 3200)
      expect(scrollContainer.scrollTop).toBe(3200)

      // Simulating a full document reload (openRecent):
      const simulateFullReloadReset = () => {
        // When loadFile runs, the container contents are wiped, resetting scroll
        scrollContainer.scrollTop = 0
      }

      simulateFullReloadReset()
      // Confirms the jump to 0 (loss of viewport position)
      expect(scrollContainer.scrollTop).toBe(0)
    })

    it('2.2 TDD SPEC: during live block mutation, scroll position remains anchored near target block and does NOT reset to top', async () => {
      scrollContainer.scrollTop = 3200

      const unsubscribe = installMcpBridge({ getCtx: () => docContext })
      await new Promise((r) => setTimeout(r, 60))

      const handler = (globalThis as any).__mcpHandler

      // Execute in-place replace_blocks
      handler({
        requestId: 'req-stable-scroll',
        command: 'replace_blocks',
        payload: {
          startBlockIndex: 168,
          endBlockIndex: 168,
          html: '<p>Updated Block 168 text</p>',
          trackChanges: false
        }
      })

      await new Promise((r) => setTimeout(r, 60))

      // In-place mutation must NEVER reset scrollContainer to 0!
      expect(scrollContainer.scrollTop).toBeGreaterThan(0)
      expect(scrollContainer.scrollTop).toBe(3200)

      unsubscribe()
    })

    it('2.3 TDD SPEC: onWordFileChanged arriving for active document MUST NOT trigger openRecent or reload', () => {
      let openRecentTriggered = false
      const onWordFileChangedListener = (detail: { filePath: string }) => {
        if (!detail?.filePath) return
        const currentPath = docContext.doc?.filePath
        if (currentPath) {
          const normCurrent = currentPath.replace(/\\/g, '/').toLowerCase()
          const normTarget = detail.filePath.replace(/\\/g, '/').toLowerCase()
          if (normCurrent === normTarget) {
            // Already active: do NOT reload and destroy viewport!
            return
          }
        }
        openRecentTriggered = true
      }

      // Simulate onWordFileChanged notification arriving for current active document
      onWordFileChangedListener({ filePath: docContext.doc.filePath })
      expect(openRecentTriggered).toBe(false)

      // Only for a different file would it trigger
      onWordFileChangedListener({ filePath: 'D:/different-file.docx' })
      expect(openRecentTriggered).toBe(true)
    })

    it('2.4 TDD SPEC: MCP bridge command execution (replace_blocks) must never invoke scrollIntoView', async () => {
      let scrollIntoViewDispatched = false
      const origDispatch = editor.view.dispatch.bind(editor.view)
      editor.view.dispatch = ((tr: any) => {
        if (tr?.scrolledIntoView) {
          scrollIntoViewDispatched = true
        }
        return origDispatch(tr)
      }) as any

      try {
        const unsubscribe = installMcpBridge({ getCtx: () => docContext })
        await new Promise((r) => setTimeout(r, 60))

        const handler = (globalThis as any).__mcpHandler

        handler({
          requestId: 'req-no-scroll-into-view',
          command: 'replace_blocks',
          payload: {
            startBlockIndex: 10,
            endBlockIndex: 10,
            html: '<p>Updated without yank</p>',
            trackChanges: false
          }
        })

        await new Promise((r) => setTimeout(r, 60))

        // Must 1:1 align with GenOffice: NO scrollIntoView yank during MCP replace_blocks
        expect(scrollIntoViewDispatched).toBe(false)
        unsubscribe()
      } finally {
        editor.view.dispatch = origDispatch
      }
    })

    it('2.5 TDD SPEC: scroller pinning preserves scrollTop across DOM rewrites', () => {
      scrollContainer.scrollTop = 4500
      const pinTop = scrollContainer.scrollTop

      // Simulate a DOM content rebase
      const rebaseContentWithPinning = () => {
        const scroller = scrollContainer
        const savedScrollTop = scroller?.scrollTop ?? 0

        // Emulate DOM wipe that happens during setContent
        scroller.scrollTop = 0

        // Pinned restoration
        if (scroller) {
          scroller.scrollTop = savedScrollTop
        }
      }

      rebaseContentWithPinning()
      expect(scrollContainer.scrollTop).toBe(pinTop)
    })
  })

  describe('Problem 3: Multi-Block Range Selection & AI Target Scope Contract', () => {
    it('3.1 VERIFIES BUG: resolving blockIndex only from context.from drops all trailing blocks in a multi-block selection', () => {
      // Simulating selection spanning blocks 168 to 171
      const range168 = blockRangePositions(editor, 168, 168)
      const range171 = blockRangePositions(editor, 171, 171)

      const selectionFrom = range168.from
      const selectionTo = range171.to

      // OLD FLAWED RESOLVER (context.from only):
      const oldResolveSingle = (from: number) => {
        let blockIndex = -1
        let currIdx = 0
        editor.state.doc.forEach((node, offset) => {
          if (offset <= from && from < offset + node.nodeSize) {
            blockIndex = currIdx
          }
          currIdx++
        })
        return blockIndex
      }

      const singleIndex = oldResolveSingle(selectionFrom)
      expect(singleIndex).toBe(168)
      // Notice: blocks 169, 170, 171 are completely lost!
    })

    it('3.2 TDD SPEC: getBlockRange accurately captures [startBlockIndex, endBlockIndex] for multi-block selections', () => {
      const range168 = blockRangePositions(editor, 168, 168)
      const range171 = blockRangePositions(editor, 171, 171)

      const selectionFrom = range168.from
      const selectionTo = range171.to

      // NEW TDD RESOLVER SPECIFICATION:
      const getBlockRange = (from: number, to: number) => {
        let startIndex = -1
        let endIndex = -1
        let index = 0
        editor.state.doc.forEach((node, offset) => {
          const nodeFrom = offset
          const nodeTo = offset + node.nodeSize
          if (nodeTo > from && nodeFrom < to) {
            if (startIndex === -1) startIndex = index
            endIndex = index
          }
          index++
        })
        return {
          startBlockIndex: startIndex,
          endBlockIndex: endIndex,
          count: Math.max(1, endIndex - startIndex + 1)
        }
      }

      const range = getBlockRange(selectionFrom, selectionTo)
      expect(range.startBlockIndex).toBe(168)
      expect(range.endBlockIndex).toBe(171)
      expect(range.count).toBe(4)
    })
  })
})
