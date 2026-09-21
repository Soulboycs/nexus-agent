/**
 * R8-B headless Word engine (main process).
 *
 * Runs the renderer's Word editing stack — the same Tiptap editor, restricted
 * HTML parser, apply_ops registry and save plan the in-app agent and the live
 * MCP bridge use — inside the Electron main process under jsdom, against a
 * file on disk. This is the offline half of the docx_* agent tools: when the
 * target document is not open in the live canvas, edits run here and are
 * saved back to disk byte-preserving (unchanged blocks round-trip verbatim).
 *
 * Ported 1:1 from GenOffice packages/cli/src/formats/docx.ts + docx-sections.ts
 * (the proven CLI headless route); module paths adapted to this repo's tree.
 */
import type { Editor } from '@tiptap/core'
import { Buffer } from 'node:buffer'
import {
  BLANK_BULLET_NUM_ID,
  BLANK_ORDERED_NUM_ID,
  buildBlankDocx,
  findChartWorkbookPath,
  nextNoteId,
  parseChartPartXml,
  parseDocx,
  patchChartPartXml,
  patchChartWorkbookXlsxBase64,
  pendingHeadingLevel,
  readDocxPartBase64,
  readSections,
  saveDocx,
  applySectionStartType,
  sectionFromSectPr,
  type CommentInfo,
  type HeaderFooter,
  type HfPartInfo,
  type NoteInfo,
  type SaveBlock,
  type SaveOptions,
  type SectionInfo,
  type StyleUpsert,
  type PictureWatermarkSpec,
  type WatermarkSpec,
} from '../../../packages/docx-engine'
import type { FloatSpec } from '../../../renderer/src/components/word/ai/floating-ops'
import type { AiNotesAccess, NoteKind } from '../../../renderer/src/components/word/ai/note-ops'
import type { AiCommentsAccess, AiDocExtras } from '../../../renderer/src/components/word/ai/tools'
import type { AiHeaderFooterAccess } from '../../../renderer/src/components/word/ai/tools'
import type {
  AiPageSetupAccess,
  ResolvedPageSetup,
} from '../../../renderer/src/components/word/ai/page-setup'
import type { AgentToolCall } from '../../../renderer/src/components/shared/ipc'
import { ensureDom } from './ensureDom'
import { readImageSource } from './imageSource'

/**
 * The Word editing modules live in the renderer tree. They are pure apart
 * from needing a DOM, so the headless engine loads them lazily, after jsdom
 * exists. Kept as a group so the editor, its extensions and the tool layer
 * always come from the same module graph.
 */
async function docsModules() {
  await ensureDom()
  const [
    { Editor },
    extensions,
    convert,
    protocol,
    ops,
    tools,
    locale,
    comments,
    hfText,
    revisionOps,
    pageSetup,
    floating,
    noteOps,
    tableOps,
  ] = await Promise.all([
    import('@tiptap/core'),
    import('../../../renderer/src/components/word/editor/extensions'),
    import('../../../renderer/src/components/word/editor/convert'),
    import('../../../renderer/src/components/word/ai/protocol'),
    import('../../../renderer/src/components/word/ai/ops'),
    import('../../../renderer/src/components/word/ai/tools'),
    import('../../../renderer/src/components/word/i18n/locale'),
    import('../../../renderer/src/components/word/editor/comments'),
    import('../../../renderer/src/components/word/editor/hf-text'),
    import('../../../renderer/src/components/word/ai/revision-ops'),
    import('../../../renderer/src/components/word/ai/page-setup'),
    import('../../../renderer/src/components/word/ai/floating-ops'),
    import('../../../renderer/src/components/word/ai/note-ops'),
    import('../../../renderer/src/components/word/ai/table-ops'),
  ])
  locale.setModuleLang('en')
  return {
    Editor,
    extensions,
    convert,
    protocol,
    ops,
    tools,
    comments,
    hfText,
    revisionOps,
    pageSetup,
    floating,
    noteOps,
    tableOps,
  }
}

type Parsed = Awaited<ReturnType<typeof parseDocx>>
type Modules = Awaited<ReturnType<typeof docsModules>>

type HfView = 'default' | 'first' | 'even'
type HfSlot = `${'header' | 'footer'}${'' | 'First' | 'Even'}`

