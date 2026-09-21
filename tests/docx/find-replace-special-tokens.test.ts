import { describe, it, expect } from 'bun:test'
import {
  parseWordSearchPattern,
  resolveReplacementString,
} from '../../src/renderer/src/components/word/editor/find-replace-tokens'

describe('Word Find & Replace Special Tokens and Wildcards Suite', () => {
  describe('1. Special Search Codes (Non-wildcard Mode)', () => {
    it('compiles ^p to match newlines and paragraph breaks', () => {
      const { regex, hasTokens } = parseWordSearchPattern('^p')
      expect(hasTokens).toBe(true)
      const text = 'First line\nSecond line\r\nThird line'
      const matches = [...text.matchAll(regex)].map((m) => m.index)
      expect(matches).toHaveLength(2)
      expect(matches[0]).toBe(10)
    })

    it('compiles ^t to match tabs', () => {
      const { regex, hasTokens } = parseWordSearchPattern('col1^tcol2')
      expect(hasTokens).toBe(true)
      const text = 'col1\tcol2 and col1 col2'
      const matches = [...text.matchAll(regex)]
      expect(matches).toHaveLength(1)
      expect(matches[0][0]).toBe('col1\tcol2')
    })

    it('compiles ^w to match arbitrary whitespace sequences', () => {
      const { regex, hasTokens } = parseWordSearchPattern('hello^wworld')
      expect(hasTokens).toBe(true)
      const text = 'hello   world and hello\t\tworld and hello world'
      const matches = [...text.matchAll(regex)]
      expect(matches).toHaveLength(3)
    })

    it('compiles ^# (digit) and ^$ (letter)', () => {
      const { regex } = parseWordSearchPattern('item^#^#')
      const text = 'item01 item02 itemA1 item999'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toEqual(['item01', 'item02', 'item99'])
    })

    it('compiles ^^ to match literal caret character', () => {
      const { regex } = parseWordSearchPattern('^^math')
      const text = '^math and ^^math'
      const matches = [...text.matchAll(regex)]
      expect(matches).toHaveLength(2)
      expect(matches[0][0]).toBe('^math')
    })

    it('escapes regular regex metacharacters in standard search', () => {
      const { regex } = parseWordSearchPattern('price is $10.00 (tax incl.)')
      const text = 'The price is $10.00 (tax incl.) right here.'
      const matches = [...text.matchAll(regex)]
      expect(matches).toHaveLength(1)
      expect(matches[0][0]).toBe('price is $10.00 (tax incl.)')
    })
  })

  describe('2. Wildcard Search Mode (Word Wildcards)', () => {
    it('matches single char (?) and string of chars (*)', () => {
      const { regex } = parseWordSearchPattern('<b?t>', { useWildcards: true })
      const text = 'bat bet bit bot but byte'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toEqual(['bat', 'bet', 'bit', 'bot', 'but'])
    })

    it('matches word boundaries with < and >', () => {
      const { regex } = parseWordSearchPattern('<in*e>', { useWildcards: true })
      const text = 'inside illuminate inside outside in line instance'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toContain('inside')
      expect(matches).toContain('instance')
      expect(matches).not.toContain('outside')
    })

    it('matches 1 or more occurrences with @', () => {
      const { regex } = parseWordSearchPattern('lo@k', { useWildcards: true })
      const text = 'lk look loook loooook'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toEqual(['look', 'loook', 'loooook'])
    })

    it('matches negative character class [!...]', () => {
      const { regex } = parseWordSearchPattern('t[!ae]st', { useWildcards: true })
      const text = 'tast test tist tost'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toEqual(['tist', 'tost'])
    })

    it('supports caret tokens inside wildcard search', () => {
      const { regex } = parseWordSearchPattern('<[0-9]@>^t<[A-Z]@>', { useWildcards: true })
      const text = '123\tABC\n456\tDEF\n789 XYZ'
      const matches = [...text.matchAll(regex)].map((m) => m[0])
      expect(matches).toEqual(['123\tABC', '456\tDEF'])
    })
  })

  describe('3. Word Replacement String Resolution', () => {
    it('expands ^& to the matched text', () => {
      const out = resolveReplacementString('[ ^& ]', 'Important')
      expect(out).toBe('[ Important ]')
    })

    it('expands ^p to newline and ^t to tab', () => {
      const out = resolveReplacementString('Title^pContent^tTabbed', 'match')
      expect(out).toBe('Title\nContent\tTabbed')
    })

    it('expands ^^ to literal caret', () => {
      const out = resolveReplacementString('^^2', 'squared')
      expect(out).toBe('^2')
    })

    it('expands capture groups with \\1 and \\2', () => {
      const out = resolveReplacementString('\\2, \\1', 'Smith John', ['John', 'Smith'])
      expect(out).toBe('Smith, John')
    })
  })

  describe('4. findMatches with Simulated ProseMirror Document', () => {
    it('finds ^p matching paragraph break between textblocks', () => {
      // Mock editor with 2 textblocks
      const fakeDoc = {
        descendants: (fn: (node: any, pos: number) => boolean | void) => {
          // Paragraph 1 at pos 0, size 7, text 'First'
          const p1 = {
            isTextblock: true,
            nodeSize: 7,
            forEach: (cb: (child: any, offset: number) => void) => {
              cb({ isText: true, text: 'First' }, 0)
            },
          }
          fn(p1, 0)
          // Paragraph 2 at pos 7, size 8, text 'Second'
          const p2 = {
            isTextblock: true,
            nodeSize: 8,
            forEach: (cb: (child: any, offset: number) => void) => {
              cb({ isText: true, text: 'Second' }, 0)
            },
          }
          fn(p2, 7)
        },
      }
      const fakeEditor = { state: { doc: fakeDoc } } as any

      const { findMatches } = require('../../src/renderer/src/components/word/components/FindPanel')
      const matches = findMatches(fakeEditor, 'First^pSecond', { matchCase: false, wholeWord: false })
      expect(matches).toHaveLength(1)
      expect(matches[0].from).toBe(1) // Start of 'First'
      expect(matches[0].to).toBe(14) // End of 'Second'
    })
  })
})
