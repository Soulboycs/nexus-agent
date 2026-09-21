import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  dragDeltaToTwips,
  rulerTicks,
  twipsToUnitText,
} from '../../src/renderer/src/components/word/editor/ruler-units'

describe('ruler units and vertical ruler (ROUND2 #23)', () => {
  it('inch ticks: whole inches (1440 twips step) across A4 portrait', () => {
    const ticks = rulerTicks(11906, 'inch')
    expect(ticks.map((t) => t.label)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(ticks[0]!.pos).toBe(1440)
  })

  it('cm ticks: 567-twip steps, 1-based labels (A4 = 20 full cm; 567×21 = 11907 overflows 11906)', () => {
    const ticks = rulerTicks(11906, 'cm')
    expect(ticks).toHaveLength(20)
    expect(ticks[0]).toEqual({ pos: 567, label: 1 })
    expect(ticks[19]).toEqual({ pos: 567 * 20, label: 20 })
  })

  it('twipsToUnitText formats per unit (inch two decimals + double-prime, cm one decimal)', () => {
    expect(twipsToUnitText(720, 'inch')).toBe('0.50"')
    expect(twipsToUnitText(1440, 'inch')).toBe('1.00"')
    expect(twipsToUnitText(567, 'cm')).toBe('1.0 cm')
    expect(twipsToUnitText(2835, 'cm')).toBe('5.0 cm')
  })

  it('drag deltas snap per unit (1pt in inch mode, ~0.5mm in cm mode)', () => {
    expect(dragDeltaToTwips(96, 'inch')).toBe(1440) // 1in of drag
    expect(dragDeltaToTwips(8, 'inch')).toBe(120) // 8px = 120tw = 6pt, snapped to 1pt
    expect(dragDeltaToTwips(56.7, 'cm')).toBe(855) // 1cm of drag
  })

  it('VRuler exists, mounts beside the page, and writes through the undoable layout path', () => {
    expect(fs.existsSync('src/renderer/src/components/word/components/VRuler.tsx')).toBe(true)
    const app = fs.readFileSync('src/renderer/src/components/word/App.tsx', 'utf8')
    expect(app).toContain('<VRuler')
    // margins route through ribbonActions.onSection (unified layout-undo mirror)
    expect(app).toMatch(/VRuler[\s\S]{0,400}ribbonActions\.onSection/)
    const ruler = fs.readFileSync('src/renderer/src/components/word/components/Ruler.tsx', 'utf8')
    // unit persisted and ticks unit-driven
    expect(ruler).toContain("localStorage.getItem('nexus.ruler.unit')")
    expect(ruler).toContain('rulerTicks(section.pageWidth, unit)')
    const css = fs.readFileSync('src/renderer/src/components/word/styles.css', 'utf8')
    expect(css).toContain('.vruler')
    expect(css).toContain('.ruler-unit-toggle')
  })
})
