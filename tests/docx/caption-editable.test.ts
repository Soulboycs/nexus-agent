import { describe, it, expect } from 'vitest'
import { inlineToRuns } from '../../src/renderer/src/components/word/editor/convert'
import { runFragmentXml } from '../../src/packages/docx-engine/index'

describe('Caption Editable and OOXML Field Suite', () => {
  it('1. caption inline content correctly parses to runs with instrField and editable text', () => {
    const styleMark = {
      type: 'docTextStyle',
      attrs: { color: '44546A', sizeHalfPoints: 18 },
    }
    const mockNodes = [
      {
        type: 'text',
        text: '图 ',
        marks: [styleMark],
      },
      {
        type: 'text',
        text: '1',
        marks: [
          styleMark,
          {
            type: 'instrField',
            attrs: {
              instr: 'SEQ 图 \\* ARABIC',
              dirty: true,
            },
          },
        ],
      },
      {
        type: 'text',
        text: '：系统总体架构图',
        marks: [styleMark],
      },
    ]

    const runs = inlineToRuns(mockNodes as any)
    expect(runs.length).toBe(3)
    expect(runs[0].text).toBe('图 ')
    expect(runs[1].text).toBe('1')
    expect(runs[1].instrField).toBe('SEQ 图 \\* ARABIC')
    expect(runs[1].fldDirty).toBe(true)
    expect(runs[2].text).toBe('：系统总体架构图')

    // Run 1 XML
    const xml1 = runFragmentXml(runs[1])
    expect(xml1).toContain('<w:fldChar w:fldCharType="begin" w:dirty="true"/>')
    expect(xml1).toContain('SEQ 图 \\* ARABIC')
    expect(xml1).toContain('<w:fldChar w:fldCharType="end"/>')
  })
})
