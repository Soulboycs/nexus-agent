import type {
  NoteInfo,
  SectionSettings,
  SectionInfo,
  Block,
  NoteProps,
  NoteKind,
} from '@genoffice/docx-engine'
import type { BlockBox, PageSlice, PageNoteItem } from './pagination-types'
import { pageAt } from './pagination-slices'
import { noteMarkText } from './note-format'

/** Scans all runs where note references may appear: paragraph runs, table cells and nested tables */
export function blockNoteScanRuns(b: Block): NonNullable<Block['runs']> {
  const out: NonNullable<Block['runs']> = []
  if (b.runs) out.push(...b.runs)
  const walkTable = (table: NonNullable<Block['table']> | undefined): void => {
    for (const row of table?.rows ?? []) {
      for (const cell of row) {
        for (const p of cell.richParas ?? []) out.push(...p.runs)
        for (const nested of cell.nestedTables ?? []) walkTable(nested)
      }
    }
  }
  if (b.table) walkTable(b.table)
  return out
}

export interface ResolvePageFootnotesOptions {
  section?: SectionSettings
  sections?: SectionInfo[]
  docFootnoteProps?: NoteProps
  blockByDocxIndex?: Map<number, Block>
  noteRenderInfoOf?: (
    fn: NoteInfo | undefined,
    no: number,
    sec: SectionSettings,
    kind: NoteKind,
  ) => { height: number; lineHeightPx?: number; fontSizePt?: number; fontFamily?: string }
  fallbackNoteNo?: (id: string, index: number) => number
}

/**
 * Resolves footnotes to each physical page slice and applies Word-compatible
 * numbering rules, including `numRestart="eachPage"` per-page numbering restarts.
 */
export function resolvePageFootnotes(
  blocks: BlockBox[],
  slices: PageSlice[],
  footnotes: NoteInfo[],
  options: ResolvePageFootnotesOptions,
): PageNoteItem[][] {
  const out: PageNoteItem[][] = slices.map(() => [])
  if (slices.length === 0 || footnotes.length === 0 || !options.section) {
    return out
  }

  const {
    section,
    sections = [],
    docFootnoteProps,
    blockByDocxIndex = new Map(),
    noteRenderInfoOf,
    fallbackNoteNo,
  } = options

  const defaultNoOf = new Map(
    footnotes.map((f, i) => [f.id, fallbackNoteNo ? fallbackNoteNo(f.id, i) : i + 1]),
  )

  for (const b of blocks) {
    if (b.docxIndex === undefined) continue
    const pb = blockByDocxIndex.get(b.docxIndex)
    if (!pb) continue
    const ids = blockNoteScanRuns(pb)
      .filter((r) => r.noteRef?.kind === 'footnote')
      .map((r) => r.noteRef!.id)
    if (ids.length === 0) continue

    const blockPage = Math.max(0, pageAt(slices, b.top + 0.5) - 1)
    const sec = sections.find((s) => b.docxIndex! <= s.settings.pageWidth)?.settings ?? section

    for (let ri = 0; ri < ids.length; ri++) {
      const id = ids[ri]
      const fn = footnotes.find((f) => f.id === id)
      if (!fn) continue

      const band = b.noteBands?.length === ids.length ? b.noteBands[ri] : undefined
      const page = band
        ? Math.max(0, pageAt(slices, b.top + (b.spaceBeforePx ?? 0) + band.offset + 0.5) - 1)
        : blockPage

      if (page >= slices.length) continue

      const initialNo = defaultNoOf.get(id) ?? ri + 1
      const info = noteRenderInfoOf ? noteRenderInfoOf(fn, initialNo, sec, 'footnote') : undefined

      out[page]?.push({
        no: initialNo,
        id,
        text: fn.text,
        ...(fn.richParas ? { richParas: fn.richParas } : {}),
        ...(fn.noRefMark ? { noRefMark: true as const } : {}),
        height: info?.height ?? 20,
        ...(info?.lineHeightPx ? { lineHeightPx: info.lineHeightPx } : {}),
        ...(info?.fontSizePt ? { fontSizePt: info.fontSizePt } : {}),
        ...(info?.fontFamily ? { fontFamily: info.fontFamily } : {}),
      })
    }
  }

  // Second pass: apply numRestart="eachPage" per-page numbering resets
  for (let p = 0; p < slices.length; p++) {
    const pageItems = out[p]
    if (!pageItems || pageItems.length === 0) continue

    const slice = slices[p]
    const secInfo = sections[slice?.section ?? 0]
    const sec = secInfo?.settings ?? section
    const footnoteProps = sec.footnotePr ?? docFootnoteProps

    if (footnoteProps?.numRestart === 'eachPage') {
      const startNo = footnoteProps.numStart ?? 1
      for (let idx = 0; idx < pageItems.length; idx++) {
        const item = pageItems[idx]
        const assignedNo = startNo + idx
        item.no = assignedNo

        if (noteRenderInfoOf) {
          const fn = footnotes.find((f) => f.id === item.id)
          const info = noteRenderInfoOf(fn, assignedNo, sec, 'footnote')
          item.height = info.height
          if (info.lineHeightPx) item.lineHeightPx = info.lineHeightPx
          if (info.fontSizePt) item.fontSizePt = info.fontSizePt
          if (info.fontFamily) item.fontFamily = info.fontFamily
        }
      }
    }
  }

  return out
}

/**
 * Synchronizes body text superscript note reference markers (<sup class="doc-note-ref">)
 * with the page-calculated note numbers so in-body marks match the page bottom numbering.
 */
export function syncNoteRefSupDisplay(
  rootEl: { querySelectorAll: (selector: string) => Iterable<any> },
  pageNotes: PageNoteItem[][],
): void {
  const noteNoById = new Map<string, number>()
  for (const items of pageNotes) {
    for (const item of items) {
      noteNoById.set(item.id, item.no)
    }
  }

  const sups = rootEl.querySelectorAll('sup[data-note-ref], [data-note-ref]')
  for (const sup of sups) {
    const refId = sup.dataset?.noteRef
    if (!refId || !noteNoById.has(refId)) continue
    const targetNo = noteNoById.get(refId)!
    const displayMark = noteMarkText('footnote', targetNo)
    sup.textContent = displayMark
    if (sup.dataset) {
      sup.dataset.pageNoteNo = String(targetNo)
    }
  }
}