/** Header/footer parts, comments and notes live outside the ProseMirror document; edits are kept here until save. */
interface SideState {
  hf: Partial<Record<HfSlot, HeaderFooter | null>>
  hfDirty: Set<HfSlot>
  titlePg: boolean
  evenOddHf: boolean
  titlePgDirty: boolean
  evenOddHfDirty: boolean
  comments: CommentInfo[]
  commentsDirty: boolean
  /** pending sectPr rewrites by the docxIndex of the block carrying them (section breaks, trailing) */
  sectPr: Map<number, string>
  /** define_style results by styleId, written into styles.xml on save */
  styleUpserts: Map<string, StyleUpsert>
  /** set_watermark result; undefined = header untouched */
  watermark?: WatermarkSpec | PictureWatermarkSpec | null
  watermarkText: string | null
  footnotes: NoteInfo[]
  endnotes: NoteInfo[]
  notesDirty: boolean
}

export interface OpenDocument {
  parsed: Parsed
  editor: Editor
  numIds: { bullet: string | null; ordered: string | null }
  mods: Modules
  side: SideState
}

/** the executeTool result shape the renderer's agent loop consumes */
export interface ToolExecution {
  output: string
  isError?: boolean
  mutated: boolean
  summary: string
}

export interface RunToolOptions {
  /** record content edits as tracked changes under this author */
  trackAuthor?: string
  /** author shown on comments the comment tools create */
  commentAuthor?: string
  /** folder image-source relative paths resolve against */
  baseDir?: string
}

function hfFromPart(part: HfPartInfo | null | undefined): HeaderFooter | null {
  if (
    !part ||
    (!part.text && !part.hasPageNumber && part.paras.length === 0 && !part.images?.length)
  )
    return null
  return {
    text: part.text,
    pageNumber: part.hasPageNumber,
    paras: part.paras.length > 0 ? part.paras : undefined,
  }
}

function sideStateOf(parsed: Parsed): SideState {
  const dflt = (kind: 'header' | 'footer'): HeaderFooter | null => {
    const text = kind === 'header' ? parsed.headerText : parsed.footerText
    const pageNumber = kind === 'header' ? parsed.headerHasPageNumber : parsed.footerHasPageNumber
    const paras = kind === 'header' ? parsed.headerParas : parsed.footerParas
    return text || pageNumber || paras?.length
      ? { text: text ?? '', pageNumber, paras: paras ?? undefined }
      : null
  }
  return {
    hf: {
      header: dflt('header'),
      footer: dflt('footer'),
      headerFirst: hfFromPart(parsed.headerFirst),
      footerFirst: hfFromPart(parsed.footerFirst),
      headerEven: hfFromPart(parsed.headerEven),
      footerEven: hfFromPart(parsed.footerEven),
    },
    hfDirty: new Set(),
    titlePg: parsed.titlePg ?? false,
    evenOddHf: parsed.evenAndOddHeaders ?? false,
    titlePgDirty: false,
    evenOddHfDirty: false,
    comments: [...parsed.comments],
    commentsDirty: false,
    sectPr: new Map(),
    styleUpserts: new Map(),
    watermarkText: parsed.watermarkText ?? null,
    footnotes: [...parsed.footnotes],
    endnotes: [...parsed.endnotes],
    notesDirty: false,
  }
}

export async function openDocument(bytes: Uint8Array): Promise<OpenDocument> {
  const mods = await docsModules()
  const parsed = await parseDocx(bytes)
  const editor = new mods.Editor({
    element: document.createElement('div'),
    extensions: mods.extensions.editorExtensions,
  })
  editor.commands.setContent(
    mods.convert.blocksToPmDoc(parsed.blocks, readSections(parsed)) as never,
  )
  editor.storage.listNumbering.styles = parsed.styles
  const numIds = {
    bullet: mods.protocol.findNumId(parsed.blocks, 'bullet') ?? BLANK_BULLET_NUM_ID,
    ordered: mods.protocol.findNumId(parsed.blocks, 'ordered') ?? BLANK_ORDERED_NUM_ID,
  }
  return { parsed, editor, numIds, mods, side: sideStateOf(parsed) }
}

export async function blankDocument(): Promise<OpenDocument> {
  return openDocument(await buildBlankDocx())
}

