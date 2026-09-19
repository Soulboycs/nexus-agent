/**
 * Table sorting (Word: 表格工具 / Home → Sort): reorder the body rows of the
 * docTable under the cursor by one column, numeric-aware, header row pinned.
 * One transaction = one undo step; the save path regenerates the table XML
 * from the reordered nodes automatically (pmTableToModel sees the new order).
 */
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'

export interface TableAtSelection {
  table: PmNode
  pos: number
}

export function findTableAtSelection(editor: Editor): TableAtSelection | null {
  const { from } = editor.state.selection
  const doc = editor.state.doc
  let found: TableAtSelection | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name !== 'docTable') return true
    if (from >= pos && from <= pos + node.nodeSize) found = { table: node, pos }
    return false
  })
  return found
}

/** a cell's sort key: plain text of its first-line content */
function cellTextOf(cell: PmNode): string {
  return cell.textContent.trim()
}

/** '1,234.5'/'￥-12'/'85.5%' -> number; anything non-numeric -> null */
export function numericKeyOf(text: string): number | null {
  const t = text.replace(/[\s,，]/g, '').replace(/[￥$€£]/g, '').replace(/%$/, '')
  if (!t) return null
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * Column comparison: a column whose two keys are both numeric compares by
 * value; a key that is empty sorts first; text compares codepoint-wise
 * (deterministic across runtimes; Word's pinyin collation is not replicated).
 */
export function compareCellKeys(a: string, b: string): number {
  const na = numericKeyOf(a)
  const nb = numericKeyOf(b)
  if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1
  if (!a && b) return -1
  if (a && !b) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** visible cells of a row, merged spans expanded to one entry per grid column */
export function expandedRowCells(row: PmNode): PmNode[] {
  const out: PmNode[] = []
  row.forEach((cell) => {
    if (cell.attrs.gridGap) return
    const span = Math.max(1, Number(cell.attrs.colSpan) || 1)
    for (let i = 0; i < span; i++) out.push(cell)
  })
  return out
}

export function rowKeyAt(row: PmNode, col: number): string {
  const cells = expandedRowCells(row)
  const cell = cells[col]
  return cell ? cellTextOf(cell) : ''
}

export interface SortTableOptions {
  /** grid column index to sort by */
  col: number
  asc: boolean
  /** pin the first row (Word's 有标题行) */
  hasHeader: boolean
}

export type SortTableResult = 'ok' | 'no-table'

export function sortTableByColumn(editor: Editor, opts: SortTableOptions): SortTableResult {
  const found = findTableAtSelection(editor)
  if (!found) return 'no-table'
  const { table, pos } = found
  const rows: PmNode[] = []
  table.forEach((r) => rows.push(r))
  if (rows.length < 2) return 'ok'
  const header = opts.hasHeader ? rows.slice(0, 1) : []
  const body = opts.hasHeader ? rows.slice(1) : rows
  const keyed = body.map((r, i) => ({ r, i, key: rowKeyAt(r, opts.col) }))
  // direction inside the comparator (not a post-reverse): tied keys keep their
  // original relative order in BOTH directions, like Word's stable sort
  keyed.sort((a, b) => {
    const c = compareCellKeys(a.key, b.key)
    if (c !== 0) return opts.asc ? c : -c
    return a.i - b.i
  })
  const sorted = keyed
  const nextRows = [...header, ...sorted.map((k) => k.r)]
  const tr = editor.state.tr.replaceWith(
    pos + 1,
    pos + 1 + table.content.size,
    nextRows,
  )
  editor.view.dispatch(tr)
  return 'ok'
}
