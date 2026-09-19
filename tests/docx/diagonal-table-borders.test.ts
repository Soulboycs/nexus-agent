import { describe, it, expect } from 'bun:test'
import { generateTableModelXml, type TableModel } from '../../src/packages/docx-engine/index'
import { mergedBorderLinesOf } from '../../src/packages/docx-engine/parse-props'
import { xmlParser } from '../../src/packages/docx-engine/xml-utils'

describe('Diagonal Table Borders (tl2br & tr2bl) TDD Test Suite', () => {
  it('1. mergedBorderLinesOf parses w:tl2br and w:tr2bl from w:tcBorders node', () => {
    const tcPrXml = `<w:tcPr>
      <w:tcBorders>
        <w:top w:val="single" w:sz="4" w:color="auto"/>
        <w:left w:val="single" w:sz="4" w:color="auto"/>
        <w:bottom w:val="single" w:sz="4" w:color="auto"/>
        <w:right w:val="single" w:sz="4" w:color="auto"/>
        <w:tl2br w:val="single" w:sz="8" w:color="FF0000"/>
        <w:tr2bl w:val="double" w:sz="12" w:color="0000FF"/>
      </w:tcBorders>
    </w:tcPr>`

    const parsedNodes = xmlParser.parse(tcPrXml)
    const tcPrNode = parsedNodes[0]
    const borders = mergedBorderLinesOf(tcPrNode, 'w:tcBorders', false)

    expect(borders).toBeDefined()
    expect(borders?.top).toBeDefined()
    expect(borders?.tl2br).toBeDefined()
    expect(borders?.tl2br?.style).toBe('single')
    expect(borders?.tl2br?.szEighths).toBe(8)
    expect(borders?.tl2br?.color).toBe('FF0000')

    expect(borders?.tr2bl).toBeDefined()
    expect(borders?.tr2bl?.style).toBe('double')
    expect(borders?.tr2bl?.szEighths).toBe(12)
    expect(borders?.tr2bl?.color).toBe('0000FF')
  })

  it('2. generateTableModelXml serializes tl2br and tr2bl back into w:tcBorders in OOXML', () => {
    const model: TableModel = {
      colWidths: [3000, 3000],
      rows: [
        [
          {
            paras: ['项目\\日期'],
            borders: {
              top: { style: 'single', szEighths: 4 },
              bottom: { style: 'single', szEighths: 4 },
              tl2br: { style: 'single', szEighths: 8, color: '000000' }
            }
          },
          {
            paras: ['2026年9月'],
          }
        ]
      ]
    }

    const xml = generateTableModelXml(model)
    expect(xml).toContain('<w:tcBorders>')
    expect(xml).toContain('<w:tl2br w:val="single"')
    expect(xml).toContain('w:sz="8"')
  })
})