export async function saveDocument(doc: OpenDocument): Promise<Uint8Array> {
  // pmDocToSavePlan walks the JSON doc shape (doc.content as an array), the
  // same input file-actions and the GenOffice CLI hand it — not the PmNode.
  const plan = doc.mods.convert.pmDocToSavePlan(doc.editor.getJSON() as never, doc.parsed.blocks)
  const { side } = doc
  const hf = (slot: HfSlot) => (side.hfDirty.has(slot) ? (side.hf[slot] ?? undefined) : undefined)
  const sectionEdits = applySectionEdits(doc, plan)
  const options: SaveOptions = {
    ...sectionEdits.options,
    header: hf('header'),
    footer: hf('footer'),
    headerFirst: hf('headerFirst'),
    footerFirst: hf('footerFirst'),
    headerEven: hf('headerEven'),
    footerEven: hf('footerEven'),
    titlePg: side.titlePgDirty ? side.titlePg : undefined,
    evenAndOddHeaders: side.evenOddHfDirty ? side.evenOddHf : undefined,
    comments: side.commentsDirty ? side.comments : undefined,
    styleUpserts: side.styleUpserts.size > 0 ? [...side.styleUpserts.values()] : undefined,
    watermark: side.watermark,
    footnotes: side.notesDirty ? side.footnotes : undefined,
    endnotes: side.notesDirty ? side.endnotes : undefined,
    ...(await chartPartPatches(doc, plan.chartPatches)),
  }
  return saveDocx(doc.parsed, sectionEdits.saveBlocks, options)
}

/** edit_chart changes live in the chart's own part and its embedded workbook, not in the body XML */
async function chartPartPatches(
  doc: OpenDocument,
  patches: ReturnType<Modules['convert']['pmDocToSavePlan']>['chartPatches'],
): Promise<Pick<SaveOptions, 'partXml' | 'partBinary'>> {
  const partXml: Record<string, string> = {}
  const partBinary: Record<string, string> = {}
  const original = doc.parsed.internal.originalBytes
  for (const { partPath, patch } of patches) {
    const part = doc.parsed.extras.chartParts[partPath]
    if (!part) continue
    const patched = patchChartPartXml(part, patch)
    partXml[partPath] = patched
    const wbPath = await findChartWorkbookPath(original, partPath)
    const wb = wbPath ? await readDocxPartBase64(original, wbPath) : null
    const display = wb ? parseChartPartXml(patched, partPath) : null
    if (wbPath && wb && display) {
      const updated = await patchChartWorkbookXlsxBase64(
        wb,
        display.categories,
        display.series.map((s, i) => ({
          name: s.name ?? `Series${i + 1}`,
          values: s.values as (number | null)[],
        })),
      )
      if (updated) partBinary[wbPath] = updated
    }
  }
  return {
    ...(Object.keys(partXml).length ? { partXml } : {}),
    ...(Object.keys(partBinary).length ? { partBinary } : {}),
  }
}

export function closeDocument(doc: OpenDocument): void {
  doc.editor.destroy()
}

// ---- sections (GenOffice docx-sections.ts) ----

const SECT_PR = /<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>/

/**
 * A section ends at a sectPr: inside an original section-break paragraph, inside
 * a section-break paragraph this batch inserted (genXml), or the trailing hidden
 * one. Edits to original / trailing sectPr wait in `side.sectPr` (by docxIndex)
 * until save; a generated paragraph is patched in place.
 */
interface Boundary {
  kind: 'original' | 'generated' | 'trailing'
  /** top-level PM index of the block carrying the sectPr (childCount for the trailing one) */
  pmIndex: number
  docxIndex?: number
  xml: string
}

function boundaries(doc: OpenDocument): Boundary[] {
  const { parsed, side } = doc
  const byDocx = new Map<number, string>()
  for (const b of parsed.blocks) {
    if (b.docxIndex !== null && b.originalXml?.includes('<w:sectPr')) {
      const m = SECT_PR.exec(b.originalXml)
      if (m) byDocx.set(b.docxIndex, m[0])
    }
  }
  const out: Boundary[] = []
  const pm = doc.editor.state.doc
  pm.forEach((node, _offset, index) => {
    const genXml = node.attrs.genXml
    if (node.type.name === 'docProtected' && typeof genXml === 'string') {
      const m = SECT_PR.exec(genXml)
      if (m) out.push({ kind: 'generated', pmIndex: index, xml: m[0] })
      return
    }
    const di = node.attrs.docxIndex
    if (typeof di === 'number' && byDocx.has(di)) {
      out.push({
        kind: 'original',
        pmIndex: index,
        docxIndex: di,
        xml: side.sectPr.get(di) ?? byDocx.get(di)!,
      })
    }
  })
  const trailing = parsed.blocks.find((b) => b.hidden && b.originalXml?.includes('<w:sectPr'))
  if (trailing && trailing.docxIndex !== null) {
    const original = SECT_PR.exec(trailing.originalXml!)?.[0] ?? ''
    out.push({
      kind: 'trailing',
      pmIndex: pm.childCount,
      docxIndex: trailing.docxIndex,
      xml: side.sectPr.get(trailing.docxIndex) ?? original,
    })
  }
  return out
}

