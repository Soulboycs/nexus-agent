import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useI18n } from '../i18n/locale'
import {
  applyFormatReplace,
  filterRangesByFormat,
  findFormatRanges,
  isEmptyFormat,
  type FindFormat,
} from '../editor/format-find'
import { searchPluginKey } from '../editor/extensions'

import {
  parseWordSearchPattern,
  resolveReplacementString,
} from '../editor/find-replace-tokens'

interface Range {
  from: number
  to: number
}

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
  useWildcards?: boolean
}

/** length-preserving lowercase: chars whose lowercase grows ('İ' → 'i̇') stay as-is so match offsets never shift */
export function foldCase(s: string): string {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/** collect matches inside editable textblocks (protected blocks excluded) supporting Word special tokens and wildcards */
export function findMatches(editor: Editor, query: string, opts: FindOptions): Range[] {
  const found: Range[] = []
  if (!query) return found

  const { regex } = parseWordSearchPattern(query, opts)

  let docText = ''
  const posAt: number[] = []

  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        for (let k = 0; k < child.text.length; k++) {
          posAt.push(pos + 1 + offset + k)
        }
        docText += child.text
      } else if (child.type.name === 'hardBreak') {
        posAt.push(pos + 1 + offset)
        docText += child.attrs?.pageBreak ? '\f' : '\v'
      } else {
        posAt.push(pos + 1 + offset)
        docText += '\u0000'
      }
    })
    // End of paragraph mark (^p)
    posAt.push(pos + node.nodeSize - 1)
    docText += '\n'
    return false
  })

  if (posAt.length === 0) return found

  for (const match of docText.matchAll(regex)) {
    const startIdx = match.index
    if (startIdx === undefined) continue
    const matchedLen = match[0].length
    if (matchedLen === 0) continue
    const endIdx = startIdx + matchedLen - 1
    if (endIdx < posAt.length) {
      found.push({
        from: posAt[startIdx],
        to: posAt[endIdx] + 1,
      })
    }
  }

  return found
}

interface FindPanelProps {
  editor: Editor
  onClose: () => void
  /** Ctrl+F / menu Find bump this to put focus back in the find field while the panel is already open */
  focusFindNonce?: number
  /** Ctrl+H bumps this to land focus on the replace field (falls back to find when read-only) */
  focusReplaceNonce?: number
}

const SCAN_DEBOUNCE_MS = 150

