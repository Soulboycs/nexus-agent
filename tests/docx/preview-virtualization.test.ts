import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Print-preview virtualization (B5): .pv-page cards are fixed-height clones
 * (inline width/height + --pv-page-h), so content-visibility:auto lets the
 * browser skip offscreen paint/layout without moving the scrollbar, and the
 * @media print override keeps PDF export rendering every page.
 */
describe('pagination preview virtualization (content-visibility)', () => {
  const css = fs.readFileSync(
    path.resolve('src/renderer/src/components/word/styles.css'),
    'utf8',
  )

  it('.pv-page skips offscreen rendering with an exact intrinsic height', () => {
    const rule = /\.pv-page\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toMatch(/content-visibility:\s*auto/)
    expect(rule).toMatch(/contain-intrinsic-size:\s*auto\s+var\(--pv-page-h/)
  })

  it('print forces every page back into full rendering (PDF export safety)', () => {
    expect(css).toMatch(/@media print\s*\{[^@]*?\.pv-page\s*\{[^}]*content-visibility:\s*visible/)
  })

  it('the page card actually carries the --pv-page-h variable', () => {
    const preview = fs.readFileSync(
      path.resolve('src/renderer/src/components/word/components/PaginationPreview.tsx'),
      'utf8',
    )
    expect(preview).toContain("'--pv-page-h': `${pageH}px`")
    expect(preview).toMatch(/height: pageH,/)
  })
})