/** SectionInfo per section with firstBlockIndex / lastBlockIndex as live PM indexes */
function sections(doc: OpenDocument): { info: SectionInfo; boundary: Boundary }[] {
  const count = doc.editor.state.doc.childCount
  const out: { info: SectionInfo; boundary: Boundary }[] = []
  let first = 0
  for (const b of boundaries(doc)) {
    const last = b.kind === 'trailing' ? Math.max(count - 1, first) : b.pmIndex
    out.push({ info: sectionFromSectPr(b.xml, first, last, doc.parsed.gutterAtTop), boundary: b })
    first = last + 1
  }
  return out
}

export function listSections(doc: OpenDocument) {
  return sections(doc).map(({ info }, i) =>
    doc.mods.pageSetup.describeSection(info, i, info.firstBlockIndex, info.lastBlockIndex),
  )
}

function store(doc: OpenDocument, b: Boundary, xml: string): void {
  if (b.kind === 'generated') {
    const pm = doc.editor.state.doc
    const node = pm.child(b.pmIndex)
    let pos = 0
    for (let i = 0; i < b.pmIndex; i++) pos += pm.child(i).nodeSize
    const genXml = String(node.attrs.genXml).replace(b.xml, xml)
    doc.editor.view.dispatch(
      doc.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, genXml }),
    )
    doc.mods.tools.markDocSeen(doc.editor)
    return
  }
  doc.side.sectPr.set(b.docxIndex!, xml)
}

function pageSetupAccess(doc: OpenDocument): AiPageSetupAccess {
  const { pageSetup } = doc.mods
  return {
    list: () => listSections(doc),
    current: (index: number) => sections(doc)[index]?.info,
    set: (index: number, resolved: ResolvedPageSetup) => {
      const sec = sections(doc)[index]
      if (!sec) return `section ${index} does not exist`
      store(doc, sec.boundary, pageSetup.applyResolvedPageSetup(sec.boundary.xml, resolved))
      // the header/footer tool reads and may re-write the flag; keep both stores agreeing
      if (sec.boundary.kind === 'trailing' && resolved.titlePg !== undefined) {
        doc.side.titlePg = resolved.titlePg
        doc.side.titlePgDirty = true
      }
      return null
    },
    insertBreak: (type, afterBlockIndex) => {
      const all = sections(doc)
      if (all.length === 0) return 'the document has no section properties to copy'
      const owner =
        all.find((s) => Math.max(afterBlockIndex, 0) <= s.info.lastBlockIndex) ??
        all[all.length - 1]!
      const pm = doc.editor.state.doc
      let pos = 0
      for (let i = 0; i <= afterBlockIndex && i < pm.childCount; i++) pos += pm.child(i).nodeSize
      doc.editor
        .chain()
        .insertContentAt(pos, {
          type: 'docProtected',
          attrs: {
            docxIndex: null,
            blockType: 'passthrough',
            label: 'Section break paragraph',
            previewText: '',
            genXml: pageSetup.sectionBreakParagraphXml(owner.boundary.xml),
          },
        })
        .run()
      // the inserted paragraph shifted the owner's boundary by one block
      const shifted =
        owner.boundary.kind === 'generated' && owner.boundary.pmIndex > afterBlockIndex
          ? { ...owner.boundary, pmIndex: owner.boundary.pmIndex + 1 }
          : owner.boundary
      store(doc, shifted, applySectionStartType(owner.boundary.xml, type))
      doc.mods.tools.markDocSeen(doc.editor)
      return null
    },
  }
}

/**
 * Fold pending sectPr edits into the save: the trailing one travels verbatim as
 * SaveOptions.trailingSectPr (the engine owns the hidden block), the others
 * replace the sectPr inside their section-break paragraph wherever the plan
 * put it: untouched (original bytes), regenerated after a body edit (the
 * paragraph's pPr passthrough) or rewritten as an XML fragment.
 */
