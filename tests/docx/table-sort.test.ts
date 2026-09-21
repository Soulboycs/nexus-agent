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
  compareCellKeys,
  findTableAtSelection,
  numericKeyOf,
  sortTableByColumn,
} from '../../src/renderer/src/components/word/editor/table-sort'

const cell = (text: string) => ({
  type: 'docTableCell',
  content: [{ type: 'docParagraph', content: text ? [{ type: 'text', text }] : [] }],
})
const row = (...cells: string[]) => ({
  type: 'docTableRow',
  content: cells.map(cell),
})

function makeEditor(table: unknown) {
  return new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        { type: 'docParagraph', content: [{ type: 'text', text: 'before' }] },
        table,
        { type: 'docParagraph', content: [] },
      ],
    },
  })
}

const TABLE = {
  type: 'docTable',
  content: [
    row('姓名', '语文', '数学'),
    row('张三', '90', '85.5'),
    row('李四', '76', '100'),
    row('王五', '90', '60'),
  ],
}

/** cursor into the grid cell (row r, col c) of the middle table */
function selectCell(editor: Editor, r: number, c: number) {
  const table = editor.state.doc.child(1)
  let pos = 2 // after first paragraph
  for (let i = 0; i < r; i++) pos += table.child(i).nodeSize
  pos += 1 // into the row
  for (let i = 0; i < c; i++) pos += table.child(r).child(i).nodeSize
  pos += 3 // row open + cell open + paragraph open (inside inline content)
  editor.commands.setTextSelection(pos)
}

const tableRowsText = (editor: Editor): string[][] => {
  const table = editor.state.doc.child(1)
  const out: string[][] = []
  table.forEach((tr) => {
    const cells: string[] = []
    tr.forEach((td) => cells.push(td.textContent))
    out.push(cells)
  })
  return out
}

describe('table sort keys (ROUND2 #20: numeric-aware column compare)', () => {
  it('numericKeyOf strips separators, currency and percent; non-numeric is null', () => {
    expect(numericKeyOf('1,234.5')).toBe(1234.5)
    expect(numericKeyOf('￥-12')).toBe(-12)
    expect(numericKeyOf('85.5%')).toBe(85.5)
    expect(numericKeyOf('')).toBeNull()
    expect(numericKeyOf('abc')).toBeNull()
    expect(numericKeyOf('12a')).toBeNull()
  })

  it('compareCellKeys: numeric columns compare by value, mixed/text columns codepoint-wise', () => {
    expect(compareCellKeys('9', '10')).toBeLessThan(0)
    expect(compareCellKeys('100', '20')).toBeGreaterThan(0)
    expect(compareCellKeys('90', '90')).toBe(0)
    // text falls back to a deterministic codepoint compare
    expect(compareCellKeys('apple', 'banana')).toBeLessThan(0)
    // empty sorts before everything within a numeric column
    expect(compareCellKeys('', '5')).toBeLessThan(0)
    // mixed column: '' vs '5' both numeric-able? '' is null -> empty first; text vs text codepoint
    expect(compareCellKeys('张', '李')).not.toBe(0)
  })
})

describe('sortTableByColumn (single-transaction row reorder with pinned header)', () => {
  it('sorts body rows by a numeric column descending, keeping the header row first', () => {
    const editor = makeEditor(TABLE)
    selectCell(editor, 1, 2) // cursor in 数学 column body
    const res = sortTableByColumn(editor, { col: 2, asc: false, hasHeader: true })
    expect(res).toBe('ok')
    expect(tableRowsText(editor)).toEqual([
      ['姓名', '语文', '数学'],
      ['李四', '76', '100'],
      ['张三', '90', '85.5'],
      ['王五', '90', '60'],
    ])
    editor.destroy()
  })

  it('sorts ascending and can treat the first row as data when hasHeader=false', () => {
    const editor = makeEditor(TABLE)
    selectCell(editor, 1, 1)
    const res = sortTableByColumn(editor, { col: 1, asc: true, hasHeader: false })
    expect(res).toBe('ok')
    const rows = tableRowsText(editor)
    expect(rows[0]![1]).toBe('76')
    expect(rows[rows.length - 1]![1]).toBe('语文')
    editor.destroy()
  })

  it('is one undo step: a single Ctrl+Z restores the original order', () => {
    const editor = makeEditor(TABLE)
    selectCell(editor, 1, 2)
    sortTableByColumn(editor, { col: 2, asc: false, hasHeader: true })
    const sorted = tableRowsText(editor)
    editor.commands.undo()
    expect(tableRowsText(editor)).toEqual(sorted === null ? [] : [
      ['姓名', '语文', '数学'],
      ['张三', '90', '85.5'],
      ['李四', '76', '100'],
      ['王五', '90', '60'],
    ])
    editor.destroy()
  })

  it('descending sort keeps tied keys in their original relative order (Word stable sort)', () => {
    const editor = makeEditor({
      type: 'docTable',
      content: [
        row('键', '序'),
        row('X', '1'),
        row('Y', '2'),
        row('X', '3'),
      ],
    })
    selectCell(editor, 1, 0)
    sortTableByColumn(editor, { col: 0, asc: false, hasHeader: true })
    const rows = tableRowsText(editor)
    // Y sorts first (desc); the two tied X rows keep their original 1-before-3 order
    expect(rows.map((r) => r[1])).toEqual(['序', '2', '1', '3'])
    editor.destroy()
  })

  it('ascending sort also keeps tied keys in their original relative order', () => {
    const editor = makeEditor({
      type: 'docTable',
      content: [
        row('键', '序'),
        row('Y', '1'),
        row('X', '2'),
        row('X', '3'),
      ],
    })
    selectCell(editor, 1, 0)
    sortTableByColumn(editor, { col: 0, asc: true, hasHeader: true })
    const rows = tableRowsText(editor)
    // X rows tie: 2 stays before 3; Y goes last (asc)
    expect(rows.map((r) => r[1])).toEqual(['序', '2', '3', '1'])
    editor.destroy()
  })

  it('reports no-table when the selection is outside any docTable', () => {
    const editor = makeEditor(TABLE)
    editor.commands.setTextSelection(1)
    expect(sortTableByColumn(editor, { col: 0, asc: true, hasHeader: false })).toBe('no-table')
    editor.destroy()
  })

  it('findTableAtSelection resolves the table node and position under the cursor', () => {
    const editor = makeEditor(TABLE)
    selectCell(editor, 2, 1)
    const found = findTableAtSelection(editor)
    expect(found).not.toBeNull()
    expect(found!.table.type.name).toBe('docTable')
    expect(found!.table.childCount).toBe(4)
    editor.destroy()
  })
})
