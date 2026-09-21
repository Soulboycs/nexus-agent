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
import {
  evaluateTableFormula,
  recalcTableFormulas,
} from '../../src/renderer/src/components/word/editor/table-formula'

const cell = (text: string) => ({
  type: 'docTableCell',
  content: [{ type: 'docParagraph', content: text ? [{ type: 'text', text }] : [] }],
})
const row = (...cells: string[]) => ({ type: 'docTableRow', content: cells.map(cell) })

const makeEditor = (table: unknown) =>
  new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [] }, table, { type: 'docParagraph', content: [] }],
    },
  })

/** grid for unit tests: 3x3, cursor B2 */
const GRID = {
  rows: [
    ['10', '20', '30'],
    ['5', '', '7'],
    ['1', '2', '3'],
  ],
}

describe('table formula evaluator (ROUND2 #19: =SUM(ABOVE) and friends)', () => {
  it('direction functions collect contiguous numeric cells and stop at blanks', () => {
    // A3 is '1', above it A2='5', A1='10': SUM(ABOVE) collects both = 15
    const above = evaluateTableFormula('=SUM(ABOVE)', GRID, { row: 2, col: 0 })
    expect(above.ok).toBe(true)
    expect((above as { value: number }).value).toBe(5 + 10)
    const sumRow = evaluateTableFormula('=SUM(LEFT)', GRID, { row: 0, col: 2 })
    expect(sumRow.ok).toBe(true)
    expect((sumRow as { value: number }).value).toBe(30)
    const left = evaluateTableFormula('=SUM(LEFT)', GRID, { row: 0, col: 2 })
    expect((left as { value: number }).value).toBe(10 + 20)
  })

  it('supports AVERAGE/COUNT/MIN/MAX with directions', () => {
    const avg = evaluateTableFormula('=AVERAGE(ABOVE)', GRID, { row: 2, col: 0 })
    expect((avg as { value: number }).value).toBe((10 + 5) / 2)
    const count = evaluateTableFormula('=COUNT(ABOVE)', GRID, { row: 2, col: 0 })
    expect((count as { value: number }).value).toBe(2)
    const max = evaluateTableFormula('=MAX(ABOVE)', GRID, { row: 2, col: 0 })
    expect((max as { value: number }).value).toBe(10)
  })

  it('cell references and ranges (A1, A1:A3) and arithmetic with precedence', () => {
    const ref = evaluateTableFormula('=A1+B3', GRID, { row: 0, col: 0 })
    expect((ref as { value: number }).value).toBe(10 + 2)
    const range = evaluateTableFormula('=SUM(A1:A3)', GRID, { row: 0, col: 0 })
    expect((range as { value: number }).value).toBe(16)
    const arith = evaluateTableFormula('=(A1+A3)*2-6/3', GRID, { row: 0, col: 0 })
    expect((arith as { value: number }).value).toBe((10 + 1) * 2 - 2)
  })

  it('formats with Word-style masks (#,##0.00 / 0%)', () => {
    const money = evaluateTableFormula('=SUM(LEFT) \\# "#,##0.00"', GRID, { row: 0, col: 2 })
    expect((money as { formatted: string }).formatted).toBe('30.00')
    const thousands = evaluateTableFormula('=A1*1000 \\# "#,##0"', GRID, { row: 0, col: 0 })
    expect((thousands as { formatted: string }).formatted).toBe('10,000')
  })

  it('reports errors for empty sets, division by zero and unknown functions', () => {
    // nothing above A1: the direction set is empty
    const empty = evaluateTableFormula('=SUM(ABOVE)', GRID, { row: 0, col: 0 })
    expect(empty.ok).toBe(false)
    const div0 = evaluateTableFormula('=1/0', GRID, { row: 0, col: 0 })
    expect(div0.ok).toBe(false)
    const bad = evaluateTableFormula('=NOSUCH(ABOVE)', GRID, { row: 0, col: 0 })
    expect(bad.ok).toBe(false)
  })
})

describe('recalcTableFormulas (editor integration: type = formula, recalc writes values)', () => {
  it('replaces formula cells with formatted results in one undoable transaction', () => {
    const editor = makeEditor({
      type: 'docTable',
      content: [
        row('1200', '30'),
        row('1000', '40'),
        row('=SUM(ABOVE)', '=B1+B2'),
      ],
    })
    // cursor inside the last row's first cell (doc starts with an empty para: size 2)
    const table = editor.state.doc.child(1)
    let pos = 2
    for (let i = 0; i < 2; i++) pos += table.child(i).nodeSize
    editor.commands.setTextSelection(pos + 3)
    const res = recalcTableFormulas(editor)
    expect(res).toBe('ok')
    const after = editor.state.doc.child(1)
    const texts: string[][] = []
    after.forEach((tr) => {
      const cells: string[] = []
      tr.forEach((td) => cells.push(td.textContent))
      texts.push(cells)
    })
    expect(texts[2]).toEqual(['2200', '70'])
    // single undo step restores the formulas
    editor.commands.undo()
    const undone = editor.state.doc.child(1)
    expect(undone.child(2).child(0).textContent).toBe('=SUM(ABOVE)')
    editor.destroy()
  })

  it('leaves tables without formulas untouched and reports no-table outside tables', () => {
    const plain = makeEditor({ type: 'docTable', content: [row('1', '2'), row('3', '4')] })
    // cursor inside
    plain.commands.setTextSelection(4)
    expect(recalcTableFormulas(plain)).toBe('ok')
    expect(plain.state.doc.child(1).child(0).child(0).textContent).toBe('1')
    plain.destroy()
    const bare = makeEditor({ type: 'docTable', content: [row('1')] })
    bare.commands.setTextSelection(1)
    expect(recalcTableFormulas(bare)).toBe('no-table')
    bare.destroy()
  })
})
