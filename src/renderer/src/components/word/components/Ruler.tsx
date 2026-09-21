import { useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { SectionSettings, TabStop } from '@genoffice/docx-engine'
import { t, type StringKey } from '../i18n/locale'
import { setParaAttrs } from './ribbon-tabs'
import {
  rulerTicks,
  twipsToUnitText,
  dragDeltaToTwips,
  type RulerUnit,
} from '../editor/ruler-units'

const twipsToPx = (twips: number) => (twips / 1440) * 96

/** A `clear` stop cancels an inherited stop — it marks no position, so the
    ruler renders nothing for it (write-back still carries it). Exported for tests. */
export function isRenderableTabStop(stop: TabStop): boolean {
  return stop.val !== 'clear'
}

/** A ruler edit makes the whole set direct (Word writes style-inherited stops
    out too). An inherited stop the user removed or moved needs a `clear` at its
    old position, or the style chain puts it back on reopen. Exported for tests. */
export function directTabStops(original: TabStop[], edited: TabStop[]): TabStop[] {
  const clears = original
    .filter((s) => s.inherited && !edited.some((e) => e.pos === s.pos))
    .map((s): TabStop => ({ pos: s.pos, val: 'clear' }))
  return [...edited.map(({ inherited: _inherited, ...s }) => s), ...clears].sort(
    (a, b) => a.pos - b.pos,
  )
}

/** Horizontal ruler above the page: inch numbers, gray margin zones, tab stops. */
export function Ruler({
  section,
  editor,
  onTabStopsChange,
}: {
  section: SectionSettings
  editor: Editor | null
  onTabStopsChange: (stops: TabStop[] | null) => void
}) {
  const width = twipsToPx(section.pageWidth)
  const marginLeft = twipsToPx(section.marginLeft)
  const marginRight = twipsToPx(section.marginRight)
  // unit switch (Word: right-click ruler → units); remembered across sessions
  const [unit, setUnit] = useState<RulerUnit>(
    () => (localStorage.getItem('nexus.ruler.unit') === 'cm' ? 'cm' : 'inch'),
  )
  const switchUnit = (next: RulerUnit) => {
    setUnit(next)
    localStorage.setItem('nexus.ruler.unit', next)
  }
  const ticks = rulerTicks(section.pageWidth, unit)

  // Default Word tab interval: 0.5in = 720 twips
  const DEFAULT_TAB_TWIPS = 720

  // Tab stop type cycling (Word: click ruler button to cycle L/C/R/Decimal/Bar)
  const [nextTabType, setNextTabType] = useState<TabStop['val']>('left')
  const TAB_TYPE_CYCLE: TabStop['val'][] = ['left', 'center', 'right', 'decimal', 'bar']
  const TAB_TYPE_LABELS: Record<string, string> = {
    left: 'L',
    center: '⊥',
    right: '⌐',
    decimal: '.',
    bar: '|',
  }
  const TAB_TYPE_NAME_KEYS: Record<TabStop['val'], StringKey> = {
    left: 'appTabLeft',
    center: 'appTabCenter',
    right: 'appTabRight',
    decimal: 'appTabDecimal',
    bar: 'appTabBar',
    clear: 'appTabClear',
  }

  // Get current tab stops from focused paragraph. rel stops mirror w:ptab
  // (percent positions): not draggable ruler stops, but every write-back must
  // carry them or a ruler edit silently drops the paragraph's ptab layout.
  const currentTabStops = (): { stops: TabStop[]; relStops: TabStop[] } => {
    if (!editor) return { stops: [], relStops: [] }
    const attrs = editor.isActive('docHeading')
      ? editor.getAttributes('docHeading')
      : editor.isActive('docListItem')
        ? editor.getAttributes('docListItem')
        : editor.getAttributes('docParagraph')
    const raw = attrs?.tabStops as string | null
    if (!raw) return { stops: [], relStops: [] }
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return { stops: [], relStops: [] }
      return { stops: parsed.filter((s) => !s.rel), relStops: parsed.filter((s) => s.rel) }
    } catch {
      return { stops: [], relStops: [] }
    }
  }

  const { stops, relStops } = currentTabStops()
  const withRel = (edited: TabStop[]): TabStop[] | null => {
    const direct = directTabStops(stops, edited)
    return direct.length > 0 || relStops.length > 0 ? [...direct, ...relStops] : null
  }

  // Drag state
  const dragRef = useRef<{ stopIndex: number; startX: number; origPos: number } | null>(null)

  // Click on ruler: add tab stop at position, skip margin zones
  const handleRulerClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x < marginLeft || x > width - marginRight) return
    const posTwips = Math.round((x / width) * section.pageWidth)
    // snap to nearest 60 twips (~0.04in)
    const snapped = Math.round(posTwips / 60) * 60
    const existing = stops.filter((s) => Math.abs(s.pos - snapped) > 60)
    const newStop: TabStop = { pos: snapped, val: nextTabType }
    const newStops = [...existing, newStop].sort((a, b) => a.pos - b.pos)
    onTabStopsChange(withRel(newStops))
  }

  // Drag tab stop to new position or drop outside to delete
  const handleTabMouseDown = (e: ReactMouseEvent<HTMLSpanElement>, stopIndex: number) => {
    e.stopPropagation()
    e.preventDefault()
    const rect = (e.currentTarget.closest('.ruler') as HTMLElement).getBoundingClientRect()
    dragRef.current = { stopIndex, startX: e.clientX, origPos: stops[stopIndex].pos }

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const x = ev.clientX - rect.left
      const posTwips = Math.round((x / width) * section.pageWidth)
      const snapped = Math.round(posTwips / 60) * 60
      // visual only update via CSS custom property (no state update for perf)
      const marker = document.querySelector(
        `[data-ruler-stop="${stopIndex}"]`,
      ) as HTMLElement | null
      if (marker) marker.style.left = `${twipsToPx(snapped)}px`
    }

    const onMouseUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (!dragRef.current) return
      const x = ev.clientX - rect.left
      // drop outside the content area: delete the stop
      if (x < marginLeft || x > width - marginRight) {
        const newStops = stops.filter((_, i) => i !== dragRef.current!.stopIndex)
        onTabStopsChange(withRel(newStops))
      } else {
        const posTwips = Math.round((x / width) * section.pageWidth)
        const snapped = Math.round(posTwips / 60) * 60
        const newStops = stops
          .map((s, i) => (i === dragRef.current!.stopIndex ? { ...s, pos: snapped } : s))
          .sort((a, b) => a.pos - b.pos)
        onTabStopsChange(withRel(newStops))
      }
      dragRef.current = null
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // Paragraph indentation from focused node
  const activeAttrs = editor
    ? editor.isActive('docHeading')
      ? editor.getAttributes('docHeading')
      : editor.isActive('docListItem')
        ? editor.getAttributes('docListItem')
        : editor.getAttributes('docParagraph')
    : null

  const indentLeftTwips = Number(activeAttrs?.indentLeft) || 0
  const indentRightTwips = Number(activeAttrs?.indentRight) || 0
  const indentFirstLineTwips =
    activeAttrs?.indentFirstLine != null ? Number(activeAttrs.indentFirstLine) : 0

  const firstLinePx = marginLeft + twipsToPx(indentLeftTwips + indentFirstLineTwips)
  const hangingPx = marginLeft + twipsToPx(indentLeftTwips)
  const leftPx = marginLeft + twipsToPx(indentLeftTwips)
  const rightPx = width - marginRight - twipsToPx(indentRightTwips)

  const dragIndentRef = useRef<{
    kind: 'firstLine' | 'hanging' | 'left' | 'right'
    startX: number
    origLeft: number
    origFirstLine: number
    origRight: number
  } | null>(null)

  const handleIndentMouseDown = (
    e: ReactMouseEvent,
    kind: 'firstLine' | 'hanging' | 'left' | 'right',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    if (!editor) return

    dragIndentRef.current = {
      kind,
      startX: e.clientX,
      origLeft: indentLeftTwips,
      origFirstLine: indentFirstLineTwips,
      origRight: indentRightTwips,
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragIndentRef.current) return
      const dx = ev.clientX - dragIndentRef.current.startX
      const dTwips = dragDeltaToTwips(dx, unit)
      const { kind, origLeft, origFirstLine, origRight } = dragIndentRef.current

      let newLeft = origLeft
      let newFirstLine = origFirstLine
      let newRight = origRight

      if (kind === 'firstLine') {
        newFirstLine = origFirstLine + dTwips
      } else if (kind === 'hanging') {
        newLeft = Math.max(0, origLeft + dTwips)
        newFirstLine = origFirstLine - (newLeft - origLeft)
      } else if (kind === 'left') {
        newLeft = Math.max(0, origLeft + dTwips)
      } else if (kind === 'right') {
        newRight = Math.max(0, origRight - dTwips)
      }

      const flEl = document.querySelector('.ruler-indent-firstline') as HTMLElement | null
      const hgEl = document.querySelector('.ruler-indent-hanging') as HTMLElement | null
      const lfEl = document.querySelector('.ruler-indent-left') as HTMLElement | null
      const rtEl = document.querySelector('.ruler-indent-right') as HTMLElement | null

      if (flEl) flEl.style.left = `${marginLeft + twipsToPx(newLeft + newFirstLine)}px`
      if (hgEl) hgEl.style.left = `${marginLeft + twipsToPx(newLeft)}px`
      if (lfEl) lfEl.style.left = `${marginLeft + twipsToPx(newLeft)}px`
      if (rtEl) rtEl.style.left = `${width - marginRight - twipsToPx(newRight)}px`
    }

    const onMouseUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (!dragIndentRef.current || !editor) return
      const dx = ev.clientX - dragIndentRef.current.startX
      const dTwips = dragDeltaToTwips(dx, unit)
      const { kind, origLeft, origFirstLine, origRight } = dragIndentRef.current

      let newLeft = origLeft
      let newFirstLine = origFirstLine
      let newRight = origRight

      if (kind === 'firstLine') {
        newFirstLine = origFirstLine + dTwips
      } else if (kind === 'hanging') {
        newLeft = Math.max(0, origLeft + dTwips)
        newFirstLine = origFirstLine - (newLeft - origLeft)
      } else if (kind === 'left') {
        newLeft = Math.max(0, origLeft + dTwips)
      } else if (kind === 'right') {
        newRight = Math.max(0, origRight - dTwips)
      }

      dragIndentRef.current = null

      setParaAttrs(editor, {
        indentLeft: newLeft > 0 ? newLeft : null,
        indentRight: newRight > 0 ? newRight : null,
        indentFirstLine: newFirstLine !== 0 ? newFirstLine : null,
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // Default tab stop markers (light gray) when no custom stops mark a position
  const defaultStops: number[] = []
  if (!stops.some(isRenderableTabStop)) {
    const contentWidth = section.pageWidth - section.marginLeft - section.marginRight
    for (let pos = DEFAULT_TAB_TWIPS; pos < contentWidth; pos += DEFAULT_TAB_TWIPS) {
      defaultStops.push(section.marginLeft + pos)
    }
  }

  return (
    <div className="ruler" style={{ width }} onClick={handleRulerClick}>
      {/* Tab type selector button at far left */}
      <button
        className="ruler-tab-type"
        data-tip={t('appTabTypeTip', { type: t(TAB_TYPE_NAME_KEYS[nextTabType]) })}
        onClick={(e) => {
          e.stopPropagation()
          const idx = TAB_TYPE_CYCLE.indexOf(nextTabType)
          setNextTabType(TAB_TYPE_CYCLE[(idx + 1) % TAB_TYPE_CYCLE.length])
        }}
      >
        {TAB_TYPE_LABELS[nextTabType]}
      </button>

      {/* unit toggle (inch / cm) */}
      <button
        className="ruler-unit-toggle"
        data-tip={unit === 'inch' ? t('appRulerUnitSwitchCm') : t('appRulerUnitSwitchInch')}
        onClick={(e) => {
          e.stopPropagation()
          switchUnit(unit === 'inch' ? 'cm' : 'inch')
        }}
      >
        {unit === 'inch' ? '"' : 'cm'}
      </button>

      <div className="ruler-zone" style={{ left: 0, width: marginLeft }} />
      <div className="ruler-zone" style={{ left: width - marginRight, width: marginRight }} />

      {ticks.map((tick) => (
        <span key={tick.label} className="ruler-num" style={{ left: twipsToPx(tick.pos) }}>
          {tick.label}
        </span>
      ))}

      {/* Indent sliders (Word 1:1) */}
      <div
        className="ruler-indent-handle ruler-indent-firstline"
        style={{ left: firstLinePx }}
        data-tip={t('appIndentFirstLine')}
        onMouseDown={(e) => handleIndentMouseDown(e, 'firstLine')}
      >
        <svg width="10" height="8" viewBox="0 0 10 8">
          <polygon points="1,1 9,1 5,7" fill="#444" stroke="#222" strokeWidth="0.5" />
        </svg>
      </div>
      <div
        className="ruler-indent-handle ruler-indent-hanging"
        style={{ left: hangingPx }}
        data-tip={t('appIndentHanging')}
        onMouseDown={(e) => handleIndentMouseDown(e, 'hanging')}
      >
        <svg width="10" height="8" viewBox="0 0 10 8">
          <polygon points="5,1 9,7 1,7" fill="#444" stroke="#222" strokeWidth="0.5" />
        </svg>
      </div>
      <div
        className="ruler-indent-handle ruler-indent-left"
        style={{ left: leftPx }}
        data-tip={t('appIndentLeft')}
        onMouseDown={(e) => handleIndentMouseDown(e, 'left')}
      >
        <svg width="10" height="4" viewBox="0 0 10 4">
          <rect x="1" y="0" width="8" height="4" fill="#444" stroke="#222" strokeWidth="0.5" />
        </svg>
      </div>
      <div
        className="ruler-indent-handle ruler-indent-right"
        style={{ left: rightPx }}
        data-tip={t('appIndentRight')}
        onMouseDown={(e) => handleIndentMouseDown(e, 'right')}
      >
        <svg width="10" height="9" viewBox="0 0 10 9">
          <polygon points="5,1 9,8 1,8" fill="#444" stroke="#222" strokeWidth="0.5" />
        </svg>
      </div>

      {/* Default tab stop guides (light, no interaction) */}
      {defaultStops.map((posTwips) => (
        <span
          key={`def-${posTwips}`}
          className="ruler-tab-default"
          style={{ left: twipsToPx(posTwips) }}
        />
      ))}

      {/* Custom tab stops (interactive). A `clear` stop cancels inherited
          stops at its position — it places no mark, so it renders nothing
          (returning null keeps data-ruler-stop indexes aligned with `stops`
          for drag handling) while write-back still preserves it. */}
      {stops.map((stop, i) =>
        !isRenderableTabStop(stop) ? null : (
          <span
            key={`${stop.pos}-${i}`}
            data-ruler-stop={i}
            className={`ruler-tab ruler-tab-${stop.val}`}
            style={{ left: twipsToPx(stop.pos) }}
            data-tip={
              t('appTabStopTitle', {
                type: t(TAB_TYPE_NAME_KEYS[stop.val]),
                pos: twipsToUnitText(stop.pos, unit),
              }) + (stop.leader ? t('appTabLeader', { leader: stop.leader }) : '')
            }
            onMouseDown={(e) => handleTabMouseDown(e, i)}
          >
            {TAB_TYPE_LABELS[stop.val]}
          </span>
        ),
      )}
    </div>
  )
}
