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
  distinctRevisionAuthors,
  revisionsOfAuthors,
} from '../../src/renderer/src/components/word/editor/revisions'

const makeEditor = () =>
  new Editor({
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })

/** type a tracked insertion by an author (TrackChangesExtension-style marks) */
function insertTracked(
  editor: Editor,
  pos: number,
  text: string,
  author: string,
) {
  const tr = editor.state.tr
  tr.insertText(text, pos, pos)
  tr.addMark(pos, pos + text.length, editor.schema.marks.ins.create({ author }))
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
}

function deleteTracked(editor: Editor, from: number, to: number, author: string) {
  const tr = editor.state.tr
  tr.addMark(from, to, editor.schema.marks.del.create({ author }))
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
}

describe('reviewer filter (ROUND2 #15: filter by author)', () => {
  it('distinctRevisionAuthors lists authors in first-appearance order, deduped', () => {
    const editor = makeEditor()
    editor.commands.insertContent('base')
    let p = 5
    for (const [text, author] of [['甲的插入', '张三'], ['乙的插入', '李四'], ['甲的第二处', '张三']] as const) {
      insertTracked(editor, p, text, author)
      p += text.length
    }
    expect(distinctRevisionAuthors(editor.state.doc)).toEqual(['张三', '李四'])
    editor.destroy()
  })

  it('revisionsOfAuthors filters ranges to the selected author set', () => {
    const editor = makeEditor()
    editor.commands.insertContent('base')
    let p = 5
    for (const [text, author] of [['甲', '张三'], ['乙', '李四']] as const) {
      insertTracked(editor, p, text, author)
      p += text.length
    }
    const all = revisionsOfAuthors(editor.state.doc, null)
    expect(all).toHaveLength(2)
    const onlyZhang = revisionsOfAuthors(editor.state.doc, new Set(['张三']))
    expect(onlyZhang).toHaveLength(1)
    expect(onlyZhang[0]!.author).toBe('张三')
    // empty selection = nothing shown/applied
    expect(revisionsOfAuthors(editor.state.doc, new Set())).toHaveLength(0)
    editor.destroy()
  })

  it('applying to one author leaves the other author’s revisions intact', () => {
    const editor = makeEditor()
    editor.commands.insertContent('base')
    let p = 5
    for (const [text, author] of [['张三的', '张三'], ['李四的', '李四']] as const) {
      insertTracked(editor, p, text, author)
      p += text.length
    }
    const { applyRevisions } = require('../../src/renderer/src/components/word/editor/revisions') as {
      applyRevisions: (e: Editor, ranges: unknown[], mode: 'accept' | 'reject') => void
    }
    applyRevisions(
      editor,
      revisionsOfAuthors(editor.state.doc, new Set(['张三'])),
      'accept',
    )
    // 张三's insertion became plain text; 李四's still carries the ins mark
    const doc = editor.state.doc
    let zhangPlain = false
    let liMarked = false
    doc.descendants((n) => {
      if (n.isText) {
        if (n.textContent.includes('张三的') && !n.marks.some((m) => m.type.name === 'ins'))
          zhangPlain = true
        if (n.textContent.includes('李四的') && n.marks.some((m) => m.type.name === 'ins'))
          liMarked = true
      }
      return true
    })
    expect(zhangPlain).toBe(true)
    expect(liMarked).toBe(true)
    editor.destroy()
  })
})
