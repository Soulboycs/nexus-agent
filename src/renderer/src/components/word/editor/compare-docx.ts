/**
 * Review → Compare → export: build a merged revision document from two DOCX
 * parse results. Paragraph alignment reuses compareParagraphs (LCS); changed
 * pairs are refined to a word-level diff (CJK chars are single tokens, latin
 * words whole tokens) and emitted as tracked-change runs — deletions carry
 * `del` (w:del / w:delText), insertions `ins` (w:ins) — so the exported file
 * opens in Word with a standard review workflow (accept / reject each change).
 */
import {
  generateParagraphXml,
  type Block,
  type GenerateContext,
  type RevisionInfo,
  type Run,
  type SaveBlock,
} from '@genoffice/docx-engine'

import { blockTexts, compareParagraphs, type CompareEntry } from './compare'

export interface WordSegment {
  type: 'equal' | 'del' | 'ins'
  text: string
}

/** CJK chars tokenize individually; latin word / whitespace runs stay whole */
export function tokenizeText(text: string): string[] {
  return (
    text.match(
      /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z0-9'’_-]+|\s+|[^\sA-Za-z0-9'’_\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+/g,
    ) ?? []
  )
}

/** LCS word diff of one changed paragraph pair; runs of same-type tokens merge */
export function diffWords(a: string, b: string): WordSegment[] {
  const left = tokenizeText(a)
  const right = tokenizeText(b)
  const n = left.length
  const m = right.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const raw: WordSegment[] = []
  let i = 0
  let j = 0
  const push = (type: WordSegment['type'], text: string) => {
    const prev = raw[raw.length - 1]
    if (prev && prev.type === type) prev.text += text
    else raw.push({ type, text })
  }
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      push('equal', left[i])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', left[i])
      i++
    } else {
      push('ins', right[j])
      j++
    }
  }
  while (i < n) push('del', left[i++])
  while (j < m) push('ins', right[j++])
  return raw
}

const COMPARE_CTX: GenerateContext = {
  headingStyleIds: new Map(),
  allocateHyperlinkRel: () => 'rId999',
}

function revisionRuns(segments: WordSegment[], author: string, date: string): Run[] {
  const rev: RevisionInfo = { author, date }
  return segments
    .filter((s) => s.text)
    .map((s) =>
      s.type === 'equal'
        ? { text: s.text }
        : s.type === 'del'
          ? { text: s.text, del: rev }
          : { text: s.text, ins: rev },
    )
}

function revisionParagraphXml(
  segments: WordSegment[],
  source: Block | undefined,
  author: string,
  date: string,
  paraMarkDel = false,
): string {
  return generateParagraphXml(
    {
      type: 'paragraph',
      format: source?.format,
      runs: revisionRuns(segments, author, date),
      // a fully removed paragraph also deletes its mark, so Word's
      // "accept all" removes the empty shell like its own Compare does
      ...(paraMarkDel ? { paraMarkDel: { author, date } } : {}),
    },
    COMPARE_CTX,
  )
}

/**
 * Merge docB into docA's body as tracked changes. Visible blocks of A keep
 * their original bytes when unchanged; changed / removed / added paragraphs
 * are regenerated with w:ins / w:del runs (the engine wraps consecutive
 * same-revision runs). The result is a SaveBlock[] for saveDocx.
 */
export function buildCompareFinalBlocks(
  leftBlocks: Block[],
  rightBlocks: Block[],
  options: { author?: string; date?: string } = {},
): { finalBlocks: SaveBlock[]; entries: CompareEntry[] } {
  const author = options.author ?? 'Comparison'
  const date = options.date ?? new Date().toISOString()
  const leftVisible = leftBlocks.filter((b) => !b.hidden && b.docxIndex !== null)
  const entries = compareParagraphs(blockTexts(leftBlocks), blockTexts(rightBlocks))
  const out: SaveBlock[] = []
  let li = 0
  for (const entry of entries) {
    if (entry.kind === 'same') {
      out.push({ kind: 'original', docxIndex: leftVisible[li]!.docxIndex! })
      li++
      continue
    }
    if (entry.kind === 'changed') {
      const segments = diffWords(entry.left ?? '', entry.right ?? '')
      const source = leftVisible[li]
      out.push({
        kind: 'xml',
        xml: revisionParagraphXml(segments, source, author, date),
        ...(source?.docxIndex != null ? { docxIndex: source.docxIndex } : {}),
      })
      li++
      continue
    }
    if (entry.kind === 'removed') {
      const source = leftVisible[li]
      out.push({
        kind: 'xml',
        xml: revisionParagraphXml(
          [{ type: 'del', text: entry.left ?? '' }],
          source,
          author,
          date,
          true, // paragraph mark deleted: accept removes the empty paragraph
        ),
        ...(source?.docxIndex != null ? { docxIndex: source.docxIndex } : {}),
      })
      li++
      continue
    }
    // added: a brand-new paragraph, entirely an insertion
    out.push({
      kind: 'xml',
      xml: revisionParagraphXml(
        [{ type: 'ins', text: entry.right ?? '' }],
        undefined,
        author,
        date,
      ),
    })
  }
  // hidden blocks of A are not part of finalBlocks (saveDocx keeps them), but
  // any trailing visible originals the diff never consumed must survive
  while (li < leftVisible.length) {
    out.push({ kind: 'original', docxIndex: leftVisible[li]!.docxIndex! })
    li++
  }
  return { finalBlocks: out, entries }
}
