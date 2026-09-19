/**
 * Ruler units and geometry (Word: 标尺右键 → 单位): the horizontal ruler can
 * show inch or centimeter scales, and a vertical ruler exposes the top/bottom
 * page margins with draggable handles. Pure geometry lives here so tests pin
 * the tick math; the DOM wiring stays in Ruler.tsx / VRuler.tsx.
 */
export type RulerUnit = 'inch' | 'cm'

export const TWIPS_PER_INCH = 1440
/** OOXML: 1 cm = 567 twips (dxa) */
export const TWIPS_PER_CM = 567

export interface RulerTick {
  /** position from the page's left/top edge, twips */
  pos: number
  /** the printed number; 0 = origin, 1/2/3… per unit */
  label: number
}

/** whole-unit ticks inside the page (label 1..n; the origin 0 is implicit) */
export function rulerTicks(pageSizeTwips: number, unit: RulerUnit): RulerTick[] {
  const step = unit === 'inch' ? TWIPS_PER_INCH : TWIPS_PER_CM
  const out: RulerTick[] = []
  for (let pos = step, label = 1; pos <= pageSizeTwips; pos += step, label++) {
    out.push({ pos, label })
  }
  return out
}

/** tick label text: whole numbers in inches; centimeters show one decimal only when fractional */
export function tickLabelText(label: number, unit: RulerUnit): string {
  return unit === 'inch' ? String(label) : String(label)
}

/** position -> unit text for tooltips (tab stop titles etc.) */
export function twipsToUnitText(twips: number, unit: RulerUnit): string {
  if (unit === 'inch') {
    const inches = twips / TWIPS_PER_INCH
    return `${(Math.round(inches * 100) / 100).toFixed(2)}"`
  }
  const cm = twips / TWIPS_PER_CM
  return `${(Math.round(cm * 10) / 10).toFixed(1)} cm`
}

/** drag delta px -> snapped twips (1/20 pt precision, min step per unit) */
export function dragDeltaToTwips(dxPx: number, unit: RulerUnit): number {
  const raw = (dxPx / 96) * TWIPS_PER_INCH
  const snap = unit === 'inch' ? 20 : 15 // 1pt vs ~0.5mm
  return Math.round(raw / snap) * snap
}
