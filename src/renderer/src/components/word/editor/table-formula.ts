/**
 * Table formulas (Word: 布局 → 公式 / a cell text starting with "=").
 * Supports =SUM/AVERAGE/COUNT/MAX/MIN(ABOVE|BELOW|LEFT|RIGHT), cell refs
 * (B3), ranges (A1:A3), + - * / with precedence and parentheses, and Word's
 * numeric format mask (`\# "#,##0.00"`). Direction walks stop at the first
 * blank cell and skip non-numeric values, matching Word's observable
 * behavior; plain-text cells only — imported fldSimple formulas keep Word's
 * cached result (documented scope).
 */
import type { Editor } from '@tiptap/core'
import { findTableAtSelection } from './table-sort'

export interface FormulaGrid {
  /** cell display texts, row-major; formula cells read as '' while recalcing */
  rows: string[][]
}

export interface FormulaCursor {
  row: number
  col: number
}

export type FormulaResult =
  | { ok: true; value: number; formatted: string }
  | { ok: false; error: string }

function numericOf(text: string): number | null {
  const t = text.replace(/[\s,，]/g, '').replace(/[￥$€£]/g, '').replace(/%$/, '')
  if (!t || !/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** grid column index of letters: A=0, Z=25, AA=26 */
function refCol(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

type Tokens = Array<
  | { t: 'num'; v: number }
  | { t: 'ref'; col: number; row: number }
  | { t: 'range'; c1: number; r1: number; c2: number; r2: number }
  | { t: 'fn'; name: string }
  | { t: 'dir'; name: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
>

function tokenize(src: string): Tokens | null {
  const out: Tokens = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^\d*\.?\d+/.exec(src.slice(i))
      if (!m) return null
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[A-Za-z]/.test(ch)) {
      const word = /^[A-Za-z]+/.exec(src.slice(i))![0]
      const after = src.slice(i + word.length)
      if (/^(ABOVE|BELOW|LEFT|RIGHT)\b/i.test(word) && !/^\s*\(/.test(after)) {
        out.push({ t: 'dir', name: word.toUpperCase() })
      } else if (['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].includes(word.toUpperCase())) {
        out.push({ t: 'fn', name: word.toUpperCase() })
      } else {
        const m = new RegExp(`^${word}([0-9]+)`).exec(src.slice(i))
        if (!m) return null
        const col = refCol(word.toUpperCase())
        const row = Number(m[1]) - 1
        // range ref: A1:A3
        const range = /^:([A-Za-z]+)([0-9]+)/.exec(src.slice(i + m[0].length))
        if (range) {
          out.push({
            t: 'range',
            c1: col,
            r1: row,
            c2: refCol(range[1]!.toUpperCase()),
            r2: Number(range[2]) - 1,
          })
          i += m[0].length + range[0].length
          continue
        }
        out.push({ t: 'ref', col, row })
        i += m[0].length
        continue
      }
      i += word.length
      continue
    }
    if ('+-*/'.includes(ch)) {
      out.push({ t: 'op', v: ch })
      i++
      continue
    }
    if (ch === '(') {
      out.push({ t: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      out.push({ t: 'rparen' })
      i++
      continue
    }
    return null
  }
  return out
}

function collectDirection(
  grid: FormulaGrid,
  cursor: FormulaCursor,
  dir: string,
): number[] {
  const vals: number[] = []
  const stepR = dir === 'ABOVE' ? -1 : dir === 'BELOW' ? 1 : 0
  const stepC = dir === 'LEFT' ? -1 : dir === 'RIGHT' ? 1 : 0
  let r = cursor.row + stepR
  let c = cursor.col + stepC
  while (r >= 0 && r < grid.rows.length) {
    const line = grid.rows[r] ?? []
    if (c < 0 || c >= line.length) break
    const text = (line[c] ?? '').trim()
    if (text === '') break // Word: stop at the first blank cell
    const n = numericOf(text)
    if (n !== null) vals.push(n)
    r += stepR
    c += stepC
  }
  return vals
}

function collectRange(grid: FormulaGrid, r1: number, c1: number, r2: number, c2: number): number[] {
  const vals: number[] = []
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    const line = grid.rows[r] ?? []
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const n = numericOf((line[c] ?? '').trim())
      if (n !== null) vals.push(n)
    }
  }
  return vals
}

/** Word-style numeric mask: thousands separator, fixed decimals, percent */
export function formatMask(value: number, mask?: string): string {
  if (!mask) {
    // Word's General: drop trailing zeros, keep up to a few decimals
    return String(Math.round(value * 1e6) / 1e6)
  }
  const percent = mask.includes('%')
  let v = percent ? value * 100 : value
  const decimals = mask.includes('.') ? (mask.split('.')[1] ?? '').match(/0/g)?.length ?? 0 : 0
  const grouped = mask.includes(',')
  const fixed = Math.abs(v).toFixed(decimals)
  let body = fixed
  if (grouped) {
    const [int, dec] = fixed.split('.')
    body = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? `.${dec}` : '')
  }
  return (v < 0 ? '-' : '') + body + (percent ? '%' : '')
}

class Parser {
  private pos = 0
  constructor(
    private tokens: Tokens,
    private grid: FormulaGrid,
    private cursor: FormulaCursor,
  ) {}

  peek(): Tokens[number] | undefined {
    return this.tokens[this.pos]
  }

  next(): Tokens[number] | undefined {
    return this.tokens[this.pos++]
  }

  expr(): number | null {
    const first = this.term()
    if (first === null) return null
    let acc = first
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next()
        const rhs = this.term()
        if (rhs === null) return null
        acc = t.v === '+' ? acc + rhs : acc - rhs
      } else return acc
    }
  }

  term(): number | null {
    const first = this.factor()
    if (first === null) return null
    let acc = first
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        this.next()
        const rhs = this.factor()
        if (rhs === null) return null
        if (t.v === '/' && rhs === 0) throw new Error('division by zero')
        acc = t.v === '*' ? acc * rhs : acc / rhs
      } else return acc
    }
  }

  factor(): number | null {
    const t = this.next()
    if (!t) return null
    if (t.t === 'num') return t.v
    if (t.t === 'op' && t.v === '-') {
      const v = this.factor()
      return v === null ? null : -v
    }
    if (t.t === 'ref') {
      const line = this.grid.rows[t.row] ?? []
      return numericOf((line[t.col] ?? '').trim())
    }
    if (t.t === 'range') {
      const vals = collectRange(this.grid, t.r1, t.c1, t.r2, t.c2)
      return vals.reduce((a, b) => a + b, 0)
    }
    if (t.t === 'fn') {
      const open = this.next()
      if (!open || open.t !== 'lparen') return null
      const arg = this.next()
      if (!arg) return null
      let vals: number[]
      if (arg.t === 'dir') {
        vals = collectDirection(this.grid, this.cursor, arg.name)
      } else if (arg.t === 'ref' || arg.t === 'range') {
        // re-tokenize handled inline: reparse single ref/range is already typed
        vals =
          arg.t === 'ref'
            ? ([numericOf((this.grid.rows[arg.row]?.[arg.col] ?? '').trim())].filter(
                (n): n is number => n !== null,
              ))
            : collectRange(this.grid, arg.r1, arg.c1, arg.r2, arg.c2)
      } else if (arg.t === 'num') {
        vals = [arg.v]
      } else return null
      const close = this.next()
      if (!close || close.t !== 'rparen') return null
      if (t.name === 'COUNT') return vals.length
      if (vals.length === 0) throw new Error('no values')
      if (t.name === 'SUM') return vals.reduce((a, b) => a + b, 0)
      if (t.name === 'AVERAGE') return vals.reduce((a, b) => a + b, 0) / vals.length
      if (t.name === 'MAX') return Math.max(...vals)
      if (t.name === 'MIN') return Math.min(...vals)
      return null
    }
    if (t.t === 'lparen') {
      const v = this.expr()
      const close = this.next()
      if (!close || close.t !== 'rparen') return null
      return v
    }
    return null
  }
}