export function FindPanel({ editor, onClose, focusFindNonce, focusReplaceNonce }: FindPanelProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useWildcards, setUseWildcards] = useState(false)
  // format find & replace (Word: 更多 → 格式); {} = wildcard / no format action
  const [findFmt, setFindFmt] = useState<FindFormat>({})
  const [replFmt, setReplFmt] = useState<FindFormat>({})
  const [showFmt, setShowFmt] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const indexRef = useRef(0)
  const canEdit = editor.isEditable

  const highlight = useCallback(
    (ranges: Range[], activeIndex: number) => {
      editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { ranges, activeIndex }))
    },
    [editor],
  )

  const scrollTo = useCallback(
    (range: Range) => {
      const { node } = editor.view.domAtPos(range.from)
      const el = node instanceof HTMLElement ? node : node.parentElement
      el?.scrollIntoView({ block: 'center' })
    },
    [editor],
  )

  // rescan only updates matches/highlight; scrolling happens on explicit navigation
  const refresh = useCallback(
    (q: string, keepIndex = 0, opts?: Partial<FindOptions>) => {
      const base = findMatches(editor, q, { matchCase, wholeWord, useWildcards, ...opts })
      const ranges = isEmptyFormat(findFmt)
        ? base
        : q
          ? filterRangesByFormat(editor, base, findFmt)
          : findFormatRanges(editor, findFmt)
      const active = ranges.length === 0 ? 0 : Math.min(keepIndex, ranges.length - 1)
      setMatches(ranges)
      setIndex(active)
      indexRef.current = active
      highlight(ranges, active)
      return ranges
    },
    [editor, highlight, matchCase, wholeWord, useWildcards, findFmt],
  )

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const timerRef = useRef<number | null>(null)
  const pendingKeepRef = useRef<'reset' | 'current'>('reset')
  const scheduleRefresh = useCallback((q: string, keep: 'reset' | 'current' = 'reset') => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    pendingKeepRef.current = keep
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      refreshRef.current(q, keep === 'current' ? indexRef.current : 0)
    }, SCAN_DEBOUNCE_MS)
  }, [])
  /** run a pending debounced scan now (Enter right after typing must see fresh matches) */
  const flushPending = useCallback(
    (q: string) => {
      if (timerRef.current === null) return null
      window.clearTimeout(timerRef.current)
      timerRef.current = null
      const keep = pendingKeepRef.current
      return {
        ranges: refresh(q, keep === 'current' ? indexRef.current : 0),
        queryChanged: keep === 'reset',
      }
    },
    [refresh],
  )

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!focusFindNonce) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusFindNonce])

  // declared after the mount effect so opening straight into replace wins the focus
  useEffect(() => {
    if (!focusReplaceNonce) return
    const el = replaceInputRef.current ?? inputRef.current
    el?.focus()
    el?.select()
  }, [focusReplaceNonce])

  // stay in sync while the document changes underneath (typing, AI edits).
  // The listener reads the query through a ref: between a keystroke in the find
  // box and the next render, the effect closure still holds the previous query
  // and would overwrite the pending scan for the new needle with stale text.
  const queryRef = useRef(query)
  queryRef.current = query
  useEffect(() => {
    const onUpdate = () => {
      if (queryRef.current) scheduleRefresh(queryRef.current, 'current')
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, scheduleRefresh])

  const close = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    highlight([], 0)
    onClose()
  }, [highlight, onClose])

  const step = useCallback(
    (dir: 1 | -1) => {
      const fresh = flushPending(query)
      const ranges = fresh ? fresh.ranges : matches
      if (ranges.length === 0) return
      // A flushed scan for a new query already landed on the first match — Enter should
      // visit it, not skip past it. A keep-current refresh (document changed underneath)
      // must still move in the requested direction from the refreshed position.
      const next = fresh?.queryChanged
        ? indexRef.current
        : ((fresh ? indexRef.current : index) + dir + ranges.length) % ranges.length
      setIndex(next)
      indexRef.current = next
      highlight(ranges, next)
      scrollTo(ranges[next])
    },
    [flushPending, query, matches, index, highlight, scrollTo],
  )

  const replaceOne = useCallback(() => {
    if (!editor.isEditable) return
    // a pending debounced rescan means `matches` may describe the previous
    // query or pre-edit positions — replacing those would edit the wrong text
    const fresh = flushPending(query)
    const ranges = fresh ? fresh.ranges : matches
    const at = fresh ? indexRef.current : index
    const m = ranges[at]
    if (!m) return

    // format-only replace (empty query + find format): restyle the match
    if (!query && !isEmptyFormat(findFmt)) {
      if (!isEmptyFormat(replFmt)) applyFormatReplace(editor, [m], replFmt)
      const after = refresh(query, at)
      if (after.length > 0) scrollTo(after[Math.min(at, after.length - 1)])
      return
    }

    const matchedText = editor.state.doc.textBetween(m.from, m.to, '\n', '\n')
    // format-only replace across every match
    if (!query && !isEmptyFormat(findFmt)) {
      applyFormatReplace(editor, ranges, replFmt)
      refresh(query)
      return
    }

    const { regex } = parseWordSearchPattern(query, { matchCase, wholeWord, useWildcards })
    const execMatch = regex.exec(matchedText)
    const groups = execMatch ? Array.from(execMatch).slice(1) : []
    const resolved = resolveReplacementString(replacement, matchedText, groups)

    if (resolved.includes('\n')) {
      const lines = resolved.replace(/\r/g, '').split('\n')
      editor
        .chain()
        .focus()
        .setTextSelection({ from: m.from, to: m.to })
        .insertContent(
          lines.map((line) => ({
            type: 'docParagraph',
            ...(line ? { content: [{ type: 'text', text: line }] } : {}),
          })),
        )
        .run()
    } else {
      editor.commands.command(({ tr }) => {
        tr.insertText(resolved, m.from, m.to)
        return true
      })
      if (!isEmptyFormat(replFmt))
        applyFormatReplace(editor, [{ from: m.from, to: m.from + resolved.length }], replFmt)
    }
    const after = refresh(query, at)
    if (after.length > 0) scrollTo(after[Math.min(at, after.length - 1)])
  }, [editor, flushPending, matches, index, replacement, query, refresh, scrollTo, matchCase, wholeWord, useWildcards])

  const replaceAll = useCallback(() => {
    if (!editor.isEditable) return
    const fresh = flushPending(query)
    const ranges = fresh ? fresh.ranges : matches
    if (ranges.length === 0) return

    const { regex } = parseWordSearchPattern(query, { matchCase, wholeWord, useWildcards })
    const hasNewline = replacement.includes('^p') || replacement.includes('\n')

    if (hasNewline) {
      for (const m of [...ranges].reverse()) {
        const matchedText = editor.state.doc.textBetween(m.from, m.to, '\n', '\n')
        const execMatch = regex.exec(matchedText)
        const groups = execMatch ? Array.from(execMatch).slice(1) : []
        const resolved = resolveReplacementString(replacement, matchedText, groups)
        const lines = resolved.replace(/\r/g, '').split('\n')
        editor
          .chain()
          .setTextSelection({ from: m.from, to: m.to })
          .insertContent(
            lines.map((line) => ({
              type: 'docParagraph',
              ...(line ? { content: [{ type: 'text', text: line }] } : {}),
            })),
          )
          .run()
      }
    } else {
      editor.commands.command(({ tr }) => {
        for (const m of [...ranges].reverse()) {
          const matchedText = tr.doc.textBetween(m.from, m.to, '\n', '\n')
          const execMatch = regex.exec(matchedText)
          const groups = execMatch ? Array.from(execMatch).slice(1) : []
          const resolved = resolveReplacementString(replacement, matchedText, groups)
          tr.insertText(resolved, m.from, m.to)
        }
        return true
      })
    }
    if (!isEmptyFormat(replFmt)) {
      const baseRanges = fresh ? fresh.ranges : matches
      applyFormatReplace(
        editor,
        baseRanges.map((m) => ({ from: m.from, to: m.from + (m.to - m.from) })),
        replFmt,
      )
    }
    refresh(query)
  }, [editor, flushPending, matches, replacement, query, refresh, matchCase, wholeWord, useWildcards, findFmt, replFmt])

  return (
    <div className="find-panel">
      {showFmt && (
        <div className="find-fmt-pop">
          <div className="find-fmt-head">{t('appFindFormatTitle')}</div>
          <FmtRow fmt={findFmt} onChange={setFindFmt} />
          <div className="find-fmt-head">{t('appReplaceFormatTitle')}</div>
          <FmtRow fmt={replFmt} onChange={setReplFmt} />
          <button
            className="find-fmt-clear"
            onClick={() => {
              setFindFmt({})
              setReplFmt({})
            }}
          >
            {t('appFindFormatClear')}
          </button>
        </div>
      )}
      <div className="find-row">
        <input
          ref={inputRef}
          className="find-input"
          placeholder={t('appFindPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            queryRef.current = e.target.value
            scheduleRefresh(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
            if (e.key === 'Escape') close()
          }}
        />
        <button
          className={`find-opt ${matchCase ? 'on' : ''}`}
          data-tip={t('appMatchCase')}
          onClick={() => {
            setMatchCase(!matchCase)
            refresh(query, index, { matchCase: !matchCase })
          }}
        >
          Aa
        </button>
        <button
          className={`find-opt ${wholeWord ? 'on' : ''}`}
          data-tip={t('appWholeWord')}
          onClick={() => {
            setWholeWord(!wholeWord)
            refresh(query, index, { wholeWord: !wholeWord })
          }}
        >
          W
        </button>
        <button
          className={`find-opt ${useWildcards ? 'on' : ''}`}
          data-tip={t('appUseWildcards')}
          onClick={() => {
            setUseWildcards(!useWildcards)
            refresh(query, index, { useWildcards: !useWildcards })
          }}
        >
          .*
        </button>
        <button
          className={`find-opt ${showFmt ? 'on' : ''}`}
          data-tip={t('appFindFormat')}
          onClick={() => setShowFmt((v) => !v)}
        >
          {t('appFindFormat')}
        </button>
        <span className="find-count">
          {query
            ? matches.length === 0
              ? t('appNoResults')
              : `${index + 1}/${matches.length}`
            : ''}
        </span>
        <button
          className="find-btn"
          data-tip={t('appPrevMatch')}
          aria-label={t('appPrevMatch')}
          onClick={() => step(-1)}
          disabled={matches.length === 0}
        >
          ‹
        </button>
        <button
          className="find-btn"
          data-tip={t('appNextMatch')}
          aria-label={t('appNextMatch')}
          onClick={() => step(1)}
          disabled={matches.length === 0}
        >
          ›
        </button>
        <button
          className="find-btn find-close"
          data-tip={t('appCloseEsc')}
          aria-label={t('appCloseEsc')}
          onClick={close}
        >
          ✕
        </button>
      </div>
      {canEdit && (
        <div className="find-row">
          <input
            ref={replaceInputRef}
            className="find-input"
            placeholder={t('appReplacePlaceholder')}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') replaceOne()
              if (e.key === 'Escape') close()
            }}
          />
          <button className="find-action" onClick={replaceOne} disabled={matches.length === 0}>
            {t('appReplace')}
          </button>
          <button className="find-action" onClick={replaceAll} disabled={matches.length === 0}>
            {t('appReplaceAll')}
          </button>
        </div>
      )}
    </div>
  )
}


