import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'

/**
 * HeadingFolding – Heading 1–3 collapse/expand (like Word's heading fold arrows).
 *
 * Renders a toggle arrow widget (▼/▶) at the start of each h1–h3 heading that
 * has content below it.  Clicking the arrow hides/shows all block-level siblings
 * until the next heading of equal or higher level.
 *
 * Implementation constraints (must not break OOXML round-trip):
 * – NO document mutations – folded state is kept purely in plugin state.
 * – NO ProseMirror node attribute changes.
 * – Hidden blocks use Decoration.node({ class: 'doc-collapsed-block' }) so they
 *   are invisible in the DOM but still exist in the model.
 */

export const headingFoldingKey = new PluginKey<HeadingFoldingState>('headingFolding')

/** Set of heading node positions (absolute) that are currently collapsed */
type HeadingFoldingState = Set<number>

/** Determine the heading level of a top-level block (1–3, or 0 if not a heading) */
function headingLevel(node: PmNode): number {
  if (node.type.name !== 'docHeading') return 0
  const level = Number(node.attrs.level)
  return level >= 1 && level <= 3 ? level : 0
}

/**
 * Build a DecorationSet for the given state and fold set.
 * Scans top-level children; for each h1–h3 that has a following sibling block,
 * adds a toggle widget.  If collapsed, all sibling blocks until the next heading
 * of equal/higher level receive the 'doc-collapsed-block' decoration.
 */
function buildDecorations(doc: PmNode, foldedSet: HeadingFoldingState): DecorationSet {
  const decorations: Decoration[] = []

  // Iterate all top-level children (doc offset starts at 0)
  const blocks: Array<{ node: PmNode; pos: number }> = []
  doc.forEach((node, relOffset) => {
    blocks.push({ node, pos: relOffset })
  })

  for (let i = 0; i < blocks.length; i++) {
    const { node, pos } = blocks[i]
    const level = headingLevel(node)
    if (level === 0) continue

    // Check if there's content below this heading that could be folded
    const hasChildren = (() => {
      for (let j = i + 1; j < blocks.length; j++) {
        const sibLevel = headingLevel(blocks[j].node)
        if (sibLevel > 0 && sibLevel <= level) break
        return true
      }
      return false
    })()

    if (!hasChildren) continue

    // Add toggle widget at pos + 1 (inside heading node, before text content)
    const collapsed = foldedSet.has(pos)
    const widget = document.createElement('span')
    widget.className = 'doc-heading-fold-toggle'
    widget.setAttribute('aria-label', collapsed ? 'expand' : 'collapse')
    widget.setAttribute('data-fold-pos', String(pos))
    widget.textContent = collapsed ? '▶' : '▼'
    // Prevent ProseMirror from treating the click as a selection event
    widget.addEventListener('mousedown', (e) => e.preventDefault())

    decorations.push(
      Decoration.widget(pos + 1, widget, {
        side: -1,
        key: `fold-toggle-${pos}`,
      }),
    )

    // If collapsed, hide all blocks until the next heading of equal/higher level
    if (collapsed) {
      for (let j = i + 1; j < blocks.length; j++) {
        const sib = blocks[j]
        const sibLevel = headingLevel(sib.node)
        if (sibLevel > 0 && sibLevel <= level) break
        decorations.push(
          Decoration.node(
            sib.pos,
            sib.pos + sib.node.nodeSize,
            { class: 'doc-collapsed-block' },
            { class: 'doc-collapsed-block', collapsed: true },
          ),
        )
      }
    }
  }

  return DecorationSet.create(doc, decorations)
}

export const HeadingFolding = Extension.create({
  name: 'headingFolding',

  addProseMirrorPlugins() {
    return [
      new Plugin<HeadingFoldingState>({
        key: headingFoldingKey,

        state: {
          init(_config, _state): HeadingFoldingState {
            return new Set()
          },
          apply(tr, foldedSet): HeadingFoldingState {
            const meta = tr.getMeta(headingFoldingKey) as
              | { toggle: number }
              | undefined
            if (!meta) return foldedSet
            const next = new Set(foldedSet)
            if (next.has(meta.toggle)) {
              next.delete(meta.toggle)
            } else {
              next.add(meta.toggle)
            }
            return next
          },
        },

        props: {
          decorations(state: EditorState): DecorationSet {
            const foldedSet = headingFoldingKey.getState(state) ?? new Set<number>()
            return buildDecorations(state.doc, foldedSet)
          },

          handleClick(view, _pos, event) {
            const target = event.target as HTMLElement
            if (!target.classList.contains('doc-heading-fold-toggle')) return false
            const foldPos = parseInt(target.getAttribute('data-fold-pos') ?? '', 10)
            if (isNaN(foldPos)) return false
            view.dispatch(view.state.tr.setMeta(headingFoldingKey, { toggle: foldPos }))
            return true
          },
        },
      }),
    ]
  },
})
