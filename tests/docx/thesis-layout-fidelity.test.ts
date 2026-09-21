import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.HTMLElement = win.HTMLElement as any

import { effectiveHfRefs } from '../../src/renderer/src/components/word/pagination-hf'
import { hfParaIndentStyle } from '../../src/renderer/src/components/word/editor/hf-dom'
import { expandAutofitColWidths } from '../../src/renderer/src/components/word/editor/convert'
import { textAlignDecl } from '../../src/renderer/src/components/word/editor/text-effects'
import { renderFieldSpec } from '../../src/renderer/src/components/word/editor/protected-render'
import type { SectionInfo, TableModel } from '../../src/packages/docx-engine/types'

describe('Thesis Layout Fidelity & Word Compatibility Test Suite', () => {
  it('1. Section header inheritance prevents inheriting empty first header without titlePg', () => {
    const sections: SectionInfo[] = [
      {
        settings: {} as any,
        startType: 'nextPage',
        firstBlockIndex: 0,
        lastBlockIndex: 81,
        sectPrXml: '',
        titlePg: false,
        headerRefs: { first: 'rId7', default: 'rId5', even: 'rId6' },
        footerRefs: { first: 'rId10', default: 'rId8', even: 'rId9' },
      },
      {
        settings: {} as any,
        startType: 'nextPage',
        firstBlockIndex: 82,
        lastBlockIndex: 190,
        sectPrXml: '',
        titlePg: false,
        headerRefs: { default: 'rId11' },
        footerRefs: { default: 'rId12' },
      },
    ]

    const eff = effectiveHfRefs(sections)
    expect(eff).toHaveLength(2)
    // Section 0 keeps its declared refs
    expect(eff[0].header.first).toBe('rId7')
    expect(eff[0].header.default).toBe('rId5')

    // Section 1 defines default: rId11 and has no titlePg -> must NOT inherit first: rId7!
    expect(eff[1].header.default).toBe('rId11')
    expect(eff[1].header.first).toBeUndefined()
    expect(eff[1].footer.default).toBe('rId12')
    expect(eff[1].footer.first).toBeUndefined()
  })

  it('2. Zero indent in header/footer explicitly emits textIndent: 0.0px', () => {
    const style = hfParaIndentStyle({
      indentFirstLine: 0,
      indentLeft: 0,
      indentRight: 0,
      runs: [{ text: 'X' }],
    })
    // Must explicitly set textIndent: '0.0px' to prevent inheriting paragraph style's 10pt indent
    expect(style.textIndent).toBe('0.0px')
    expect(style.marginInlineStart).toBe('0.0px')
    expect(style.marginInlineEnd).toBe('0.0px')
  })

  it('3. Distributed alignment includes word-break: keep-all', () => {
    const css = textAlignDecl('distribute')
    expect(css).toContain('text-justify:distribute')
    expect(css).toContain('word-break:keep-all')
  })

  it('4. Autofit window table expands column widths to target', () => {
    const model: TableModel = {
      rows: [[{ paras: ['A'] }, { paras: ['Three-dimensional (三维)'] }]],
      colWidthsTwips: [1950, 1455], // Total 3405 twips
      autoFit: 'window',
      autoLayout: true,
    }
    const targetTwips = 8731 // A4 text column
    const expanded = expandAutofitColWidths(model, targetTwips, targetTwips, null)

    expect(expanded.colWidthsTwips).toBeDefined()
    const sum = expanded.colWidthsTwips!.reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThanOrEqual(targetTwips - 5)
    expect(sum).toBeLessThanOrEqual(targetTwips + 5)
    // Column 2 must have received significant expansion
    expect(expanded.colWidthsTwips![1]).toBeGreaterThan(3000)
  })

  it('5. Long TOC title splits into multi-line entry with dots on line 2', () => {
    const longTitle = '2.  经皮腔内肺动脉成形术治疗肺高血压经皮腔内肺动脉成形术治疗肺高血压'
    const spec = renderFieldSpec({
      kind: 'tocLine',
      level: 1,
      left: longTitle,
      right: '51',
      leader: 'dot',
      anchor: '_Toc123',
    })

    expect(spec).toBeDefined()
    expect(Array.isArray(spec)).toBe(true)
    // Should be wrapped in doc-toc-multiline
    const [tag, attrs, ...children] = spec as [string, Record<string, any>, ...any[]]
    expect(tag).toBe('div')
    expect(attrs.class).toBe('doc-toc-multiline')
    expect(children).toHaveLength(2)

    // Line 1: lead title without dots or page
    const line1 = children[0] as [string, Record<string, any>, ...any[]]
    expect(line1[1].class).toContain('doc-toc-line-lead')
    expect(line1[1]['data-toc-anchor']).toBe('_Toc123')

    // Line 2: hanging indent title + dots + page
    const line2 = children[1] as [string, Record<string, any>, ...any[]]
    expect(line2[1].class).toContain('doc-toc-line')
    expect(line2[1]['data-toc-anchor']).toBe('_Toc123')
    // Line 2 contains dots and page
    const hasDots = line2.some((c: any) => Array.isArray(c) && c[1]?.class?.includes('doc-toc-dots'))
    const hasPage = line2.some((c: any) => Array.isArray(c) && c[1]?.class?.includes('doc-toc-page') && c[2] === '51')
    expect(hasDots).toBe(true)
    expect(hasPage).toBe(true)
  })

  it('6. Standard short TOC title remains single line', () => {
    const shortTitle = '1.1 引言'
    const spec = renderFieldSpec({
      kind: 'tocLine',
      level: 2,
      left: shortTitle,
      right: '5',
      leader: 'dot',
    })

    expect(spec).toBeDefined()
    const [tag, attrs] = spec as [string, Record<string, any>, ...any[]]
    expect(tag).toBe('div')
    expect(attrs.class).toContain('doc-toc-line')
    expect(attrs.class).not.toContain('doc-toc-multiline')
  })

  it('7. Table hover and sectbreak node selection suppress spurious horizontal lines', () => {
    const fs = require('fs')
    const css = fs.readFileSync('src/renderer/src/components/word/styles.css', 'utf8')
    // Table hover must have transparent border to avoid dashed horizontal line above table
    expect(css).toMatch(/\.doc-protected\[data-doc-protected='table'\]:hover\s*\{\s*border-color:\s*transparent;/)
    // Sectbreak selected node must have border: none !important
    expect(css).toMatch(/\.ProseMirror-focused \.doc-protected-sectbreak\.ProseMirror-selectednode[^{]*\{\s*border:\s*none !important;/)
  })

  it('8. Page-gap header/footer allows user-select and double-click inline editing', () => {
    const fs = require('fs')
    const css = fs.readFileSync('src/renderer/src/components/word/styles.css', 'utf8')
    // Must allow text selection on headers inside page gaps
    expect(css).toContain('.page-gap .page-hf')
    expect(css).toContain('user-select: text !important;')

    // Must allow double click editing via makeGapHfEl
    const { makeGapHfEl } = require('../../src/renderer/src/components/word/editor/hf-dom')
    let committed: any = null
    const el = makeGapHfEl({
      kind: 'header',
      value: { text: '华中科技大学博士学位论文' },
      pageNo: 2,
      pageTotal: 100,
      readOnly: false,
      onCommit: (next: any) => {
        committed = next
      },
    })
    expect(el.classList.contains('page-gap-hf')).toBe(true)
    // Dispatch dblclick
    el.dispatchEvent(new Event('dblclick'))
    expect(el.classList.contains('page-hf-editing')).toBe(true)
    const surface = el.querySelector('.page-hf-edit-surface') as HTMLElement
    expect(surface).toBeDefined()
    expect(surface.innerText).toContain('华中科技大学博士学位论文')
  })
})
