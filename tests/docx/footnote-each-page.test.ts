import { describe, it, expect } from 'bun:test'
import { resolvePageFootnotes, syncNoteRefSupDisplay } from '../../src/renderer/src/components/word/footnote-pagination'
import type { BlockBox, PageSlice } from '../../src/renderer/src/components/word/pagination-types'
import type { NoteInfo, SectionSettings, SectionInfo, Block } from '../../src/packages/docx-engine/types'

describe('Footnote numRestart="eachPage" TDD Test Suite', () => {
  const mockFootnotes: NoteInfo[] = [
    { id: 'fn1', text: 'First footnote on page 1' },
    { id: 'fn2', text: 'Second footnote on page 1' },
    { id: 'fn3', text: 'First footnote on page 2' },
    { id: 'fn4', text: 'Second footnote on page 2' },
  ]

  const mockSlices: PageSlice[] = [
    { start: 0, end: 1000, section: 0 },
    { start: 1000, end: 2000, section: 0 },
  ]

  const mockDefaultSection: SectionSettings = {
    pageWidth: 11906,
    pageHeight: 16838,
    orientation: 'portrait',
    marginTop: 1440,
    marginRight: 1440,
    marginBottom: 1440,
    marginLeft: 1440,
    pageBorder: false,
    columns: 1,
  }

  // Two blocks on page 1 (Y=100, Y=200), two blocks on page 2 (Y=1100, Y=1200)
  const mockBlocks: BlockBox[] = [
    { top: 100, height: 50, docxIndex: 0 },
    { top: 200, height: 50, docxIndex: 1 },
    { top: 1100, height: 50, docxIndex: 2 },
    { top: 1200, height: 50, docxIndex: 3 },
  ]

  const mockBlockByDocxIndex = new Map<number, Block>([
    [0, { runs: [{ text: 'Para 1', noteRef: { kind: 'footnote', id: 'fn1' } }] }],
    [1, { runs: [{ text: 'Para 2', noteRef: { kind: 'footnote', id: 'fn2' } }] }],
    [2, { runs: [{ text: 'Para 3', noteRef: { kind: 'footnote', id: 'fn3' } }] }],
    [3, { runs: [{ text: 'Para 4', noteRef: { kind: 'footnote', id: 'fn4' } }] }],
  ])

  it('1. Default / continuous: footnotes are numbered sequentially across all pages', () => {
    const pageNotes = resolvePageFootnotes(mockBlocks, mockSlices, mockFootnotes, {
      section: mockDefaultSection,
      docFootnoteProps: { numRestart: 'continuous' },
      blockByDocxIndex: mockBlockByDocxIndex,
    })

    expect(pageNotes.length).toBe(2)
    // Page 0: fn1, fn2
    expect(pageNotes[0].length).toBe(2)
    expect(pageNotes[0][0].id).toBe('fn1')
    expect(pageNotes[0][0].no).toBe(1)
    expect(pageNotes[0][1].id).toBe('fn2')
    expect(pageNotes[0][1].no).toBe(2)

    // Page 1: fn3, fn4 continue as 3, 4
    expect(pageNotes[1].length).toBe(2)
    expect(pageNotes[1][0].id).toBe('fn3')
    expect(pageNotes[1][0].no).toBe(3)
    expect(pageNotes[1][1].id).toBe('fn4')
    expect(pageNotes[1][1].no).toBe(4)
  })

  it('2. eachPage restart: footnotes reset to 1 at the start of each page', () => {
    const pageNotes = resolvePageFootnotes(mockBlocks, mockSlices, mockFootnotes, {
      section: mockDefaultSection,
      docFootnoteProps: { numRestart: 'eachPage' },
      blockByDocxIndex: mockBlockByDocxIndex,
    })

    expect(pageNotes.length).toBe(2)
    // Page 0: fn1, fn2 -> numbered 1, 2
    expect(pageNotes[0].length).toBe(2)
    expect(pageNotes[0][0].id).toBe('fn1')
    expect(pageNotes[0][0].no).toBe(1)
    expect(pageNotes[0][1].id).toBe('fn2')
    expect(pageNotes[0][1].no).toBe(2)

    // Page 1: fn3, fn4 -> restarted per page: 1, 2!
    expect(pageNotes[1].length).toBe(2)
    expect(pageNotes[1][0].id).toBe('fn3')
    expect(pageNotes[1][0].no).toBe(1)
    expect(pageNotes[1][1].id).toBe('fn4')
    expect(pageNotes[1][1].no).toBe(2)
  })

  it('3. eachPage with custom numStart: footnotes reset to numStart on each page', () => {
    const pageNotes = resolvePageFootnotes(mockBlocks, mockSlices, mockFootnotes, {
      section: mockDefaultSection,
      docFootnoteProps: { numRestart: 'eachPage', numStart: 5 },
      blockByDocxIndex: mockBlockByDocxIndex,
    })

    expect(pageNotes.length).toBe(2)
    // Page 0: 5, 6
    expect(pageNotes[0][0].no).toBe(5)
    expect(pageNotes[0][1].no).toBe(6)

    // Page 1: 5, 6
    expect(pageNotes[1][0].no).toBe(5)
    expect(pageNotes[1][1].no).toBe(6)
  })

  it('4. Per-section override: section 0 is continuous, section 1 is eachPage', () => {
    const multiSections: SectionInfo[] = [
      {
        settings: {
          ...mockDefaultSection,
          footnotePr: { numRestart: 'continuous' },
        },
      },
      {
        settings: {
          ...mockDefaultSection,
          footnotePr: { numRestart: 'eachPage', numStart: 1 },
        },
      },
    ]

    const customSlices: PageSlice[] = [
      { start: 0, end: 1000, section: 0 },
      { start: 1000, end: 2000, section: 1 },
    ]

    const pageNotes = resolvePageFootnotes(mockBlocks, customSlices, mockFootnotes, {
      section: mockDefaultSection,
      sections: multiSections,
      blockByDocxIndex: mockBlockByDocxIndex,
    })

    expect(pageNotes[0][0].no).toBe(1)
    expect(pageNotes[0][1].no).toBe(2)

    // Page 1 is in Section 1 (eachPage) -> restarts from 1
    expect(pageNotes[1][0].no).toBe(1)
    expect(pageNotes[1][1].no).toBe(2)
  })

  it('5. syncNoteRefSupDisplay updates body sup DOM elements with page-relative footnote numbers', () => {
    // Create a mock DOM element container with persistent element references
    const elements = [
      { dataset: { noteRef: 'fn1' }, textContent: '1' },
      { dataset: { noteRef: 'fn2' }, textContent: '2' },
      { dataset: { noteRef: 'fn3' }, textContent: '3' },
      { dataset: { noteRef: 'fn4' }, textContent: '4' },
    ]
    const container = {
      querySelectorAll: (_sel: string) => elements,
    } as any

    const pageNotes = [
      [
        { id: 'fn1', no: 1, text: '', height: 20 },
        { id: 'fn2', no: 2, text: '', height: 20 },
      ],
      [
        { id: 'fn3', no: 1, text: '', height: 20 }, // page 2 restarted
        { id: 'fn4', no: 2, text: '', height: 20 }, // page 2 restarted
      ],
    ]

    syncNoteRefSupDisplay(container, pageNotes)

    const sups = container.querySelectorAll()
    expect(sups[2].textContent).toBe('1')
    expect(sups[2].dataset.pageNoteNo).toBe('1')

    expect(sups[3].textContent).toBe('2')
    expect(sups[3].dataset.pageNoteNo).toBe('2')
  })
})