function applySectionEdits(
  doc: OpenDocument,
  plan: Pick<ReturnType<Modules['convert']['pmDocToSavePlan']>, 'saveBlocks' | 'saveBlockIndexByDocx'>,
): { saveBlocks: SaveBlock[]; options: Partial<SaveOptions> } {
  const { parsed, side } = doc
  if (side.sectPr.size === 0) return { saveBlocks: plan.saveBlocks, options: {} }
  const trailing = parsed.blocks.find((b) => b.hidden && b.originalXml?.includes('<w:sectPr'))
  const options: Partial<SaveOptions> = {}
  const out = [...plan.saveBlocks]
  for (const [docxIndex, xml] of side.sectPr) {
    if (trailing && docxIndex === trailing.docxIndex) {
      options.trailingSectPr = xml
      continue
    }
    const at = plan.saveBlockIndexByDocx.get(docxIndex)
    const fb = at === undefined ? undefined : out[at]
    if (!fb) continue
    if (fb.kind === 'original') {
      const block = parsed.blocks.find((b) => b.docxIndex === docxIndex)
      if (block?.originalXml)
        out[at!] = { ...fb, kind: 'xml', xml: block.originalXml.replace(SECT_PR, xml), docxIndex }
    } else if (fb.kind === 'generated' && fb.block.rawPPr && SECT_PR.test(fb.block.rawPPr)) {
      out[at!] = { ...fb, block: { ...fb.block, rawPPr: fb.block.rawPPr.replace(SECT_PR, xml) } }
    } else if (fb.kind === 'xml' && SECT_PR.test(fb.xml)) {
      out[at!] = { ...fb, xml: fb.xml.replace(SECT_PR, xml) }
    }
  }
  return { saveBlocks: out, options }
}

// ---- access objects handed to executeTool ----

function commentsAccess(doc: OpenDocument, author: string): AiCommentsAccess {
  const { side } = doc
  return {
    list: () => side.comments,
    add: (range, text, meta) => {
      const id = doc.mods.comments.nextCommentId(side.comments)
      if (!doc.mods.comments.addCommentToRange(doc.editor, range.from, range.to, id)) return null
      side.comments.push({
        id,
        author: meta.author ?? author,
        ...(meta.initials ? { initials: meta.initials } : {}),
        date: commentDate(),
        text,
      })
      side.commentsDirty = true
      return id
    },
    remove: (id) => {
      const victims = new Set([
        id,
        ...side.comments.filter((c) => c.parentId === id).map((c) => c.id),
      ])
      if (!side.comments.some((c) => c.id === id)) return false
      for (const v of victims) doc.mods.comments.removeCommentFromDoc(doc.editor, v)
      side.comments = side.comments.filter((c) => !victims.has(c.id))
      side.commentsDirty = true
      return true
    },
    reply: (parentId, text) => {
      const id = doc.mods.comments.nextCommentId(side.comments)
      if (!doc.mods.comments.addReplyToCommentRange(doc.editor, parentId, id)) return false
      side.comments.push({ id, author, date: commentDate(), text, parentId })
      side.commentsDirty = true
      return true
    },
    resolve: (id) => {
      if (!side.comments.some((c) => c.id === id)) return false
      side.comments = side.comments.map((c) =>
        c.id === id || c.parentId === id ? { ...c, done: true } : c,
      )
      side.commentsDirty = true
      return true
    },
  }
}

const commentDate = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function notesAccess(doc: OpenDocument): AiNotesAccess {
  const { side } = doc
  const listOf = (kind: NoteKind) => (kind === 'footnote' ? side.footnotes : side.endnotes)
  const setList = (kind: NoteKind, next: NoteInfo[]) => {
    if (kind === 'footnote') side.footnotes = next
    else side.endnotes = next
    side.notesDirty = true
  }
  return {
    list: listOf,
    add: (kind, text) => {
      const id = nextNoteId(listOf(kind))
      setList(kind, [...listOf(kind), { id, text }])
      return id
    },
    remove: (kind, id) => {
      if (!listOf(kind).some((n) => n.id === id)) return false
      setList(
        kind,
        listOf(kind).filter((n) => n.id !== id),
      )
      return true
    },
    protectedMarkBlock: (kind, id) =>
      doc.mods.noteOps.protectedNoteMarkBlock(
        doc.editor.state.doc,
        (block) => protectedXml(doc, block),
        kind,
        id,
      ),
  }
}

/** the XML a protected block saves as: its generated XML, or the original slice it still mirrors */
function protectedXml(doc: OpenDocument, block: { attrs: Record<string, unknown> }): string {
  if (typeof block.attrs.genXml === 'string') return block.attrs.genXml
  if (typeof block.attrs.docxIndex === 'number')
    return doc.parsed.blocks[block.attrs.docxIndex]?.originalXml ?? ''
  return ''
}

export interface NoteSummary {
  kind: NoteKind
  id: string
  /** note number by document order of the reference marks; absent when the text has no mark */
  num?: number
  blockIndex?: number
  text: string
}

