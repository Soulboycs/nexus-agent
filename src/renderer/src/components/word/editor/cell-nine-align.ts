/**
 * Word's nine-cell alignment grid (表格工具/布局 → 对齐方式): one click sets a
 * cell's vertical alignment (w:vAlign) AND its paragraphs' horizontal
 * alignment (w:jc) atomically — the split vertical/horizontal button rows
 * needed multiple clicks and could not sync multi-cell selections. 'top' and
 * 'left' write null (Word's defaults), keeping saved XML round-trip clean.
 */
import type { Editor } from '@tiptap/core'
import { CellSelection, selectedRect } from '@tiptap/pm/tables'

export type NineV = 'top' | 'center' | 'bottom'
export type NineH = 'left' | 'center' | 'right'

export type NineAlignResult = 'ok' | 'no-table'

export function setCellNineAlign(
  editor: Editor,
  align: { v: NineV; h: NineH },
): NineAlignResult {
  const { state } = editor
  const sel = state.selection
  const inCell = sel.$from.depth >= 2 && state.doc.resolve(sel.$from.before(-1)) !== undefined
  const isCellSelection = sel instanceof CellSelection
  // locate the rect whether the caret sits in a cell or a CellSelection spans many
  let rect
  try {
    rect = selectedRect(state)
  } catch {
    return 'no-table'
  }
  if (!rect || !isCellSelection) {
    if (!inCell) return 'no-table'
  }
  const vAlign = align.v === 'top' ? null : align.v
  const paraAlign = align.h === 'left' ? null : align.h

  const tr = state.tr
  const tableStart = rect.tableStart
  const { map, top, bottom, left, right } = rect
  const seenCells = new Set<number>()
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      const cellPos = map.map[r * map.width + c]
      if (cellPos == null || seenCells.has(cellPos)) continue
      seenCells.add(cellPos)
      const abs = tableStart + cellPos
      const cell = state.doc.nodeAt(abs)
      if (!cell) continue
      // vertical alignment on the cell node itself
      tr.setNodeMarkup(abs, undefined, { ...cell.attrs, vAlign })
      // paragraph alignment on every block paragraph inside the cell
      cell.forEach((para, offset) => {
        if (
          para.type.name !== 'docParagraph' &&
          para.type.name !== 'docListItem' &&
          para.type.name !== 'docHeading'
        )
          return
        tr.setNodeMarkup(abs + 1 + offset, undefined, { ...para.attrs, align: paraAlign })
      })
    }
  }
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
  return 'ok'
}
