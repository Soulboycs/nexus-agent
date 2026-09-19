import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document
;(globalThis as Record<string, unknown>).CustomEvent = win.CustomEvent
;(globalThis as Record<string, unknown>).Event = win.Event
;(globalThis as Record<string, unknown>).HTMLElement = win.HTMLElement
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: unknown) =>
  setTimeout(cb, 16)
;(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: unknown) =>
  clearTimeout(id as number)

import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import { setCellNineAlign } from '../../src/renderer/src/components/word/editor/cell-nine-align'

const cell = (text: string) => ({
  type: 'docTableCell',
  content: [{ type: 'docParagraph', content: text ? [{ type: 'text', text }] : [] }],
})
const row = (...cells: string[]) => ({ type: 'docTableRow', content: cells.map(cell) })

const makeEditor = () =>
  new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        { type: 'docParagraph', content: [] },
        { type: 'docTable', content: [row('a', 'b'), row('c', 'd')] },
        { type: 'docParagraph', content: [] },
      ],
    },
  })

/** cursor into grid cell (r, c) */
function selectCell(editor: Editor, r: number, c: number) {
  const table = editor.state.doc.child(1)
  let pos = 2
  for (let i = 0; i < r; i++) pos += table.child(i).nodeSize
  pos += 1
  for (let i = 0; i < c; i++) pos += table.child(r).child(i).nodeSize
  pos += 3
  editor.commands.setTextSelection(pos)
}

const gridTexts = (editor: Editor): Array<{ v: string | null; a: string | null; text: string }> => {
  const out: Array<{ v: string | null; a: string | null; text: string }> = []
  const table = editor.state.doc.child(1)
  table.forEach((tr) => {
    tr.forEach((td) => {
      const para = td.firstChild
      out.push({
        v: (td.attrs.vAlign as string | null) ?? null,
        a: (para?.attrs.align as string | null) ?? null,
        text: td.textContent,
      })
    })
  })
  return out
}

describe('cell nine-grid alignment (ROUND2 #18: atomic vAlign + paragraph align)', () => {
  it('sets vertical and horizontal alignment of the cursor cell in one step', () => {
    const editor = makeEditor()
    selectCell(editor, 0, 1) // cell "b"
    const res = setCellNineAlign(editor, { v: 'center', h: 'center' })
    expect(res).toBe('ok')
    const grid = gridTexts(editor)
    expect(grid[1]).toMatchObject({ v: 'center', a: 'center', text: 'b' })
    // neighbours untouched
    expect(grid[0]).toMatchObject({ v: null, a: null })
    editor.destroy()
  })

  it('top/left writes null (Word default), keeping the saved XML round-trip clean', () => {
    const editor = makeEditor()
    selectCell(editor, 1, 0)
    setCellNineAlign(editor, { v: 'center', h: 'right' })
    setCellNineAlign(editor, { v: 'top', h: 'left' })
    const grid = gridTexts(editor)
    expect(grid[2]).toMatchObject({ v: null, a: null })
    editor.destroy()
  })

  it('is one undo step', () => {
    const editor = makeEditor()
    selectCell(editor, 0, 0)
    setCellNineAlign(editor, { v: 'bottom', h: 'right' })
    editor.commands.undo()
    expect(gridTexts(editor)[0]).toMatchObject({ v: null, a: null })
    editor.destroy()
  })
})
