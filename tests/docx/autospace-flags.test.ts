import { describe, expect, it } from 'vitest'
import {
  generateParagraphXml,
  parseDocx,
  type GenerateContext,
} from '../../src/packages/docx-engine/index'
import { autoSpaceOf } from '../../src/packages/docx-engine/parse-props'
import { buildDocx } from './helpers/build-docx'
import { autospaceBoundaries, needsAutospacePad } from '../../src/renderer/src/components/word/line-metrics'

const CTX: GenerateContext = { headingStyleIds: new Map(), allocateHyperlinkRel: () => 'rId9' }

const pPr = (xml: string) => ({
  name: 'w:pPr',
  attrs: {},
  children: [{ name: 'w:autoSpaceDN', attrs: { 'w:val': xml }, children: [] }],
}) as never

describe('autoSpaceDE/DN independent switches (ROUND2 #16)', () => {
  it('parses DN-only-off without flattening it away', () => {
    const docx = buildDocx({
      bodyXml:
        '<w:p><w:pPr><w:autoSpaceDN w:val="0"/></w:pPr><w:r><w:t>中文 100 混排</w:t></w:r></w:p>',
    }).then((b) => parseDocx(b))
    return docx.then((doc) => {
      const fmt = doc.blocks[0].format
      expect(fmt?.autoSpaceDN).toBe(false)
      expect(fmt?.autoSpaceDE).toBeUndefined()
    })
  })

  it('parses both-off as two explicit false flags', async () => {
    const off = `<w:p><w:pPr><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: off }))
    expect(doc.blocks[0].format?.autoSpaceDE).toBe(false)
    expect(doc.blocks[0].format?.autoSpaceDN).toBe(false)
  })

  it('autoSpaceOf returns independent values and undefined when neither is declared', () => {
    // XNode shape: the element name is the object key, children its array value
    const declared = { 'w:pPr': [{ 'w:autoSpaceDN': [{}] }] } as never
    expect(autoSpaceOf(declared)).toEqual({ autoSpaceDN: true })
    const both = { 'w:pPr': [{ 'w:autoSpaceDE': [{}], ':@': { 'w:val': '0' } }, { 'w:autoSpaceDN': [{}] }] } as never
    expect(autoSpaceOf(both)).toEqual({ autoSpaceDE: false, autoSpaceDN: true })
    expect(autoSpaceOf({ 'w:pPr': [] } as never)).toBeUndefined()
  })

  it('serializes only explicitly-off flags; on/default stays byte-clean', () => {
    const xml = generateParagraphXml(
      {
        type: 'paragraph',
        format: { autoSpaceDE: true, autoSpaceDN: false },
        runs: [{ text: '混排 123' }],
      },
      CTX,
    )
    expect(xml).toContain('<w:autoSpaceDN w:val="0"/>')
    expect(xml).not.toContain('w:autoSpaceDE')
  })

  it('autospace boundaries respect the flags', () => {
    // 中文ab1中文 — boundaries: 文↔a (DE, offset 2), 1↔中 (DN, offset 5).
    // latin-letter↔digit (no CJK side) is never a boundary.
    expect(autospaceBoundaries('中文ab1中文')).toEqual([2, 5])
    // DN off: the digit↔CJK boundary disappears, the letter one stays
    expect(autospaceBoundaries('中文ab1中文', { dn: false })).toEqual([2])
    // DE off: only the digit boundary survives
    expect(autospaceBoundaries('中文ab1中文', { de: false })).toEqual([5])
    // both off: none
    expect(autospaceBoundaries('中文ab1中文', { de: false, dn: false })).toEqual([])
    // pointwise predicate agrees
    expect(needsAutospacePad('1'.codePointAt(0)!, '中'.codePointAt(0)!, { dn: false })).toBe(false)
    expect(needsAutospacePad('中'.codePointAt(0)!, '1'.codePointAt(0)!, { dn: false })).toBe(false)
    expect(needsAutospacePad('中'.codePointAt(0)!, 'a'.codePointAt(0)!, { dn: false })).toBe(true)
    expect(needsAutospacePad('中'.codePointAt(0)!, 'a'.codePointAt(0)!)).toBe(true)
  })
})
