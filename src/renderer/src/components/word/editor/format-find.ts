/**
 * Format find & replace (Word: 查找和替换 → 更多 → 格式): find runs by their
 * character formatting and/or apply replacement formatting to found ranges.
 * Pure predicates and PM-range helpers live here; FindPanel owns the UI.
 *
 * Matching semantics per Word: every set field must match; unset fields are
 * wildcards. Font compares case-insensitively against both slots (fontAscii /
 * font). Empty ranges and non-text content never match.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'

export interface FormatRange {
  from: number
  to: number
}
type Range = FormatRange

export interface FindFormat {
  font?: string | null
  sizeHalfPoints?: number | null
  color?: string | null
  bold?: boolean | null
  italic?: boolean | null
}

export function isEmptyFormat(f: FindFormat | null | undefined): boolean {
  if (!f) return true
  return (
    (f.font == null || f.font === '') &&
    (f.sizeHalfPoints == null || f.sizeHalfPoints === 0) &&
    (f.color == null || f.color === '') &&
    f.bold == null &&
    f.italic == null
  )
}

export interface RunFormatProbe {
  font?: string | null
  fontAscii?: string | null
  sizeHalfPoints?: number | null
  color?: string | null
  bold?: boolean | null
  italic?: boolean | null
}

/** run attrs -> probe (a docTextStyle mark's values flattened onto run fields) */
export function probeOfTextNode(node: PmNode): RunFormatProbe {
  const probe: RunFormatProbe = {}
  for (const mark of node.marks) {
    if (mark.type.name === 'docTextStyle') {
      if (mark.attrs.font != null) probe.font = mark.attrs.font as string
      if (mark.attrs.fontAscii != null) probe.fontAscii = mark.attrs.fontAscii as string
      if (mark.attrs.sizeHalfPoints != null)
        probe.sizeHalfPoints = mark.attrs.sizeHalfPoints as number
      if (mark.attrs.color != null) probe.color = mark.attrs.color as string
    } else if (mark.type.name === 'bold') {
      probe.bold = true
    } else if (mark.type.name === 'italic') {
      probe.italic = true
    }
  }
  return probe
}

export function textRunMatchesFormat(probe: RunFormatProbe, fmt: FindFormat): boolean {
  if (fmt.font != null && fmt.font !== '') {
    const want = fmt.font.toLowerCase()
    const a = (probe.font ?? '').toLowerCase()
    const b = (probe.fontAscii ?? '').toLowerCase()
    if (a !== want && b !== want) return false
  }
  if (fmt.sizeHalfPoints != null && fmt.sizeHalfPoints !== 0) {
    if (probe.sizeHalfPoints !== fmt.sizeHalfPoints) return false
  }
  if (fmt.color != null && fmt.color !== '') {
    const want = fmt.color.replace('#', '').toLowerCase()
    if ((probe.color ?? '').replace('#', '').toLowerCase() !== want) return false
  }
  if (fmt.bold != null && fmt.bold !== (probe.bold === true)) return false
  if (fmt.italic != null && fmt.italic !== (probe.italic === true)) return false
  return true
}

/** does the text run at `pos` carry the sought format? */
function nodeMatches(editor: Editor, pos: number, fmt: FindFormat): boolean {
  const $pos = editor.state.doc.resolve(pos)
  const parent = $pos.parent
  let matched = false
  let offset = 0
  parent.forEach((child) => {
    if (!child.isText || !child.text) {
      offset += child.nodeSize
      return
    }
    if ($pos.parentOffset >= offset && $pos.parentOffset < offset + child.nodeSize) {
      matched = textRunMatchesFormat(probeOfTextNode(child), fmt)
    }
    offset += child.nodeSize
  })
  return matched
}

/** text ranges (document order) of every run matching `fmt`; adjacent lines stay separate */
export function findFormatRanges(editor: Editor, fmt: FindFormat): Range[] {
  if (isEmptyFormat(fmt)) return []
  const out: Range[] = []
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (!textRunMatchesFormat(probeOfTextNode(node), fmt)) return
    out.push({ from: pos, to: pos + node.nodeSize })
  })
  return out
}

/** keep only ranges whose start position sits in a run matching `fmt` */
export function filterRangesByFormat(
  editor: Editor,
  ranges: Range[],
  fmt: FindFormat,
): Range[] {
  if (isEmptyFormat(fmt)) return ranges
  return ranges.filter((r) => nodeMatches(editor, r.from, fmt))
}

/**
 * Apply replacement formatting over ranges (one transaction = one undo step).
 * Only the set fields change; font/size/color go through docTextStyle, bold /
 * italic through their own marks. Empty format is a no-op.
 */
export function applyFormatReplace(editor: Editor, ranges: Range[], fmt: FindFormat): void {
  if (isEmptyFormat(fmt) || ranges.length === 0) return
  const tr = editor.state.tr
  const styleAttrs: Record<string, unknown> = {}
  if (fmt.font != null && fmt.font !== '') {
    styleAttrs.font = fmt.font
    styleAttrs.fontAscii = fmt.font
  }
  if (fmt.sizeHalfPoints != null && fmt.sizeHalfPoints !== 0)
    styleAttrs.sizeHalfPoints = fmt.sizeHalfPoints
  if (fmt.color != null && fmt.color !== '') styleAttrs.color = fmt.color.replace('#', '')
  const hasStyle = Object.keys(styleAttrs).length > 0
  const styleType = editor.state.schema.marks.docTextStyle
  for (const r of ranges) {
    if (hasStyle) {
      const existing = editor.state.doc
        .nodeAt(r.from)
        ?.marks.filter((m) => m.type.name === 'docTextStyle') ?? []
      const base = existing[0]?.attrs ?? {}
      tr.addMark(r.from, r.to, styleType.create({ ...base, ...styleAttrs }))
    }
    if (fmt.bold != null) {
      if (fmt.bold) tr.addMark(r.from, r.to, editor.state.schema.marks.bold.create())
      else tr.removeMark(r.from, r.to, editor.state.schema.marks.bold)
    }
    if (fmt.italic != null) {
      if (fmt.italic) tr.addMark(r.from, r.to, editor.state.schema.marks.italic.create())
      else tr.removeMark(r.from, r.to, editor.state.schema.marks.italic)
    }
  }
  tr.setMeta('trackIgnore', true)
  editor.view.dispatch(tr)
}
