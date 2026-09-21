import { useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SectionSettings } from '@genoffice/docx-engine'
import { t } from '../i18n/locale'
import { dragDeltaToTwips, type RulerUnit } from '../editor/ruler-units'

const twipsToPx = (twips: number) => (twips / 1440) * 96

/**
 * Vertical ruler along the page's left edge (Word: 视图 → 标尺): gray margin
 * zones at the top/bottom, draggable handles that change the section's top /
 * bottom margins. The edit routes through the caller's handler (the page-setup
 * path), so Ctrl+Z undoes it like every other layout change.
 */
export function VRuler({
  section,
  unit = 'inch',
  onVerticalMargins,
}: {
  section: SectionSettings
  unit?: RulerUnit
  onVerticalMargins: (margins: { marginTop: number; marginBottom: number }) => void
}) {
  const height = twipsToPx(section.pageHeight)
  const marginTop = twipsToPx(section.marginTop)
  const marginBottom = twipsToPx(section.marginBottom)

  const dragRef = useRef<{ kind: 'top' | 'bottom'; startY: number; orig: number } | null>(null)

  const handleMouseDown = (e: ReactMouseEvent, kind: 'top' | 'bottom') => {
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = {
      kind,
      startY: e.clientY,
      orig: kind === 'top' ? section.marginTop : section.marginBottom,
    }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dy = ev.clientY - dragRef.current.startY
      const dTwips = dragDeltaToTwips(dy, unit)
      const handle = document.querySelector(
        kind === 'top' ? '.vruler-handle-top' : '.vruler-handle-bottom',
      ) as HTMLElement | null
      if (handle) {
        const next = Math.max(0, dragRef.current.orig + (kind === 'top' ? dTwips : -dTwips))
        handle.style.top =
          kind === 'top' ? `${twipsToPx(next)}px` : `${height - twipsToPx(next)}px`
      }
    }
    const up = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      if (!dragRef.current) return
      const dTwips = dragDeltaToTwips(ev.clientY - dragRef.current.startY, unit)
      const { kind: k, orig } = dragRef.current
      dragRef.current = null
      const marginTopNext =
        k === 'top' ? Math.max(0, orig + dTwips) : section.marginTop
      const marginBottomNext =
        k === 'bottom' ? Math.max(0, orig - dTwips) : section.marginBottom
      if (
        marginTopNext !== section.marginTop ||
        marginBottomNext !== section.marginBottom
      ) {
        onVerticalMargins({ marginTop: marginTopNext, marginBottom: marginBottomNext })
      }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  return (
    <div className="vruler" style={{ height }}>
      <div className="vruler-zone" style={{ top: 0, height: marginTop }} />
      <div className="vruler-zone" style={{ bottom: 0, height: marginBottom }} />
      <div
        className="vruler-handle vruler-handle-top"
        style={{ top: marginTop }}
        data-tip={t('appRulerTopMargin')}
        onMouseDown={(e) => handleMouseDown(e, 'top')}
      />
      <div
        className="vruler-handle vruler-handle-bottom"
        style={{ top: height - marginBottom }}
        data-tip={t('appRulerBottomMargin')}
        onMouseDown={(e) => handleMouseDown(e, 'bottom')}
      />
    </div>
  )
}