/** Footnotes and endnotes with the block holding their reference mark; ids as delete_note takes them. */
export function listNotes(doc: OpenDocument): NoteSummary[] {
  const anchors = doc.mods.noteOps.noteAnchors(doc.editor.state.doc)
  const out: NoteSummary[] = []
  for (const kind of ['footnote', 'endnote'] as const) {
    for (const note of doc.side[kind === 'footnote' ? 'footnotes' : 'endnotes']) {
      const a = anchors.get(`${kind}:${note.id}`)
      out.push({
        kind,
        id: note.id,
        ...(a ? { num: a.num, blockIndex: a.blockIndex } : {}),
        text: note.text,
      })
    }
  }
  return out
}

// ---- header/footer, watermark, styles ----

export type WatermarkState =
  | { kind: 'none'; text: null }
  | { kind: 'text'; text: string }
  | { kind: 'picture'; text: null; widthPt: number; heightPt: number; washout: boolean }

function watermarkState(doc: OpenDocument): WatermarkState {
  const { side, parsed } = doc
  if (side.watermark !== undefined) {
    const wm = side.watermark
    if (wm === null) return { kind: 'none', text: null }
    if ('image' in wm) {
      // the frame is sized against the page on save; report the natural size until then
      const box = { widthPt: (wm.image.widthPx * 72) / 96, heightPt: (wm.image.heightPx * 72) / 96 }
      const f = wm.scale === undefined ? 1 : wm.scale / 100
      return {
        kind: 'picture',
        text: null,
        widthPt: Math.round(box.widthPt * f * 100) / 100,
        heightPt: Math.round(box.heightPt * f * 100) / 100,
        washout: wm.washout !== false,
      }
    }
    return { kind: 'text', text: wm.text }
  }
  if (side.watermarkText) return { kind: 'text', text: side.watermarkText }
  const pic = parsed.watermarkPicture
  if (pic)
    return {
      kind: 'picture',
      text: null,
      widthPt: pic.widthPt,
      heightPt: pic.heightPt,
      washout: pic.washout,
    }
  return { kind: 'none', text: null }
}

export interface HeaderFooterState {
  header: string
  footer: string
  headerFirst: string | null
  footerFirst: string | null
  headerEven: string | null
  footerEven: string | null
  titlePg: boolean
  evenOddHf: boolean
  multiSection: boolean
  /** the default header's watermark: text, picture, or none; pending set_watermark results included */
  watermark: WatermarkState
}

export function headerFooterState(doc: OpenDocument): HeaderFooterState {
  const { side } = doc
  const textOf = (slot: HfSlot) => {
    const v = side.hf[slot]
    return v ? doc.mods.hfText.hfEditText(v) : ''
  }
  return {
    header: textOf('header'),
    footer: textOf('footer'),
    headerFirst: side.titlePg ? textOf('headerFirst') : null,
    footerFirst: side.titlePg ? textOf('footerFirst') : null,
    headerEven: side.evenOddHf ? textOf('headerEven') : null,
    footerEven: side.evenOddHf ? textOf('footerEven') : null,
    titlePg: side.titlePg,
    evenOddHf: side.evenOddHf,
    multiSection: readSections(doc.parsed).length > 1,
    watermark: watermarkState(doc),
  }
}

const slotOf = (kind: 'header' | 'footer', view: HfView): HfSlot =>
  `${kind}${view === 'default' ? '' : view === 'first' ? 'First' : 'Even'}` as HfSlot

/** The default variant is written to the trailing section's part, as the app does for single-section documents. */
function headerFooterAccess(doc: OpenDocument): AiHeaderFooterAccess {
  const { side } = doc
  return {
    read: () => headerFooterState(doc),
    set: (kind: 'header' | 'footer', view: HfView, text: string) => {
      if (view === 'first' && !side.titlePg) {
        side.titlePg = true
        side.titlePgDirty = true
      }
      if (view === 'even' && !side.evenOddHf) {
        side.evenOddHf = true
        side.evenOddHfDirty = true
      }
      const slot = slotOf(kind, view)
      side.hf[slot] = doc.mods.hfText.applyHfText(side.hf[slot] ?? null, text)
      side.hfDirty.add(slot)
      return null
    },
  }
}

/** styles.xml catalog plus this batch's define_style entries, and the header watermark. */
function docExtras(doc: OpenDocument): AiDocExtras {
  return {
    styles: {
      list: () => listStyles(doc),
      upsert: (up: StyleUpsert) => {
        const prev = doc.side.styleUpserts.get(up.styleId)
        doc.side.styleUpserts.set(
          up.styleId,
          prev
            ? {
                ...prev,
                ...up,
                pPr: up.pPr || prev.pPr ? { ...prev.pPr, ...up.pPr } : undefined,
                rPr: up.rPr || prev.rPr ? { ...prev.rPr, ...up.rPr } : undefined,
              }
            : up,
        )
        return null
      },
    },
    watermark: {
      current: () => watermarkState(doc).text,
      set: (spec) => {
        doc.side.watermark = spec
        return null
      },
    },
  }
}

