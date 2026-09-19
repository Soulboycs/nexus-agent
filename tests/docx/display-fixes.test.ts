import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

/**
 * Display-layer defects found by the second and third independent review
 * iterations, each pinned so it cannot regress silently.
 */
describe('display-layer fixes from the review iterations', () => {
  const css = fs.readFileSync('src/renderer/src/components/word/styles.css', 'utf8')

  it('find-fmt popover family has real styles (was: zero rules, panel exploded on open)', () => {
    for (const cls of [
      '.find-fmt-pop',
      '.find-fmt-head',
      '.find-fmt-row',
      '.find-fmt-font',
      '.find-fmt-size',
      '.find-fmt-color',
      '.find-fmt-clear',
    ]) {
      expect(css).toContain(cls)
    }
    // the popover must be positioned, not an in-flow child stretching the panel
    expect(css).toMatch(/\.find-fmt-pop\s*\{[^}]*position:\s*absolute/)
    // the three-state B/I toggle needs a visible "exclude" state
    expect(css).toMatch(/\.find-opt\.off\s*\{/)
  })

  it('modal checkbox/radio rows are exempt from the global full-width .modal input rule', () => {
    expect(css).toMatch(/\.modal-radio input,\s*\n?\.modal-check input\s*\{[^}]*width:\s*auto/)
  })

  it('round 3: modal check/radio label layout beats `.modal label` specificity', () => {
    // (0,2,1) qualified selector — a bare-class flex rule was suppressed by
    // `.modal label { display:block }` (0,1,1), leaving zero input-to-text gap
    expect(css).toContain('.modal label.modal-radio')
    expect(css).toContain('.modal label.modal-check')
  })

  it('VRuler uses the horizontal ruler theme variables (dark mode usable)', () => {
    expect(css).not.toContain('--ruler-line')
    expect(css).not.toContain("'--ruler-zone'")
    expect(css).toMatch(/\.vruler-handle\s*\{[^}]*background:\s*var\(--docs-ruler-btn-bg/)
    expect(css).toMatch(/\.vruler-zone\s*\{[^}]*background:\s*var\(--docs-ruler-zone/)
  })

  it('new popovers reference only theme tokens that actually exist', () => {
    expect(css).not.toContain('--rb-panel-bg')
    expect(css).not.toContain('--rb-border')
    expect(css).not.toContain('--rb-hover')
    expect(css).not.toContain('--doc-ins-bg')
    expect(css).not.toContain('--doc-del-bg')
    // tokens.css defines --surface/--border/--hover/--text in light AND dark
    const tokens = fs.readFileSync('src/packages/ui/tokens.css', 'utf8')
    for (const t of ['--surface:', '--border:', '--hover:', '--text:']) {
      expect(tokens).toContain(t)
    }
  })

  it('nine-grid dot classes cover exactly the nine v-h combinations the component emits', () => {
    const combos: string[] = []
    for (const v of ['top', 'center', 'bottom'])
      for (const h of ['left', 'center', 'right']) combos.push(`.nine-${v}-${h}`)
    for (const cls of combos) expect(css).toContain(cls)
    // the stale impossible combos (h = top/left mixups) must stay gone
    expect(css).not.toContain('.nine-top-top')
    expect(css).not.toContain('.nine-center-top')
    expect(css).not.toContain('.nine-bottom-top')
  })

  it('reviewer filter covers format revisions and escapes author names', () => {
    const marks = fs.readFileSync('src/renderer/src/components/word/editor/marks.ts', 'utf8')
    expect(marks).toContain("'data-rpr-author'")
    const app = fs.readFileSync('src/renderer/src/components/word/App.tsx', 'utf8')
    expect(app).toContain('.has-rpr-change${keep}')
  })

  it('round 3: author-name escaping replaces EVERY occurrence (global regex flags)', () => {
    const app = fs.readFileSync('src/renderer/src/components/word/App.tsx', 'utf8')
    const escLine = app.split('\n').find((l) => l.includes('const esc ='))
    expect(escLine).toBeDefined()
    // String-pattern .replace only replaces the first occurrence: two quotes
    // in an author name would invalidate the whole injected rule. Both
    // replaces must use /g-flagged regexes.
    expect(escLine).toContain('/g,')
    expect((escLine.match(/\/g/g) ?? []).length).toBe(2)
    expect(escLine).not.toContain("a.replace('")
  })

  it('round 3: compare export button styled and changed cards highlighted', () => {
    expect(css).toMatch(/\.compare-export\s*\{/)
    expect(css).toMatch(/\.compare-changed\s*\{[^}]*background:/)
  })

  it('format painter locked state is visually distinct', () => {
    expect(css).toMatch(/\.rb-small\.locked\s*\{/)
  })
})
