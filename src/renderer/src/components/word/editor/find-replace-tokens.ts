/**
 * Word-compatible Find & Replace special tokens and wildcard engine.
 *
 * Special codes (Find):
 *   ^p - Paragraph mark (\n)
 *   ^t - Tab character (\t)
 *   ^l - Manual line break (\v or \n)
 *   ^m - Manual page break (\f)
 *   ^^ - Caret character (^)
 *   ^w - White space (any sequence of space, tab, non-breaking space)
 *   ^# - Any digit (0-9)
 *   ^$ - Any letter (a-zA-Z)
 *   ^? - Any single character
 *   ^s - Non-breaking space (\u00A0)
 *   ^- - Optional hyphen (\u00AD)
 *   ^~ - Non-breaking hyphen (\u2011)
 *
 * Wildcards mode (Word "Use Wildcards" syntax):
 *   ?      - Any single character
 *   *      - Any string of characters
 *   <      - Beginning of a word
 *   >      - End of a word
 *   @      - 1 or more occurrences of previous character/group
 *   [!...] - Not characters in set (maps to [^...])
 *   {n}    - Exactly n occurrences
 *   {n,}   - At least n occurrences
 *   {n,m}  - Between n and m occurrences
 *   (...)  - Grouping (accessible in replacement via \1, \2, etc.)
 *
 * Special codes (Replace):
 *   ^& - Matched text (Find What text)
 *   ^p - Paragraph mark (\n)
 *   ^t - Tab character (\t)
 *   ^l - Manual line break (\v)
 *   ^m - Manual page break (\f)
 *   ^^ - Caret character (^)
 *   \1..\9 - Captured groups
 */

