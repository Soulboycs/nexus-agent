import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

/**
 * E-batch contracts: drop-cap HTML export (#17), the image wrap popover
 * (#26), and the format find & replace wiring (#28). Pure logic for format
 * matching lives in format-find.test.ts; here we pin the integration points.
 */
describe('E batch: drop-cap export / wrap popover / format find wiring', () => {
  it('#17: HTML export re-emits ::first-letter rules and keeps data-drop-cap', () => {
    const src = fs.readFileSync(
      'src/renderer/src/components/word/html-export.ts',
      'utf8',
    )
    // pseudo-element styles cannot be inlined per element: a stylesheet block
    // must carry them verbatim when the document has a drop cap
    expect(src).toContain('DROP_CAP_EXPORT_CSS')
    expect(src).toMatch(/\.has-drop-cap::first-letter\{float:left/)
    expect(src).toMatch(/body\.join\(''\)\.includes\('has-drop-cap'\)/)
    // the margin variant targets the data attribute, so it must survive serialization
    expect(src).toContain("KEEP_DATA_ATTRS = ['data-drop-cap']")
  })

  it('#26: the wrap popover exists, is mounted, and reuses the context menu options', () => {
    expect(fs.existsSync('src/renderer/src/components/word/components/ImageWrapPopover.tsx')).toBe(
      true,
    )
    const pop = fs.readFileSync(
      'src/renderer/src/components/word/components/ImageWrapPopover.tsx',
      'utf8',
    )
    expect(pop).toContain("from './ContextMenu'") // shared WRAP_OPTIONS — one source of truth
    expect(pop).toMatch(/updateAttributes\('docProtected'/) // same write path as the context menu
    const app = fs.readFileSync('src/renderer/src/components/word/App.tsx', 'utf8')
    expect(app).toContain('<ImageWrapPopover')
    const css = fs.readFileSync('src/renderer/src/components/word/styles.css', 'utf8')
    expect(css).toContain('.image-wrap-pop')
  })

  it('#28: FindPanel wires format filtering, format-only replace and restyle-after-replace', () => {
    const src = fs.readFileSync(
      'src/renderer/src/components/word/components/FindPanel.tsx',
      'utf8',
    )
    // find: text matches narrowed by format; empty query = pure format find
    expect(src).toContain('filterRangesByFormat')
    expect(src).toContain('findFormatRanges(editor, findFmt)')
    // replace: format-only path and restyle-after-text-replace both route
    // through the same engine helper (one transaction = one undo step)
    expect(src.match(/applyFormatReplace\(/g)?.length).toBeGreaterThanOrEqual(4)
    const engine = fs.readFileSync(
      'src/renderer/src/components/word/editor/format-find.ts',
      'utf8',
    )
    expect(engine).toContain("tr.setMeta('trackIgnore', true)") // never recorded as revisions
  })
})
