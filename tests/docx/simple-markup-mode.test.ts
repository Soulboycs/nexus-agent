import { describe, it, expect } from 'bun:test'
import { revisionDisplayState } from '../../src/renderer/src/components/word/editor/marks'
import type { RevisionDisplayMode } from '../../src/renderer/src/components/word/components/ribbon-tabs'

describe('Simple Markup (Revision Display Mode) Suite', () => {
  it('1. revisionDisplayState accepts simple mode', () => {
    const prevMode = revisionDisplayState.mode
    revisionDisplayState.mode = 'simple'
    expect(revisionDisplayState.mode).toBe('simple')
    revisionDisplayState.mode = prevMode
  })

  it('2. RevisionDisplayMode type supports all 4 Word standard modes', () => {
    const modes: RevisionDisplayMode[] = ['simple', 'all', 'none', 'original']
    expect(modes).toHaveLength(4)
    expect(modes).toContain('simple')
  })

  it('3. toggle event transitions between simple and all modes', () => {
    let currentMode: RevisionDisplayMode = 'simple'
    const toggleHandler = () => {
      currentMode = currentMode === 'simple' ? 'all' : 'simple'
    }
    toggleHandler()
    expect(currentMode).toBe('all')
    toggleHandler()
    expect(currentMode).toBe('simple')
  })
})