export interface WordFindOptions {
  matchCase?: boolean
  wholeWord?: boolean
  useWildcards?: boolean
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a Word find query into a JavaScript RegExp.
 */
export function parseWordSearchPattern(
  query: string,
  options: WordFindOptions = {},
): { regex: RegExp; hasTokens: boolean } {
  if (!query) {
    return { regex: /(?:)/g, hasTokens: false }
  }

  const { matchCase = false, wholeWord = false, useWildcards = false } = options
  let hasTokens = false
  let pattern = ''

  if (useWildcards) {
    // Word Wildcard Mode
    hasTokens = true
    let i = 0
    while (i < query.length) {
      const ch = query[i]

      // Caret special tokens
      if (ch === '^' && i + 1 < query.length) {
        const next = query[i + 1]
        if (next === 'p') {
          pattern += '(?:\\r?\\n|\\u2029)'
          i += 2
          continue
        } else if (next === 't') {
          pattern += '\\t'
          i += 2
          continue
        } else if (next === 'l') {
          pattern += '[\\v\\n]'
          i += 2
          continue
        } else if (next === 'm') {
          pattern += '\\f'
          i += 2
          continue
        } else if (next === '^') {
          pattern += '\\^'
          i += 2
          continue
        } else if (next === 's') {
          pattern += '\\u00A0'
          i += 2
          continue
        } else if (next === '-') {
          pattern += '\\u00AD'
          i += 2
          continue
        } else if (next === '~') {
          pattern += '\\u2011'
          i += 2
          continue
        }
      }

      // Escaped character in wildcards e.g. \?, \*, \<, \>, \@
      if (ch === '\\' && i + 1 < query.length) {
        pattern += escapeRegexLiteral(query[i + 1])
        i += 2
        continue
      }

      // Word wildcard: < (start of word)
      if (ch === '<') {
        pattern += '(?:^|(?<![\\p{L}\\p{N}_]))'
        i += 1
        continue
      }

      // Word wildcard: > (end of word)
      if (ch === '>') {
        pattern += '(?=$|(?![\\p{L}\\p{N}_]))'
        i += 1
        continue
      }

      // Word wildcard: @ (1 or more occurrences of preceding item)
      if (ch === '@') {
        pattern += '+'
        i += 1
        continue
      }

      // Word wildcard: ? (single char)
      if (ch === '?') {
        pattern += '.'
        i += 1
        continue
      }

      // Word wildcard: * (zero or more characters non-greedy)
      if (ch === '*') {
        pattern += '.*?'
        i += 1
        continue
      }

      // Word wildcard: [!... ] (negated character class)
      if (ch === '[' && query[i + 1] === '!') {
        pattern += '[^'
        i += 2
        continue
      }

      // Character class or grouping or repetitions
      if (ch === '[' || ch === ']' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
        pattern += ch
        i += 1
        continue
      }

      // Other regex metacharacters that are NOT Word wildcards must be escaped
      if (/[.+^$|\\,]/.test(ch)) {
        pattern += '\\' + ch
        i += 1
        continue
      }

      pattern += escapeRegexLiteral(ch)
      i += 1
    }
  } else {
    // Normal Mode with Word caret codes
    let i = 0
    while (i < query.length) {
      const ch = query[i]
      if (ch === '^' && i + 1 < query.length) {
        hasTokens = true
        const next = query[i + 1]
        if (next === 'p') {
          pattern += '(?:\\r?\\n|\\u2029)'
          i += 2
          continue
        } else if (next === 't') {
          pattern += '\\t'
          i += 2
          continue
        } else if (next === 'l') {
          pattern += '[\\v\\n]'
          i += 2
          continue
        } else if (next === 'm') {
          pattern += '\\f'
          i += 2
          continue
        } else if (next === '^') {
          pattern += '\\^'
          i += 2
          continue
        } else if (next === 'w') {
          pattern += '[ \\t\\r\\n\\u00A0\\u3000]+'
          i += 2
          continue
        } else if (next === '#') {
          pattern += '[0-9]'
          i += 2
          continue
        } else if (next === '$') {
          pattern += '[a-zA-Z]'
          i += 2
          continue
        } else if (next === '?') {
          pattern += '.'
          i += 2
          continue
        } else if (next === 's') {
          pattern += '\\u00A0'
          i += 2
          continue
        } else if (next === '-') {
          pattern += '\\u00AD'
          i += 2
          continue
        } else if (next === '~') {
          pattern += '\\u2011'
          i += 2
          continue
        }
      }

      pattern += escapeRegexLiteral(ch)
      i += 1
    }

    if (wholeWord) {
      pattern = `(?:^|(?<![\\p{L}\\p{N}_]))(?:${pattern})(?=$|(?![\\p{L}\\p{N}_]))`
    }
  }

  const flags = 'g' + (matchCase ? 'u' : 'iu')
  try {
    return { regex: new RegExp(pattern, flags), hasTokens }
  } catch {
    // Fallback on regex parse failure to safe literal search
    return { regex: new RegExp(escapeRegexLiteral(query), flags), hasTokens: false }
  }
}

/**
 * Resolve Word replacement syntax (including ^&, ^p, ^t, ^l, ^m, ^^, \1..\9).
 */
export function resolveReplacementString(
  template: string,
  matchedText: string,
  groups: string[] = [],
): string {
  let result = ''
  let i = 0

  while (i < template.length) {
    const ch = template[i]

    // Caret codes in replacement
    if (ch === '^' && i + 1 < template.length) {
      const next = template[i + 1]
      if (next === '&') {
        result += matchedText
        i += 2
        continue
      } else if (next === 'p') {
        result += '\n'
        i += 2
        continue
      } else if (next === 't') {
        result += '\t'
        i += 2
        continue
      } else if (next === 'l') {
        result += '\v'
        i += 2
        continue
      } else if (next === 'm') {
        result += '\f'
        i += 2
        continue
      } else if (next === '^') {
        result += '^'
        i += 2
        continue
      }
    }

    // Backreference \1 .. \9
    if (ch === '\\' && i + 1 < template.length && /[1-9]/.test(template[i + 1])) {
      const grpIdx = parseInt(template[i + 1], 10) - 1
      result += groups[grpIdx] ?? ''
      i += 2
      continue
    }

    result += ch
    i += 1
  }

  return result
}