/** one format row: font / size (pt) / color / B / I; empty = wildcard */
function FmtRow({
  fmt,
  onChange,
}: {
  fmt: FindFormat
  onChange: (f: FindFormat) => void
}) {
  const { t } = useI18n()
  const boldState = fmt.bold == null ? null : fmt.bold
  const italicState = fmt.italic == null ? null : fmt.italic
  return (
    <div className="find-fmt-row">
      <input
        className="find-fmt-font"
        placeholder={t('appFindFormatAnyFont')}
        value={fmt.font ?? ''}
        onChange={(e) => onChange({ ...fmt, font: e.target.value || null })}
      />
      <input
        className="find-fmt-size"
        type="number"
        min={1}
        max={1638}
        step={0.5}
        placeholder="pt"
        title={t('appFindFormatSize')}
        value={fmt.sizeHalfPoints != null ? fmt.sizeHalfPoints / 2 : ''}
        onChange={(e) => {
          const pt = Number(e.target.value)
          onChange({ ...fmt, sizeHalfPoints: pt > 0 ? Math.round(pt * 2) : null })
        }}
      />
      <input
        className="find-fmt-color"
        type="color"
        title={t('appFindFormatColor')}
        value={`#${(fmt.color ?? '000000').replace('#', '')}`}
        onChange={(e) => onChange({ ...fmt, color: e.target.value.slice(1) || null })}
      />
      <button
        className={`find-opt ${boldState === true ? 'on' : boldState === false ? 'off' : ''}`}
        data-tip={t('appFindFormatBold')}
        onClick={() =>
          onChange({ ...fmt, bold: boldState === null ? true : boldState === true ? false : null })
        }
      >
        <b>B</b>
      </button>
      <button
        className={`find-opt ${italicState === true ? 'on' : italicState === false ? 'off' : ''}`}
        data-tip={t('appFindFormatItalic')}
        onClick={() =>
          onChange({
            ...fmt,
            italic: italicState === null ? true : italicState === true ? false : null,
          })
        }
      >
        <i>I</i>
      </button>
    </div>
  )
}
