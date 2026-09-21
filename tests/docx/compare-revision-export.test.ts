import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { generateParagraphXml, parseDocx, saveDocx } from '../../src/packages/docx-engine/index'
import { buildDocx } from './helpers/build-docx'
import { buildCompareFinalBlocks, diffWords, tokenizeText } from '../../src/renderer/src/components/word/editor/compare-docx'

const CTX = { headingStyleIds: new Map(), allocateHyperlinkRel: () => 'rId9' }

const A_BODY =
  '<w:p><w:r><w:t>第一章 项目背景</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>unchanged paragraph keeps original bytes</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>本章小结：内容将被改写</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>这一段将被整体删除</w:t></w:r></w:p>'

const B_BODY =
  '<w:p><w:r><w:t>第一章 研究背景</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>unchanged paragraph keeps original bytes</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>本章小结：内容已经完全重写并扩充</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>新增的完整段落 insertion paragraph</w:t></w:r></w:p>'

async function documentXmlOf(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  return zip.file('word/document.xml')!.async('string')
}

describe('word-level compare export with tracked changes (MS Word P1)', () => {
  it('tokenizes CJK per character and latin per word', () => {
    expect(tokenizeText('中文 abc12 测试')).toEqual(['中', '文', ' ', 'abc12', ' ', '测', '试'])
  })

  it('diffWords marks deletions and insertions and merges runs', () => {
    const segs = diffWords('本章小结：内容将被改写', '本章小结：内容已经完全重写')
    expect(segs.some((s) => s.type === 'equal' && s.text.includes('本章小结'))).toBe(true)
    const del = segs.find((s) => s.type === 'del')
    const ins = segs.find((s) => s.type === 'ins')
    expect(del?.text).toContain('将被改')
    expect(ins?.text).toContain('已经完全重')
    // no fragmented one-char segments of the same type
    expect(segs.filter((s) => s.type === 'del').length).toBeLessThanOrEqual(2)
  })

  it('exports a merged DOCX with w:ins / w:del / w:delText that Word can review', async () => {
    const parsedA = await parseDocx(await buildDocx({ bodyXml: A_BODY }))
    const parsedB = await parseDocx(await buildDocx({ bodyXml: B_BODY }))
    const { finalBlocks } = buildCompareFinalBlocks(parsedA.blocks, parsedB.blocks, {
      author: '对比审查',
      date: '2026-09-20T00:00:00Z',
    })
    const saved = await saveDocx(parsedA, finalBlocks, {})
    const xml = await documentXmlOf(saved)

    // tracked-change wrappers with the compare author
    expect(xml).toContain('<w:ins ')
    expect(xml).toContain('w:author="对比审查"')
    expect(xml).toContain('<w:del ')
    // deleted text lives in w:delText (Word contract)
    expect(xml).toMatch(/<w:delText[^>]*>[^<]*将被改/)
    expect(xml).toMatch(/<w:delText[^>]*>[^<]*这一段将被整体删除/)
    // the fully removed paragraph also carries a paragraph-mark deletion
    // (w:pPr/w:rPr/w:del): accepting all must not leave empty shells
    const removedPara = xml
      .split('</w:p>')
      .find((para) => para.includes('这一段将被整体删除') || para.includes('本章小结：内容将被改写'))
    expect(removedPara).toBeDefined()
    expect(removedPara).toContain('<w:pPr><w:rPr><w:del w:id="')
    expect(removedPara).toContain('w:author="对比审查"')
    // inserted content present as normal w:t inside w:ins
    expect(xml).toMatch(/<w:ins [^>]*>(?:(?!<\/w:ins>).)*新增的完整段落/s)
    // the unchanged paragraph keeps its original bytes verbatim
    expect(xml).toContain('unchanged paragraph keeps original bytes')
  })

  it('merges the paragraph-mark del into an existing mark rPr (CT_PPr: one w:rPr only)', () => {
    // an empty/whitespace paragraph whose mark carries an explicit size makes
    // formatPPrChildren emit its own w:rPr; the del must merge into it
    const xml = generateParagraphXml(
      {
        type: 'paragraph',
        format: { emptyRunSizeHalfPoints: 21 },
        runs: [{ text: '', del: { author: 'A', date: '2026-09-20T00:00:00Z' } }],
        paraMarkDel: { author: 'A', date: '2026-09-20T00:00:00Z' },
      },
      CTX,
    )
    expect((xml.match(/<w:rPr>/g) ?? []).length).toBe(1)
    expect(xml).toMatch(/<w:rPr><w:del w:id="\d+" w:author="A"[^>]*\/><w:sz /)
    expect(xml).toContain('</w:rPr></w:pPr>')
  })

  it('keeps unmatched trailing originals so no content is silently dropped', async () => {
    const parsedA = await parseDocx(await buildDocx({ bodyXml: A_BODY }))
    const parsedB = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>第一章 项目背景</w:t></w:r></w:p>' }),
    )
    const { finalBlocks } = buildCompareFinalBlocks(parsedA.blocks, parsedB.blocks)
    const saved = await saveDocx(parsedA, finalBlocks, {})
    const xml = await documentXmlOf(saved)
    // everything B lacks is a deletion — nothing disappears without a mark
    expect(xml).toContain('这一段将被整体删除')
    expect((xml.match(/<w:del /g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
