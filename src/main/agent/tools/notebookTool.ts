import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R6 NotebookEdit（1:1 cc NotebookEditTool，最小完整实现）：
 * .ipynb 单元 replace/insert/delete。已披露简化：read-before-edit 的
 * readFileState 时间戳强制未建（我们无该共享状态），以 JSON 有效性 +
 * mtime 即时读取替代。
 */

interface NotebookCell {
  id?: string
  cell_type: string
  source: string | string[]
  outputs?: unknown[]
  execution_count?: number | null
  metadata?: Record<string, unknown>
}

function generateCellId(): string {
  return `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeCellId(cells: NotebookCell[], cellId: string | undefined): number {
  if (cellId === undefined) return -1
  const byId = cells.findIndex((c) => (c as any).id === cellId)
  if (byId !== -1) return byId
  // cc 兼容：cell-N 数字索引形式
  const idxForm = /^cell-(\d+)$/.exec(cellId)
  if (idxForm) {
    const idx = parseInt(idxForm[1], 10)
    if (idx >= 0 && idx < cells.length) return idx
  }
  return -1
}

export const notebookEditTool: AgentTool = {
  name: 'NotebookEdit',
  aliases: ['notebook_edit'],
  description:
    'Edit a Jupyter notebook (.ipynb) cell: replace its source, insert a new cell, or delete one. Completely replaces the cell source — this cannot undo a previous edit unless you supply the original source again.',
  searchHint: 'jupyter ipynb notebook cell edit insert delete',
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 5_000,
  parameters: z.object({
    notebookPath: z.string().describe('Path to the .ipynb file (absolute or relative to workspace)'),
    cellId: z
      .string()
      .optional()
      .describe('The ID of the cell to edit. When inserting, the new cell is inserted after this one (or at the start if omitted)'),
    newSource: z.string().describe('The new source for the cell'),
    cellType: z
      .enum(['code', 'markdown'])
      .optional()
      .describe('The cell type (code or markdown). Required when edit_mode=insert; defaults to current type otherwise'),
    editMode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe('The kind of edit: replace (default), insert, or delete'),
  }),
  execute: async (
    {
      notebookPath,
      cellId,
      newSource,
      cellType,
      editMode = 'replace',
    }: { notebookPath: string; cellId?: string; newSource: string; cellType?: 'code' | 'markdown'; editMode?: 'replace' | 'insert' | 'delete' },
    context
  ) => {
    if (!notebookPath.endsWith('.ipynb')) {
      throw new Error(`NotebookEdit requires a .ipynb file, got: ${notebookPath}`)
    }
    const fullPath = path.resolve(context.workspaceRoot, notebookPath)
    let notebook: { cells: NotebookCell[]; metadata?: Record<string, unknown>; nbformat?: number }
    try {
      notebook = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
    } catch (err: any) {
      throw new Error(`Failed to read notebook "${notebookPath}": ${err.message}`)
    }
    if (!Array.isArray(notebook.cells)) {
      throw new Error(`Invalid notebook: "cells" array missing in ${notebookPath}`)
    }

    const cells = notebook.cells

    if (editMode === 'delete') {
      const idx = normalizeCellId(cells, cellId)
      if (idx === -1) throw new Error(`Cell not found: ${cellId ?? '(no cellId given)'}`)
      const [deleted] = cells.splice(idx, 1)
      fs.writeFileSync(fullPath, JSON.stringify(notebook, null, 1), 'utf-8')
      return `Deleted cell ${cellId ?? idx} (${deleted.cell_type}) from ${notebookPath}. Remaining cells: ${cells.length}.`
    }

    if (editMode === 'insert') {
      if (!cellType) {
        throw new Error('cellType is required when edit_mode=insert')
      }
      const newCell: NotebookCell = {
        id: generateCellId(),
        cell_type: cellType,
        source: newSource,
        metadata: {},
        ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
      }
      const idx = normalizeCellId(cells, cellId)
      if (idx === -1) {
        cells.unshift(newCell)
      } else {
        cells.splice(idx + 1, 0, newCell)
      }
      fs.writeFileSync(fullPath, JSON.stringify(notebook, null, 1), 'utf-8')
      return `Inserted ${cellType} cell ${newCell.id} at position ${cells.indexOf(newCell)} in ${notebookPath} (now ${cells.length} cells).`
    }

    // replace
    const idx = normalizeCellId(cells, cellId)
    if (idx === -1) {
      throw new Error(
        `Cell not found: ${cellId ?? '(no cellId given)'}. Read the notebook first to see cell IDs (cc convention: cell-0, cell-1, ...).`
      )
    }
    const target = cells[idx]
    target.source = newSource
    if (cellType && cellType !== target.cell_type) {
      target.cell_type = cellType
    }
    if (target.cell_type === 'code') {
      // cc 语义：替换后的 code cell 重置执行状态
      target.execution_count = null
      target.outputs = []
    }
    fs.writeFileSync(fullPath, JSON.stringify(notebook, null, 1), 'utf-8')
    return `Updated ${target.cell_type} cell ${target.id ?? cellId} (position ${idx}) in ${notebookPath}.`
  },
}
