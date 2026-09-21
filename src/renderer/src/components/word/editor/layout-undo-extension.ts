/**
 * Page-layout undo mirror: layout edits (margins, orientation, section
 * settings) live in React state next to the ProseMirror document, so they are
 * written into a doc attribute (`layoutUndo`) via `tr.setDocAttribute` — one
 * history entry inside the editor's own History plugin. The watcher plugin
 * fires `onRestore` whenever the attribute changes (fresh edit, undo or redo
 * alike), so React state always ends up matching the doc, whatever the origin.
 *
 * This makes Ctrl+Z chronological across typing and layout changes with no
 * keyboard interception: undoing past a layout change simply replays the
 * previous attribute value.
 */
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LayoutUndoExtension = Extension.create<{ onRestore: (snap: any) => void }>({
  name: 'layoutUndo',

  addOptions() {
    return { onRestore: () => {} }
  },

  addGlobalAttributes() {
    return [
      {
        types: ['doc'],
        attributes: {
          layoutUndo: { default: null, keepOnSplit: false },
        },
      },
    ]
  },

  addProseMirrorPlugins() {
    const onRestore = this.options.onRestore
    let appliedKey: string | null = null
    return [
      new Plugin({
        view: () => ({
          update: (view) => {
            const snap = view.state.doc.attrs.layoutUndo
            const key = snap ? JSON.stringify(snap) : null
            if (key === appliedKey) return
            appliedKey = key
            if (snap) onRestore(snap)
          },
        }),
      }),
    ]
  },
})