export function evaluateTableFormula(
  instr: string,
  grid: FormulaGrid,
  cursor: FormulaCursor,
): FormulaResult {
  let src = instr.trim()
  if (!src.startsWith('=')) return { ok: false, error: 'formula must start with =' }
  src = src.slice(1)
  // Word mask suffix: \# "#,##0.00"
  let mask: string | undefined
  const maskMatch = /\\\#\s*"([^"]*)"/.exec(src)
  if (maskMatch) {
    mask = maskMatch[1]
    src = src.slice(0, maskMatch.index) + src.slice(maskMatch.index + maskMatch[0].length)
  }
  const tokens = tokenize(src)
  if (!tokens || tokens.length === 0) return { ok: false, error: 'cannot parse formula' }
  try {
    const parser = new Parser(tokens, grid, cursor)
    const value = parser.expr()
    if (value === null || parser.peek() !== undefined) {
      return { ok: false, error: 'cannot parse formula' }
    }
    if (!Number.isFinite(value)) return { ok: false, error: 'not a finite number' }
    return { ok: true, value, formatted: formatMask(value, mask) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type RecalcResult = 'ok' | 'no-table'

/**
 * Recalculate every cell in the cursor's table whose text starts with "=" and
 * write the formatted result in place. Formula cells read as blank while
 * evaluating others (so SUM(ABOVE) does not ingest another formula's text).
 * One transaction = one undo step.
 */
export function recalcTableFormulas(editor: Editor): RecalcResult {
  const found = findTableAtSelection(editor)
  if (!found) return 'no-table'
  const { table, pos } = found
  const grid: string[][] = []
  table.forEach((tr) => {
    const line: string[] = []
    tr.forEach((td) => line.push(td.textContent.trim()))
    grid.push(line)
  })
  // formula cells read as blank while evaluating the grid, so SUM(ABOVE)
  // never ingests another formula's text
  const evalGrid: FormulaGrid = {
    rows: grid.map((l) => l.map((t) => (t.startsWith('=') ? '' : t))),
  }
  // locate each formula cell's position in the original doc
  const targets: Array<{ pos: number; size: number; result: string }> = []
  let rowPos = pos + 1
  grid.forEach((_line, r) => {
    const rowNode = table.child(r)
    let cellPos = rowPos + 1
    rowNode.forEach((cell, _offset, ci) => {
      const text = cell.textContent.trim()
      if (text.startsWith('=')) {
        const res = evaluateTableFormula(text, evalGrid, { row: r, col: ci })
        // replace the cell's CONTENT (paragraphs), not the cell node itself
        if (res.ok) targets.push({ pos: cellPos + 1, size: cell.content.size, result: res.formatted })
      }
      cellPos += cell.nodeSize
    })
    rowPos += rowNode.nodeSize
  })
  if (targets.length === 0) return 'ok'
  const tr = editor.state.tr
  // descending order keeps earlier positions valid without mapping
  for (const t of targets.slice().sort((a, b) => b.pos - a.pos)) {
    const para = editor.state.schema.nodes.docParagraph.create(
      null,
      t.result ? [editor.state.schema.text(t.result)] : [],
    )
    tr.replaceWith(t.pos, t.pos + t.size, para)
  }
  editor.view.dispatch(tr)
  return 'ok'
}
