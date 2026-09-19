import JSZip from 'jszip'
import { afterAll, describe, expect, it } from 'vitest'
import {
  parseDocx,
  saveDocx,
  STYLEREF_MARK,
  type ParsedDocFull,
  type SaveBlock,
} from '../../src/packages/docx-engine/index'
import { buildDocx } from './helpers/build-docx'
import { stylerefText } from '../../src/renderer/src/components/word/editor/styleref'
import {
  STYLE_TOKEN,
  applyHfText,
  hfEditText,
} from '../../src/renderer/src/components/word/editor/hf-text'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const W_R_NS =
  W_NS +
  ' ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** header part whose only paragraph is a STYLEREF field with a stale cached result */
const HDR_STYLEREF_SPAN =
  XML_DECL +
  `<w:hdr ${W_R_NS}>` +
  '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> STYLEREF "Heading 1" \\* MERGEFORMAT </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>Old Chapter Title</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '</w:p></w:hdr>'

/** fldSimple single-element form, unquoted style name with a switch */
const HDR_STYLEREF_SIMPLE =
  XML_DECL +
  `<w:hdr ${W_NS}>` +
  '<w:p>' +
  '<w:fldSimple w:instr=" STYLEREF Heading 2 \\* ARABIC ">' +
  '<w:r><w:t>Stale H2</w:t></w:r>' +
  '</w:fldSimple>' +
  '</w:p></w:hdr>'

function docxFixture(headerXml: string) {
  return buildDocx({
    bodyXml: '<w:p><w:r><w:t>body</w:t></w:r></w:p>',
    sectPrExtra: '<w:headerReference w:type="default" r:id="rIdH1"/>',
    extraRels:
      '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: headerXml,
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
      },
    ],
  })
}

const originalOrder = (doc: ParsedDocFull): SaveBlock[] =>
  doc.blocks
    .filter((b) => !b.hidden && b.docxIndex !== null)
    .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

async function headerXmlOf(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const name = Object.keys(zip.files).find((n) => /^word\/header\d*\.xml$/.test(n))!
  return zip.file(name)!.async('string')
}

// the happy-dom globals set by the makeGapHfEl test leak into later test files
// in the same bun process (they run alphabetically in one runtime) — restore
// whatever was there before this file ran
const prevWindow = (globalThis as Record<string, unknown>).window
const prevDocument = (globalThis as Record<string, unknown>).document
afterAll(() => {
  ;(globalThis as Record<string, unknown>).window = prevWindow
  ;(globalThis as Record<string, unknown>).document = prevDocument
})

