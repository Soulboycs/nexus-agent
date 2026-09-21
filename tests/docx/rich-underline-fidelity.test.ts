import { describe, it, expect } from 'bun:test'
import { generateRunXml } from '../../src/packages/docx-engine/generate'
import { inlineToRuns } from '../../src/renderer/src/components/word/editor/convert'
import type { Run } from '../../src/packages/docx-engine/types'

describe('Rich Underline Fidelity Test Suite', () => {
  it('1. generateRunXml serializes boolean underline as single', () => {
    const run: Run = {
      text: 'Single Underline',
      underline: true,
    }
    const xml = generateRunXml(run)
    expect(xml).toContain('<w:u w:val="single"/>')
  })

  it('2. generateRunXml serializes rich underline styles and colors', () => {
    const doubleRun: Run = {
      text: 'Double Underline',
      underline: 'double',
    }
    expect(generateRunXml(doubleRun)).toContain('<w:u w:val="double"/>')

    const waveRun: Run = {
      text: 'Wave Red Underline',
      underline: 'wave',
      underlineColor: 'FF0000',
    }
    const waveXml = generateRunXml(waveRun)
    expect(waveXml).toContain('<w:u w:val="wave" w:color="FF0000"/>')

    const dottedRun: Run = {
      text: 'Dotted Underline',
      underline: 'dotted',
      underlineColor: '0000FF',
    }
    const dottedXml = generateRunXml(dottedRun)
    expect(dottedXml).toContain('<w:u w:val="dotted" w:color="0000FF"/>')
  })

  it('3. inlineToRuns maps underline mark attrs (style, color) to Run fields', () => {
    const mockNodes = [
      {
        type: 'text',
        text: 'Wavy Green Text',
        marks: [
          {
            type: 'underline',
            attrs: {
              style: 'wavyDouble',
              color: '00AA00',
            },
          },
        ],
      },
    ]

    const runs = inlineToRuns(mockNodes as any)
    expect(runs.length).toBe(1)
    expect(runs[0].underline).toBe('wavyDouble')
    expect(runs[0].underlineColor).toBe('00AA00')

    const xml = generateRunXml(runs[0])
    expect(xml).toContain('<w:u w:val="wavyDouble" w:color="00AA00"/>')
  })

  it('4. mergeRPrModel preserves raw w:u when identical and rebuilds when edited', () => {
    const { mergeRPrModel } = require('../../src/packages/docx-engine/generate')
    const rawRPr = '<w:rPr><w:u w:val="wave" w:color="FF0000"/></w:rPr>'
    
    // Identical model -> keeps raw xml
    const identicalRun: Run = {
      text: 'Sample',
      underline: 'wave',
      underlineColor: 'FF0000',
    }
    expect(mergeRPrModel(rawRPr, identicalRun, false)).toBe(rawRPr)

    // Changed style -> rebuilds with new style
    const changedRun: Run = {
      text: 'Sample',
      underline: 'dotted',
      underlineColor: 'FF0000',
    }
    const merged = mergeRPrModel(rawRPr, changedRun, false)
    expect(merged).toContain('<w:u w:val="dotted" w:color="FF0000"/>')
  })
})
