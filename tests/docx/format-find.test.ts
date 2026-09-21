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
  applyFormatReplace,
  filterRangesByFormat,
  findFormatRanges,
  isEmptyFormat,
  textRunMatchesFormat,
} from '../../src/renderer/src/components/word/editor/format-find'

const makeEditor = () =>
  new Editor({
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })

const insertStyled = (
  editor: Editor,
  pos: number,
  text: string,
  style?: { font?: string; sizeHalfPoints?: number; color?: string; bold?: boolean; italic?: boolean },
) => {
  const tr = editor.state.tr
  tr.insertText(text, pos, pos)
  if (style?.bold) tr.addMark(pos, pos + text.length, editor.state.schema.marks.bold.create())
  if (style?.italic) tr.addMark(pos, pos + text.length, editor.state.schema.marks.italic.create())
  const styleAttrs: Record<string, unknown> = {}
  if (style?.font) {
    styleAttrs.font = style.font
    styleAttrs.fontAscii = style.font
  }
  if (style?.sizeHalfPoints) styleAttrs.sizeHalfPoints = style.sizeHalfPoints
  if (style?.color) styleAttrs.color = style.color
  if (Object.keys(styleAttrs).length > 0)
    tr.addMark(pos, pos + text.length, editor.state.schema.marks.docTextStyle.create(styleAttrs))
  else
    // insertText inherits the position's stored marks — strip them so an
    // unstyled run stays a distinct node (PM would otherwise merge neighbours)
    tr.removeMark(pos, pos + text.length)
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
}

describe('format find & replace (ROUND2 #28)', () => {
  it('isEmptyFormat: every-wildcard is empty; any set field is not', () => {
    expect(isEmptyFormat({})).toBe(true)
    expect(isEmptyFormat({ font: null, bold: null })).toBe(true)
    expect(isEmptyFormat({ font: '宋体' })).toBe(false)
    expect(isEmptyFormat({ bold: false })).toBe(false)
  })

  it('textRunMatchesFormat truth table: set fields must all match, unset are wildcards', () => {
    const probe = { font: 'SimSun', fontAscii: 'SimSun', sizeHalfPoints: 24, color: 'FF0000', bold: true }
    expect(textRunMatchesFormat(probe, {})).toBe(true)
    expect(textRunMatchesFormat(probe, { font: 'simsun' })).toBe(true) // case-insensitive
    expect(textRunMatchesFormat(probe, { font: 'SimHei' })).toBe(false)
    expect(textRunMatchesFormat(probe, { sizeHalfPoints: 24 })).toBe(true)
    expect(textRunMatchesFormat(probe, { sizeHalfPoints: 28 })).toBe(false)
    expect(textRunMatchesFormat(probe, { color: '#ff0000' })).toBe(true) // '#' tolerated
    expect(textRunMatchesFormat(probe, { bold: true })).toBe(true)
    expect(textRunMatchesFormat(probe, { bold: false })).toBe(false)
    expect(textRunMatchesFormat(probe, { italic: true })).toBe(false)
    // conjunction
    expect(textRunMatchesFormat(probe, { bold: true, sizeHalfPoints: 24 })).toBe(true)
    expect(textRunMatchesFormat(probe, { bold: true, sizeHalfPoints: 28 })).toBe(false)
  })

  it('findFormatRanges locates styled runs only; applyFormatReplace restyles them in one undo step', () => {
    const editor = makeEditor()
    insertStyled(editor, 1, '普通文字')
    insertStyled(editor, 5, '红色文字', { color: 'FF0000' })
    insertStyled(editor, 9, '普通')
    insertStyled(editor, 11, '又是红色', { color: 'FF0000' })
    insertStyled(editor, 15, '普通')
    insertStyled(editor, 17, '蓝色文字', { color: '0000FF' })

    const red = findFormatRanges(editor, { color: 'FF0000' })
    expect(red).toHaveLength(2)
    expect(editor.state.doc.textBetween(red[0]!.from, red[0]!.to)).toBe('红色文字')

    applyFormatReplace(editor, red, { color: '0000FF' })
    // both former-red runs are now blue; nothing red remains
    expect(findFormatRanges(editor, { color: 'FF0000' })).toHaveLength(0)
    const blue = findFormatRanges(editor, { color: '0000FF' })
    expect(blue).toHaveLength(3)

    // one Ctrl+Z restores the red color
    editor.commands.undo()
    expect(findFormatRanges(editor, { color: 'FF0000' })).toHaveLength(2)
    editor.destroy()
  })

  it('bold/italic-only replace flips the marks without touching text', () => {
    const editor = makeEditor()
    insertStyled(editor, 1, 'plain text')
    const ranges = findFormatRanges(editor, { bold: false })
    expect(ranges).toHaveLength(1)
    applyFormatReplace(editor, ranges, { bold: true })
    expect(findFormatRanges(editor, { bold: true })).toHaveLength(1)
    expect(editor.state.doc.textContent).toBe('plain text')
    editor.destroy()
  })

  it('filterRangesByFormat narrows text matches to runs in the sought format', () => {
    const editor = makeEditor()
    insertStyled(editor, 1, 'big text', { sizeHalfPoints: 32 })
    insertStyled(editor, 9, 'small text', { sizeHalfPoints: 21 })
    // text query "text" would hit both; the format filter keeps only the big run
    const textRanges = [
      { from: 5, to: 9 },
      { from: 18, to: 22 },
    ]
    const filtered = filterRangesByFormat(editor, textRanges, { sizeHalfPoints: 32 })
    expect(filtered).toHaveLength(1)
    expect(editor.state.doc.textBetween(filtered[0]!.from, filtered[0]!.to)).toBe('text')
    // empty format = passthrough
    expect(filterRangesByFormat(editor, textRanges, {})).toHaveLength(2)
    editor.destroy()
  })
})
