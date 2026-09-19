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
import { LayoutUndoExtension } from '../../src/renderer/src/components/word/editor/layout-undo-extension'

const snap = (marginLeft: number, tag: string) => ({
  section: { marginLeft, tag },
  sections: [],
  sectionDirty: true,
  sectionsDirty: [],
  pgNumEdit: null,
  pgNumDirtySections: [],
  titlePg: false,
  titlePgDirty: false,
})

function makeEditor(onRestore: (s: unknown) => void) {
  // the production assembly: the real word-editor extension set + the mirror
  // appended exactly like App.tsx does
  return new Editor({
    extensions: [
      ...editorExtensions,
      LayoutUndoExtension.configure({ onRestore }),
    ],
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })
}

/** the App's applyLayoutState: snapshot through the history-tracked doc attr */
function applyLayout(editor: Editor, value: unknown) {
  editor.view.dispatch(
    editor.state.tr.setMeta('layoutUndoMirror', true).setDocAttribute('layoutUndo', value),
  )
}

describe('layout undo via the PM history mirror (true unified stack)', () => {
  it('a fresh layout change fires onRestore with the applied snapshot', () => {
    const restored: unknown[] = []
    const editor = makeEditor((s) => restored.push(s))
    applyLayout(editor, snap(1440, 'A'))
    expect(restored).toHaveLength(1)
    expect((restored[0] as { section: { tag: string } }).section.tag).toBe('A')
    editor.destroy()
  })

  it('undo replays the PREVIOUS layout snapshot; redo replays the next (chronological with typing)', () => {
    const restored: unknown[] = []
    const editor = makeEditor((s) => restored.push(s))
    editor.commands.insertContent('base text')
    expect(editor.getText()).toBe('base text')

    applyLayout(editor, snap(1440, 'A'))
    applyLayout(editor, snap(720, 'B'))
    restored.length = 0

    // typing after the layout changes: undo must revert the TEXT first, not the layout
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!')
    expect(editor.getText()).toBe('base text!')
    editor.commands.undo()
    expect(editor.getText()).toBe('base text')
    expect(restored).toHaveLength(0)

    // next undo crosses into the layout history: B -> A
    editor.commands.undo()
    expect(restored).toHaveLength(1)
    expect((restored[0] as { section: { tag: string } }).section.tag).toBe('A')

    // and again: A -> (attr back to default null, no restore fired)
    editor.commands.undo()
    expect(restored).toHaveLength(1)

    // redo walks forward through the same interleaving: layout A returns
    editor.commands.redo()
    expect(restored).toHaveLength(2)
    expect((restored[1] as { section: { tag: string } }).section.tag).toBe('A')
    editor.destroy()
  })

  it('an identical snapshot re-dispatch does not re-fire (no redundant state churn)', () => {
    let fired = 0
    const editor = makeEditor(() => {
      fired += 1
    })
    applyLayout(editor, snap(1440, 'A'))
    const first = fired
    applyLayout(editor, snap(1440, 'A'))
    expect(fired).toBe(first)
    editor.destroy()
  })

  it('with the App-style baseline seed, undoing the FIRST layout change restores the original state', () => {
    // reviewer finding (round F): without a seeded baseline the first undo
    // landed on attr null and React never replayed the original layout. The
    // App now seeds the pre-edit snapshot as a non-history doc attribute.
    const restored: unknown[] = []
    const editor = makeEditor((s) => restored.push(s))
    editor.commands.insertContent('base text')
    editor.view.dispatch(
      editor.state.tr
        .setMeta('layoutUndoMirror', true)
        .setMeta('addToHistory', false)
        .setDocAttribute('layoutUndo', snap(1440, 'baseline')),
    )
    restored.length = 0 // the seed replay itself is a no-op restore

    applyLayout(editor, snap(720, 'B'))
    restored.length = 0 // ...and so is the apply replay; only the undo counts now
    editor.commands.undo()

    // text untouched; the attr replayed the BASELINE (not null) and the
    // watcher fired so React state follows
    expect(editor.getText()).toBe('base text')
    expect((editor.state.doc.attrs.layoutUndo as { section: { tag: string } }).section.tag).toBe(
      'baseline',
    )
    expect(restored).toHaveLength(1)
    expect((restored[0] as { section: { tag: string } }).section.tag).toBe('baseline')
    // redo returns to B symmetrically
    editor.commands.redo()
    expect((editor.state.doc.attrs.layoutUndo as { section: { tag: string } }).section.tag).toBe(
      'B',
    )
    editor.destroy()
  })
})