describe('STYLEREF dynamic header (MS Word P1 alignment)', () => {
  it('parses a fldChar STYLEREF span into the marker, records the style, drops the stale cache', async () => {
    const doc = await parseDocx(await docxFixture(HDR_STYLEREF_SPAN))
    const part = Object.values(doc.hfParts)[0]!
    expect(part.text).toContain(STYLEREF_MARK)
    expect(part.styleRefs).toEqual(['Heading 1'])
    // the stale cached result must not survive into display text
    expect(part.text).not.toContain('Old Chapter Title')
    expect(
      part.paras.some((p) => p.runs.some((r) => r.text.includes(STYLEREF_MARK))),
    ).toBe(true)
  })

  it('parses the fldSimple form with an unquoted style name', async () => {
    const doc = await parseDocx(await docxFixture(HDR_STYLEREF_SIMPLE))
    const part = Object.values(doc.hfParts)[0]!
    expect(part.styleRefs).toEqual(['Heading 2'])
    expect(part.text).toContain(STYLEREF_MARK)
    expect(part.text).not.toContain('Stale H2')
  })

  it('saves a header value back as a complete STYLEREF field span', async () => {
    const doc = await parseDocx(await docxFixture(HDR_STYLEREF_SPAN))
    const saved = await saveDocx(doc, originalOrder(doc), {
      header: {
        text: `Chapter: ${STYLEREF_MARK}`,
        styleRefs: ['Heading 1'],
        paras: [{ align: 'center', runs: [{ text: `Chapter: ${STYLEREF_MARK}` }] }],
      },
    })
    const xml = await headerXmlOf(saved)
    expect(xml).toContain(' STYLEREF "Heading 1" ')
    expect(xml).toContain('<w:fldChar w:fldCharType="begin"/>')
    expect(xml).toContain('<w:fldChar w:fldCharType="separate"/>')
    expect(xml).toContain('<w:fldChar w:fldCharType="end"/>')
    // the marker itself must never leak into saved OOXML
    expect(xml).not.toContain(STYLEREF_MARK)
  })

  it('resolves Word semantics for any style name: page-first, closest before, first after', () => {
    const entries = [
      { styleName: 'heading 1', text: 'Chapter One', page: 1 },
      { styleName: '标题 1', text: '第二章 中文标题', page: 5 },
      { styleName: 'heading 1', text: 'Chapter Three', page: 9 },
      { styleName: 'Title', text: 'The Document Title', page: 1 },
      { styleName: 'My Custom Style', text: 'Custom Para', page: 6 },
    ]
    // page carries the first occurrence of that style on the page
    expect(stylerefText(entries, 'Heading 1', 5)).toBe('第二章 中文标题')
    // 标题/heading aliases are the same style, case/space-insensitive
    expect(stylerefText(entries, 'HEADING 1', 7)).toBe('第二章 中文标题')
    expect(stylerefText(entries, '标题 1', 2)).toBe('Chapter One')
    // any non-heading style resolves by its own name
    expect(stylerefText(entries, 'Title', 3)).toBe('The Document Title')
    expect(stylerefText(entries, 'my custom STYLE', 6)).toBe('Custom Para')
    // unknown style names render blank, never the marker or an error string
    expect(stylerefText(entries, 'No Such Style', 6)).toBe('')
    expect(stylerefText(entries, 'Heading 1', 99)).toBe('Chapter Three')
    expect(stylerefText(entries, 'Heading 1', 1)).toBe('Chapter One')
  })

  it('round-trips the marker through the plain-text header editing surface', () => {
    const value = {
      text: `Chapter: ${STYLEREF_MARK}`,
      styleRefs: ['Heading 1'],
      paras: [{ align: 'center' as const, runs: [{ text: `Chapter: ${STYLEREF_MARK}` }] }],
    }
    const editable = hfEditText(value)
    expect(editable).toBe(`Chapter: ${STYLE_TOKEN}`)
    const restored = applyHfText(value, editable)
    expect(restored.text).toContain(STYLEREF_MARK)
    expect(restored.styleRefs).toEqual(['Heading 1'])
  })

  it('makeGapHfEl substitutes the marker with the live heading text of the strip page', async () => {
    const { Window } = await import('happy-dom')
    const win = new Window()
    ;(globalThis as Record<string, unknown>).window = win
    ;(globalThis as Record<string, unknown>).document = win.document
    ;(globalThis as Record<string, unknown>).CustomEvent = win.CustomEvent
    ;(globalThis as Record<string, unknown>).Event = win.Event
    const { makeGapHfEl } = await import(
      '../../src/renderer/src/components/word/editor/hf-dom'
    )
    const el = makeGapHfEl({
      kind: 'header',
      value: {
        text: `Chapter: ${STYLEREF_MARK}`,
        styleRefs: ['Heading 1'],
        paras: [{ align: 'center' as const, runs: [{ text: `Chapter: ${STYLEREF_MARK}` }] }],
      },
      pageNo: '3',
      pageNoNum: 3,
      pageTotal: 9,
      resolveStyleRef: (name, page) =>
        name === 'Heading 1' && page === 3 ? 'Chapter Two' : 'OTHER',
    })
    const text = el.textContent ?? ''
    expect(text).toContain('Chapter: Chapter Two')
    expect(text).not.toContain(STYLEREF_MARK)
  })
})
