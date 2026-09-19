import { describe, expect, it } from 'vitest'
import {
  applySectionSettings,
  parseDocx,
  saveDocx,
  sectionSettingsFromXml,
} from '../../src/packages/docx-engine/index'
import { buildDocx } from './helpers/build-docx'
import fs from 'node:fs'

const SECT = (cols: string) =>
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>${cols}</w:sectPr>`

const originalOrder = (doc: Awaited<ReturnType<typeof parseDocx>>) =>
  doc.blocks.filter((b) => !b.hidden && b.docxIndex !== null).map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

describe('column separator line w:cols w:sep (ROUND2 #22)', () => {
  it('parses w:sep="1" as colSep true, "0" as false, absence as undefined', () => {
    expect(sectionSettingsFromXml(SECT('<w:cols w:num="2" w:sep="1"/>')).colSep).toBe(true)
    expect(sectionSettingsFromXml(SECT('<w:cols w:num="2" w:sep="0"/>')).colSep).toBe(false)
    expect(sectionSettingsFromXml(SECT('<w:cols w:num="2"/>')).colSep).toBeUndefined()
    expect('colSep' in sectionSettingsFromXml(SECT('<w:cols w:num="2"/>'))).toBe(false)
  })

  it('applySectionSettings adds w:sep="1" / removes it; undefined keeps bytes identical', () => {
    const base = SECT('<w:cols w:num="2"/>')
    expect(applySectionSettings(base, { colSep: true })).toContain('w:sep="1"')
    const withSep = SECT('<w:cols w:num="2" w:sep="1"/>')
    expect(applySectionSettings(withSep, { colSep: false })).not.toContain('w:sep')
    // flipping 0 -> 1 on an existing attribute
    expect(applySectionSettings(SECT('<w:cols w:num="2" w:sep="0"/>'), { colSep: true })).toContain(
      'w:sep="1"',
    )
    // untouched when not provided (round-trip safety): settings derived from a
    // sep-less sectPr carry no colSep key, so existing w:sep bytes stay intact
    const passthrough = sectionSettingsFromXml(SECT('<w:cols w:num="2"/>'))
    expect(applySectionSettings(withSep, passthrough)).toBe(withSep)
    // a section without any w:cols element gains one when colSep is requested
    expect(applySectionSettings(SECT(''), { colSep: true })).toContain('w:sep="1"')
  })

  it('round-trips through a real docx file', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml: '<w:p><w:r><w:t>two columns</w:t></w:r></w:p>',
        sectPrExtra: '<w:cols w:num="2" w:space="425" w:sep="1"/>',
      }),
    )
    const saved = await saveDocx(parsed, originalOrder(parsed), {})
    const zip = await import('jszip').then((J) => J.loadAsync(saved))
    const xml = await zip.file('word/document.xml')!.async('string')
    // the saved sectPr keeps the separator flag (paragraph-patch copies sectPr bytes)
    expect(xml).toContain('w:sep="1"')
  })

  it('the canvas column CSS and the HTML export carry the rule line', () => {
    const app = fs.readFileSync('src/renderer/src/components/word/App.tsx', 'utf8')
    expect(app).toMatch(/colSep[\s\S]{0,200}column-rule/)
    const htmlExport = fs.readFileSync('src/renderer/src/components/word/html-export.ts', 'utf8')
    expect(htmlExport).toMatch(/column-rule/)
  })
})