export interface StyleSummary {
  styleId: string
  name: string
  type: 'paragraph' | 'character' | 'table'
  basedOn?: string
  headingLevel?: number
  /** blocks (paragraphs, headings, list items, runs) carrying the style */
  inUse: number
  /** defined or changed by this batch, not saved yet */
  pending?: boolean
}

/** Every style the document defines (plus pending define_style entries), with usage counts. */
export function listStyles(doc: OpenDocument): StyleSummary[] {
  const counts = new Map<string, number>()
  const headings = new Map<number, number>()
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1)
  doc.editor.state.doc.descendants((node) => {
    if (typeof node.attrs?.styleId === 'string' && node.attrs.styleId) bump(node.attrs.styleId)
    else if (node.type.name === 'docHeading') {
      const level = Number(node.attrs.level) || 1
      headings.set(level, (headings.get(level) ?? 0) + 1)
    }
    for (const mark of node.marks) {
      if (typeof mark.attrs?.styleId === 'string' && mark.attrs.styleId) bump(mark.attrs.styleId)
    }
    return true
  })
  const out = new Map<string, StyleSummary>()
  for (const s of doc.parsed.styles.values()) {
    if (s.linkedCharShell) continue
    let inUse = counts.get(s.styleId) ?? 0
    if (s.headingLevel && /^Heading[1-9]$/.test(s.styleId))
      inUse += headings.get(s.headingLevel) ?? 0
    out.set(s.styleId, {
      styleId: s.styleId,
      name: s.name,
      type: s.type,
      ...(s.basedOn ? { basedOn: s.basedOn } : {}),
      ...(s.headingLevel ? { headingLevel: s.headingLevel } : {}),
      inUse,
    })
  }
  const parsed = (id: string) => doc.parsed.styles.get(id)
  for (const up of doc.side.styleUpserts.values()) {
    const cur = out.get(up.styleId)
    const basedOn = up.basedOn === undefined ? cur?.basedOn : (up.basedOn ?? undefined)
    const headingLevel = pendingHeadingLevel(
      up.styleId,
      (id) => doc.side.styleUpserts.get(id),
      parsed,
    )
    out.set(up.styleId, {
      styleId: up.styleId,
      name: up.name ?? cur?.name ?? up.styleId,
      type: cur?.type ?? up.type ?? 'paragraph',
      ...(basedOn ? { basedOn } : {}),
      ...(headingLevel ? { headingLevel } : {}),
      inUse: cur?.inUse ?? counts.get(up.styleId) ?? 0,
      pending: true,
    })
  }
  return [...out.values()]
}

export interface CommentSummary extends CommentInfo {
  blockIndex?: number
  anchorText?: string
}

/** Every comment with the block its anchor sits in, ids as reply_comment / resolve_comment / delete_comment take them. */
export function listComments(doc: OpenDocument): CommentSummary[] {
  const anchors = doc.mods.protocol.commentAnchors(doc.editor)
  return doc.side.comments.map((c) => {
    const a = anchors.get(c.parentId ?? c.id)
    const base = { ...c, done: c.done === true }
    return a ? { ...base, blockIndex: a.blockIndex, anchorText: a.excerpt } : base
  })
}

export interface RevisionSummary {
  /** positional: r1 = first pending change in document order; renumbered after every edit */
  id: string
  type: 'insertion' | 'deletion' | 'formatting' | 'move'
  kind: string
  author: string
  date?: string
  blockIndex: number
  text: string
  /** formatting changes: `field: old → new` pairs */
  change?: string
}

/** Pending tracked changes in document order, ids as accept_changes / reject_changes take them. */
export function listRevisions(doc: OpenDocument): RevisionSummary[] {
  return doc.mods.revisionOps
    .listRevisionEntries(doc.editor.state.doc)
    .map(({ from: _from, to: _to, ...rest }) => rest)
}

// ---- image insertion (local-path / data: / http(s) sources) ----

/**
 * insert_image / insert_picture headless: the live renderer downloads through
 * window.desktop and measures with an <img>; neither exists here, so the node
 * is built from the bytes directly, then the executor's staleness baseline is
 * refreshed (markDocSeen). `picture` = the sized / floating insert_picture variant.
 */
