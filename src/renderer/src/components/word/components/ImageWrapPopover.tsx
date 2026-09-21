import { useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useI18n } from '../i18n/locale'
import { WRAP_OPTIONS } from './ContextMenu'

/**
 * Word's floating "layout options" button (the little rainbow): shown at the
 * top-right corner of a selected image; one click opens the wrap-mode list
 * instead of hunting through the ribbon / context menu. Reuses the exact
 * WRAP_OPTIONS set of the context menu and the same updateAttributes path, so
 * undo and the save pipeline behave identically.
 */
export function ImageWrapPopover({ editor }: { editor: Editor }) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const [open, setOpen] = useState(false)

  const selection = editor.state.selection
  const info = useMemo(() => {
    if (!(selection instanceof NodeSelection)) return null
    const node = selection.node
    if (node.type.name !== 'docProtected' || node.attrs.blockType !== 'image') return null
    if (!editor.isEditable) return null
    const dom = editor.view.nodeDOM(selection.from) as HTMLElement | null
    if (!dom) return null
    return {
      pos: selection.from,
      wrap: (node.attrs.imageWrap as string | null) ?? null,
      node,
    }
    // recompute when the selection identity changes
  }, [editor, selection]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setOpen(false)
    if (!info) {
      setAnchor(null)
      return
    }
    const update = () => {
      const dom = editor.view.nodeDOM(info.pos) as HTMLElement | null
      if (!dom) return
      const r = dom.getBoundingClientRect()
      setAnchor({ top: r.top, left: r.right })
    }
    update()
    // follow scrolling of any container and window resizes (fixed positioning)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [editor, info])

  // close the menu on outside mousedown / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.image-wrap-pop')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!info || !anchor) return null

  const apply = (wrap: string | null) => {
    // markup the node at the KNOWN position: chain().focus() normalizes a
    // NodeSelection to a text cursor when the editor view is not focused
    // (true right after the user clicks this popover), which would silently
    // retarget updateAttributes to nothing
    const attrs: Record<string, unknown> =
      wrap === null
        ? {
            imageWrap: wrap,
            imagePosH: null,
            imagePosV: null,
            imageOffsetXEmu: null,
            imageOffsetYEmu: null,
          }
        : { imageWrap: wrap }
    const tr = editor.state.tr.setNodeMarkup(info.pos, undefined, {
      ...(info.node?.attrs ?? {}),
      ...attrs,
    })
    editor.view.dispatch(tr)
    editor.view.focus()
  }

  return (
    <div className="image-wrap-pop" style={{ top: anchor.top - 8, left: anchor.left + 6 }}>
      <button
        className="image-wrap-pop-toggle"
        data-tip={t('appWrapOptions')}
        aria-label={t('appWrapOptions')}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1 7a6 6 0 0 1 12 0" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      {open && (
        <div className="image-wrap-pop-menu" role="menu">
          {WRAP_OPTIONS.map(({ labelKey, value }) => (
            <button
              key={labelKey}
              role="menuitem"
              className={info.wrap === value ? 'active' : ''}
              onClick={() => apply(value)}
            >
              {info.wrap === value ? '✓ ' : ''}
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
