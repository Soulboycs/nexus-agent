/**
 * Layout undo state shape. Layout edits (margins, orientation, paper size,
 * section settings) live in React state beside the ProseMirror document; the
 * unified undo itself lives in the editor's History plugin via a doc-attribute
 * mirror (see layout-undo-extension.ts) — every apply dispatches the
 * post-change snapshot as `tr.setDocAttribute('layoutUndo', snap)`, and undo /
 * redo replay previous values through the same restoration path, interleaved
 * chronologically with typing. Section-break insertion is itself a PM
 * transaction and stays in the editor's history directly.
 */
import type { SectionInfo, SectionSettings } from '@genoffice/docx-engine'

export interface LayoutSnapshot {
  section: SectionSettings | null
  sections: SectionInfo[]
  sectionDirty: boolean
  sectionsDirty: number[]
  pgNumEdit: { fmt?: string; start?: number } | null
  pgNumDirtySections: number[]
  titlePg: boolean
  titlePgDirty: boolean
}