export async function insertImage(
  doc: OpenDocument,
  input: Record<string, unknown>,
  opts: RunToolOptions,
  picture = false,
): Promise<ToolExecution> {
  const fail = (output: string): ToolExecution => ({
    output,
    isError: true,
    mutated: false,
    summary: 'Insert image',
  })
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) return fail('url must be a local path, a data: URL or an http(s) URL')
  const source = await readImageSource(url, opts.baseDir)
  if (!source || !source.mime) return fail(`image not found, not downloadable or unsupported: ${url}`)
  const at = doc.mods.floating.insertPosition(doc.editor, input.afterBlockIndex)
  if ('error' in at) return fail(at.error)
  const base64 = Buffer.from(source.bytes).toString('base64')
  let float: FloatSpec | undefined
  if (picture && input.float !== undefined) {
    const r = doc.mods.floating.resolveFloat(input.float)
    if ('error' in r) return fail(r.error)
    float = r.float
  }
  const built = doc.mods.floating.pictureNode({
    base64,
    mime: source.mime,
    naturalWidth: source.width,
    naturalHeight: source.height,
    label: picture ? 'Picture' : 'Image',
    ...(picture
      ? {
          width: input.width,
          height: input.height,
          float,
          ...(typeof input.altText === 'string' ? { altText: input.altText } : {}),
        }
      : { width: `${Math.min(source.width, Number(input.maxWidthPx) || 480)}px` }),
  })
  if ('error' in built) return fail(built.error)
  doc.editor.chain().insertContentAt(at.pos, built.node).run()
  doc.mods.tools.markDocSeen(doc.editor)
  return {
    output: `Inserted the ${float ? 'floating ' : ''}${picture ? 'picture' : 'image'} (${built.widthPx}x${built.heightPx}px) after block ${at.after}.`,
    mutated: true,
    summary: 'Insert image',
  }
}

/** set_watermark with an image: the bytes come from a path / data: / http(s) URL. */
export async function setPictureWatermark(
  doc: OpenDocument,
  input: Record<string, unknown>,
  opts: RunToolOptions,
): Promise<ToolExecution> {
  const fail = (output: string): ToolExecution => ({
    output,
    isError: true,
    mutated: false,
    summary: 'Set watermark',
  })
  const url = String(input.image ?? '').trim()
  if (!url) return fail('image must be a local path, a data: URL or an http(s) URL')
  const source = await readImageSource(url, opts.baseDir)
  if (!source || !source.mime)
    return fail(`image not found, not downloadable or unsupported: ${url}`)
  const resolved = doc.mods.floating.resolvePictureWatermark(input, {
    base64: Buffer.from(source.bytes).toString('base64'),
    mime: source.mime,
    widthPx: source.width,
    heightPx: source.height,
  })
  if ('error' in resolved) return fail(resolved.error)
  doc.side.watermark = resolved.spec
  return {
    output: `Picture watermark set (${source.width}x${source.height}px source).`,
    mutated: false,
    summary: 'Set watermark',
  }
}

// ---- the single entry the agent tools call ----

/**
 * Run one built-in agent tool by its AGENT_TOOLS name against a headless
 * document, wired with the same document stores the live panel hands over.
 * insert_content / insert_chart without afterBlockIndex append at the end
 * (headless semantics — "after the cursor" has no meaning without a user).
 */
export async function runTool(
  doc: OpenDocument,
  name: string,
  input: Record<string, unknown>,
  opts: RunToolOptions = {},
): Promise<ToolExecution> {
  const author = opts.commentAuthor ?? 'Nexus Agent'
  if (name === 'insert_image' || name === 'insert_picture') {
    return insertImage(doc, input, opts, name === 'insert_picture')
  }
  if (name === 'set_watermark' && typeof input.image === 'string') {
    return setPictureWatermark(doc, input, opts)
  }
  const callInput = { ...input }
  if (
    (name === 'insert_content' || name === 'insert_chart') &&
    callInput.afterBlockIndex === undefined
  ) {
    callInput.afterBlockIndex = doc.editor.state.doc.childCount - 1
  }
  const call: AgentToolCall = { id: 'headless', name, input: callInput }
  return doc.mods.tools.executeTool(
    doc.editor,
    call,
    doc.numIds,
    opts.trackAuthor ? { author: opts.trackAuthor } : undefined,
    undefined,
    null,
    commentsAccess(doc, author),
    headerFooterAccess(doc),
    undefined,
    pageSetupAccess(doc),
    docExtras(doc),
    notesAccess(doc),
  )
}
