import { describe, it, expect } from 'vitest'
import { Window } from 'happy-dom'
import { Editor } from '@tiptap/core'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id) as any

import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import { revisionDisplayState } from '../../src/renderer/src/components/word/editor/marks'

const PPR_CHANGE_JSON = JSON.stringify({
  author: '张三',
  old: { align: 'center', indentLeft: 240 },
})

function makeEditor(): Editor {
  return new Editor({
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })
}

function setPPrChange(editor: Editor): void {
  const tr = editor.state.tr
  tr.setNodeMarkup(0, undefined, {
    ...editor.state.doc.firstChild!.attrs,
    pPrChange: PPR_CHANGE_JSON,
  })
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
}

// the plugin computes decorations in props.decorations (no plugin state):
// assert the RENDERED node DOM instead — style only in ORIGINAL view
function pprDom(editor: Editor): HTMLElement | null {
  return (editor.view.dom as HTMLElement).querySelector('[data-ppr-change-author]')
}

describe('Simple Markup (revision display mode) — real plugin behavior', () => {
  it('ORIGINAL view decorates the node with the pre-revision format; ALL view does not', () => {
    const editor = makeEditor()
    editor.commands.insertContent('正文')
    setPPrChange(editor)

    // App writes the display mode into this global (App.tsx); the real
    // decoration plugin consumes it on the next transaction
    document.body.appendChild(editor.view.dom)

    revisionDisplayState.mode = 'original'
    editor.view.dispatch(editor.state.tr.setMeta('noop', 1))
    const el = pprDom(editor)
    expect(el).toBeTruthy()
    expect(el!.getAttribute('style')).toContain('text-align: center')
    expect(el!.getAttribute('style')).toContain('12pt') // indentLeft 240tw = 12pt restored

    revisionDisplayState.mode = 'all'
    editor.view.dispatch(editor.state.tr.setMeta('noop', 2))
    expect(pprDom(editor)!.getAttribute('style') ?? '').not.toContain('text-align')

    editor.destroy()
  })
})
