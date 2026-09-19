import { describe, it, expect } from 'bun:test'
import { generateRunXml } from '../../src/packages/docx-engine/generate'
import { proseMirrorNodesToRuns } from '../../src/renderer/src/components/word/editor/convert'
import type { Run } from '../../src/packages/docx-engine/types'

describe('Character Scale (w:w / charScalePct) Fidelity Test Suite', () => {
  it('1. generateRunXml serializes charScalePct to <w:w w:val="..."/>', () => {
    const run: Run = {
      text: 'Scaled Text',
      charScalePct: 150,
    }

    const xml = generateRunXml(run)
    expect(xml).toContain('<w:w w:val="150"/>')
  })

  it('2. proseMirrorNodesToRuns converts Mark with charScalePct back to Run.charScalePct', () => {
    const mockNodes = [
      {
        type: 'text',
        text: 'Compressed Text',
        marks: [
          {
            type: 'docTextStyle',
            attrs: {
              charScalePct: 80,
            },
          },
        ],
      },
    ]

    const runs = proseMirrorNodesToRuns(mockNodes as any)
    expect(runs.length).toBe(1)
    expect(runs[0].text).toBe('Compressed Text')
    expect(runs[0].charScalePct).toBe(80)
  })

  it('3. Round-trip: charScalePct persists after convert -> edit -> convert cycle', () => {
    const originalRun: Run = {
      text: 'Title 200%',
      charScalePct: 200,
    }

    // Convert to mock PM mark attrs
    const mockNodes = [
      {
        type: 'text',
        text: originalRun.text,
        marks: [
          {
            type: 'docTextStyle',
            attrs: {
              charScalePct: originalRun.charScalePct,
            },
          },
        ],
      },
    ]

    const restoredRuns = proseMirrorNodesToRuns(mockNodes as any)
    expect(restoredRuns[0].charScalePct).toBe(200)

    const finalXml = generateRunXml(restoredRuns[0])
    expect(finalXml).toContain('<w:w w:val="200"/>')
  })
})
