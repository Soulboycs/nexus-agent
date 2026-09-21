import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'
import {
  parseDocx,
  saveDocx,
  buildBlankDocx,
  generateParagraphXml,
  generateTableXml,
  patchTableCellTexts,
  type SaveBlock,
  type GenerateContext
} from '../../../packages/docx-engine'
import {
  notifyFocusWordDoc,
  notifyWordFileChanged,
  isDocsEditorReady,
  runDocsCommandForPath
} from '../../docx/docsBridge'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function resolvePath(filePath: string, workspaceRoot: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath)
  }
  return path.normalize(path.join(workspaceRoot, filePath))
}

const defaultCtx: GenerateContext = {
  headingStyleIds: new Map([
    [1, 'Heading1'],
    [2, 'Heading2'],
    [3, 'Heading3']
  ]),
  allocateHyperlinkRel: () => 'rId' + Math.floor(Math.random() * 1000)
}

/** 1. docx_read tool */
export const docxReadTool: AgentTool = {
  name: 'docx_read',
  description: (ctx) =>
    'Read and inspect the structure of a Word (.docx) document: blocks, headings, tables, and paragraphs.' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: reads reflect the open editor state in real time.]'
      : ' [Offline disk OOXML mode: reads the file on disk.]'),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  parameters: z.object({
    filePath: z.string().describe('Relative or absolute path to the .docx file'),
    startBlockIndex: z.number().int().nonnegative().optional().describe('Starting block index (0-indexed)'),
    endBlockIndex: z.number().int().positive().optional().describe('Ending block index (inclusive)'),
    fullText: z.boolean().optional().describe('Whether to return full paragraph text instead of summary previews')
  }),
  execute: async ({ filePath, startBlockIndex, endBlockIndex, fullText }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    if (isDocsEditorReady()) {
      try {
        const liveRes: any = await runDocsCommandForPath('read_document', fullPath, {})
        if (liveRes?.text) {
          return `Docx: ${filePath} (Live Word Canvas State)\n${liveRes.text}`
        }
      } catch {
        // Fallback to offline disk reading
      }
    }
    try {
      const buffer = await fs.readFile(fullPath)
      const doc = await parseDocx(buffer)
      const visible = doc.blocks.filter((b: any) => !b.hidden)
      const totalBlocks = visible.length

      const start = startBlockIndex ?? 0
      const end = endBlockIndex !== undefined ? Math.min(totalBlocks - 1, endBlockIndex) : Math.min(totalBlocks - 1, start + 49)

      const selected = visible.slice(start, end + 1)
      const blockSummaries = selected.map((b: any, idx: number) => {
        const actualIdx = start + idx
        if (b.type === 'heading') {
          const text = b.runs?.map((r: any) => r.text).join('') || ''
          return `[Block ${actualIdx}] [H${b.level ?? 1}] ${text}`
        }
        if (b.type === 'table') {
          const rowCount = b.table?.rows?.length || b.tableModel?.rows?.length || 0
          return `[Block ${actualIdx}] [Table] (${rowCount} rows)`
        }
        if (b.type === 'paragraph') {
          const text = b.runs?.map((r: any) => r.text).join('') || ''
          const display = fullText ? text : text.slice(0, 150) + (text.length > 150 ? '...' : '')
          return `[Block ${actualIdx}] [Paragraph] ${display}`
        }
        return `[Block ${actualIdx}] [${b.type}]`
      })

      return `Docx: ${filePath} (Total Blocks: ${totalBlocks}, Displaying: ${start}-${end})\n` + blockSummaries.join('\n')
    } catch (err: any) {
      throw new Error(`Failed to read docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 2. docx_create tool */
export const docxCreateTool: AgentTool = {
  name: 'docx_create',
  description: 'Create a new Word (.docx) document from scratch with title and paragraphs.',
  parameters: z.object({
    filePath: z.string().describe('Target file path to save the new .docx file'),
    title: z.string().describe('Document title (formatted as Heading 1)'),
    paragraphs: z.array(z.string()).describe('Array of paragraph texts to include in the document')
  }),
  requiresApproval: () => false,
  execute: async ({ filePath, title, paragraphs }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    try {
      const blankBytes = await buildBlankDocx()
      const parsed = await parseDocx(blankBytes)

      const saveBlocks: SaveBlock[] = []
      // Add Title
      const titleXml = generateParagraphXml(
        {
          type: 'heading',
          level: 1,
          runs: [{ text: title, bold: true }]
        },
        defaultCtx
      )
      saveBlocks.push({ kind: 'xml', xml: titleXml })

      // Add Paragraphs
      for (const p of paragraphs) {
        const pXml = generateParagraphXml(
          {
            type: 'paragraph',
            runs: [{ text: p }]
          },
          defaultCtx
        )
        saveBlocks.push({ kind: 'xml', xml: pXml })
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, saved)

      notifyFocusWordDoc(fullPath)
      notifyWordFileChanged(fullPath)

      return `Successfully created docx document: ${filePath} with ${paragraphs.length + 1} blocks.`
    } catch (err: any) {
      throw new Error(`Failed to create docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 3. docx_append_content tool */
export const docxAppendContentTool: AgentTool = {
  name: 'docx_append_content',
  description: (ctx) =>
    'Append headings or paragraphs to an existing Word (.docx) document, with optional Track Changes.' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: appends apply to the open editor in real time.]'
      : ' [Offline disk OOXML mode: appends rewrite the file on disk.]'),
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    items: z.array(
      z.object({
        type: z.enum(['paragraph', 'heading']),
        level: z.number().int().min(1).max(6).optional().describe('Heading level if type is heading'),
        text: z.string().describe('Content text')
      })
    ).describe('Items to append'),
    trackChanges: z.boolean().optional().describe('Whether to record this append as tracked revision marks (<w:ins>)'),
    author: z.string().optional().describe('Author name for the tracked change (defaults to "Nexus Agent")')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, items, trackChanges } = rawArgs
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    const authorName = rawArgs.author || 'Nexus Agent'
    const nowIso = new Date().toISOString()

    if (isDocsEditorReady()) {
      try {
        const html = items
          .map((item: any) => {
            const escaped = escapeHtml(item.text)
            if (item.type === 'heading') {
              const lvl = item.level ?? 1
              return `<h${lvl}>${escaped}</h${lvl}>`
            }
            return `<p>${escaped}</p>`
          })
          .join('')

        await runDocsCommandForPath('insert_content', fullPath, {
          html,
          trackChanges: !!trackChanges,
          author: authorName
        })
        await runDocsCommandForPath('save_document', fullPath, { path: fullPath, overwrite: true })

        const trackSuffix = trackChanges ? ' (recorded as Track Changes <w:ins>)' : ''
        return `Successfully appended ${items.length} block(s) to ${filePath} via live Word canvas${trackSuffix}.`
      } catch {
        // Fallback to offline engine
      }
    }

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)

      // Keep original blocks
      const saveBlocks: SaveBlock[] = parsed.blocks
        .filter((b: any) => !b.hidden && b.docxIndex !== null)
        .map((b: any) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

      // Append new items
      for (const item of items) {
        const runObj: any = {
          text: item.text,
          bold: item.type === 'heading' ? true : undefined
        }
        if (trackChanges) {
          runObj.ins = { author: authorName, date: nowIso }
        }

        const xml = generateParagraphXml(
          {
            type: item.type === 'heading' ? 'heading' : 'paragraph',
            level: item.type === 'heading' ? item.level ?? 1 : undefined,
            runs: [runObj]
          },
          defaultCtx
        )
        saveBlocks.push({ kind: 'xml', xml })
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      const trackSuffix = trackChanges ? ' (recorded as Track Changes <w:ins>)' : ''
      return `Successfully appended ${items.length} block(s) to ${filePath}${trackSuffix}.`
    } catch (err: any) {
      throw new Error(`Failed to append content to docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 4. docx_modify_block tool (surgical update of an existing block) */
export const docxModifyBlockTool: AgentTool = {
  name: 'docx_modify_block',
  description: (ctx) =>
    'Modify or replace a specific block or range of blocks (paragraphs or headings) in an existing Word (.docx) document by block index range or single block index.' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: mutations apply to the open editor with docnav:// block targeting.]'
      : ' [Offline disk OOXML mode: mutations rewrite the file on disk.]'),
  // P2b pilot (1:1 Claude Code Tool.checkPermissions): live-canvas mutations
  // without revision tracking alter the user's open document unrecoverably.
  checkPermissions: async (args: any) => {
    if (!isDocsEditorReady()) return { behavior: 'allow' }
    if (args?.trackChanges !== true) {
      return {
        behavior: 'ask',
        message:
          'Live Word Canvas is active — replacing blocks without trackChanges will modify the open document with no revision history.',
      }
    }
    return { behavior: 'allow' }
  },
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    blockIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Index of a single block to modify (0-indexed). If modifying multiple blocks, use startBlockIndex and endBlockIndex instead.'),
    startBlockIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Starting block index (inclusive) for multi-block replacement'),
    endBlockIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Ending block index (inclusive) for multi-block replacement'),
    html: z
      .string()
      .optional()
      .describe('HTML fragment for new content (supports multiple <p>, <h1>-<h6>, <table>, etc.)'),
    text: z.string().optional().describe('New content text for the block (used if html is omitted)'),
    content: z.string().optional().describe('New content text for the block (alias for text)'),
    type: z
      .enum(['paragraph', 'heading'])
      .optional()
      .describe('Block type (paragraph or heading). Defaults to original or paragraph'),
    level: z.number().int().min(1).max(6).optional().describe('Heading level (1-6) if type is heading'),
    bold: z.boolean().optional().describe('Whether the text should be bold'),
    italic: z.boolean().optional().describe('Whether the text should be italic'),
    trackChanges: z
      .boolean()
      .optional()
      .describe(
        'Whether to record this edit as tracked revision marks (w:ins / w:del) instead of direct overwrite'
      ),
    author: z.string().optional().describe('Author name for the tracked change (defaults to "Nexus Agent")')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, type, level, bold, italic, trackChanges } = rawArgs
    const startIdx = rawArgs.startBlockIndex ?? rawArgs.blockIndex ?? 0
    const endIdx = rawArgs.endBlockIndex ?? rawArgs.blockIndex ?? startIdx
    const isMultiBlock = startIdx !== endIdx
    const authorName = rawArgs.author || 'Nexus Agent'
    const nowIso = new Date().toISOString()
    const fullPath = resolvePath(filePath, context.workspaceRoot)

    // Build replacement HTML
    let finalHtml = rawArgs.html
    const text = rawArgs.text ?? rawArgs.content ?? rawArgs.newText ?? ''
    if (!finalHtml) {
      const blockType = type ?? 'paragraph'
      const blockLevel = level ?? 1
      let innerText = escapeHtml(text)
      if (bold) innerText = `<strong>${innerText}</strong>`
      if (italic) innerText = `<em>${innerText}</em>`
      finalHtml =
        blockType === 'heading'
          ? `<h${blockLevel}>${innerText}</h${blockLevel}>`
          : `<p>${innerText}</p>`
    }

    // NOTICE: Do NOT unconditionally broadcast notifyFocusWordDoc here, as it triggers redundant openRecent reloads in active editor!

    if (isDocsEditorReady()) {
      try {
        await runDocsCommandForPath('replace_blocks', fullPath, {
          startBlockIndex: startIdx,
          endBlockIndex: endIdx,
          html: finalHtml,
          trackChanges: !!trackChanges,
          author: authorName
        })
        await runDocsCommandForPath('save_document', fullPath, { path: fullPath, overwrite: true })

        const modeStr = trackChanges ? 'with revision marks (Track Changes)' : 'directly (with AI highlight)'
        const navLabel = isMultiBlock ? `第 ${startIdx}-${endIdx} 块` : `第 ${startIdx} 块`
        const blockSummary = isMultiBlock ? `blocks ${startIdx}-${endIdx}` : `block ${startIdx}`
        return `Successfully modified ${blockSummary} in ${filePath} via live Word canvas ${modeStr}.\n👉 [点击定位查看改动位置 (${navLabel})](docnav://block/${startIdx})`
      } catch {
        // Fallback to offline engine
      }
    }

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)

      if (startIdx < 0 || endIdx >= visible.length || startIdx > endIdx) {
        const boundsMsg = isMultiBlock
          ? `Block index range [${startIdx}, ${endIdx}] is out of bounds`
          : `Block index ${startIdx} is out of bounds`
        throw new Error(
          `${boundsMsg} (document has ${visible.length} blocks: 0-${visible.length - 1})`
        )
      }

      // Generate replacement save blocks for offline AST mode
      const replacementBlocks: SaveBlock[] = []
      if (rawArgs.html) {
        // If track changes is enabled, first record deletions of the original blocks being replaced
        if (trackChanges) {
          const originalBlocks = visible.slice(startIdx, endIdx + 1)
          for (const orig of originalBlocks) {
            const origText = orig.runs?.map((r: any) => r.text).join('') || ''
            if (origText.trim() !== '') {
              const origType = orig.type === 'heading' ? 'heading' : 'paragraph'
              const delXml = generateParagraphXml(
                {
                  type: origType,
                  level: orig.type === 'heading' ? orig.level : undefined,
                  runs: [
                    {
                      text: origText,
                      del: { author: authorName, date: nowIso }
                    }
                  ]
                },
                defaultCtx
              )
              replacementBlocks.push({ kind: 'xml' as const, xml: delXml })
            }
          }
        }

        const blockRegex = /<(p|h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi
        const matches = [...rawArgs.html.matchAll(blockRegex)]
        if (matches.length > 0) {
          for (const m of matches) {
            const tag = m[1].toLowerCase()
            const inner = m[2]
            const cleanText = inner.replace(/<[^>]+>/g, '')
            const isHeading = tag.startsWith('h')
            const hLevel = isHeading ? parseInt(tag[1], 10) : undefined
            const isBold = /<strong>|<b>/.test(inner) || isHeading
            const isItalic = /<em>|<i>/.test(inner)
            const runs: any[] = [
              {
                text: cleanText,
                bold: isBold || undefined,
                italic: isItalic || undefined
              }
            ]
            if (trackChanges) {
              runs[0].ins = { author: authorName, date: nowIso }
            }
            const xml = generateParagraphXml(
              {
                type: isHeading ? 'heading' : 'paragraph',
                level: hLevel,
                runs
              },
              defaultCtx
            )
            replacementBlocks.push({ kind: 'xml' as const, xml })
          }
        } else {
          const cleanText = rawArgs.html.replace(/<[^>]+>/g, '').trim()
          const runs: any[] = [{ text: cleanText }]
          if (trackChanges) {
            runs[0].ins = { author: authorName, date: nowIso }
          }
          const xml = generateParagraphXml({ type: 'paragraph', runs }, defaultCtx)
          replacementBlocks.push({ kind: 'xml' as const, xml })
        }
      } else {
        const targetBlocks = visible.slice(startIdx, endIdx + 1)
        if (isMultiBlock) {
          if (trackChanges) {
            for (const orig of targetBlocks) {
              const origText = orig.runs?.map((r: any) => r.text).join('') || ''
              if (origText.trim() !== '') {
                const delXml = generateParagraphXml(
                  {
                    type: orig.type === 'heading' ? 'heading' : 'paragraph',
                    level: orig.type === 'heading' ? orig.level : undefined,
                    runs: [{ text: origText, del: { author: authorName, date: nowIso } }]
                  },
                  defaultCtx
                )
                replacementBlocks.push({ kind: 'xml' as const, xml: delXml })
              }
            }
            const insXml = generateParagraphXml(
              {
                type: type ?? 'paragraph',
                level: type === 'heading' ? (level ?? 1) : undefined,
                runs: [{ text, ins: { author: authorName, date: nowIso }, bold, italic }]
              },
              defaultCtx
            )
            replacementBlocks.push({ kind: 'xml' as const, xml: insXml })
          } else {
            const newXml = generateParagraphXml(
              {
                type: type ?? 'paragraph',
                level: type === 'heading' ? (level ?? 1) : undefined,
                runs: [{ text, bold, italic }]
              },
              defaultCtx
            )
            replacementBlocks.push({ kind: 'xml' as const, xml: newXml })
          }
        } else {
          const targetBlock = visible[startIdx]
          const blockType = type ?? (targetBlock.type === 'heading' ? 'heading' : 'paragraph')
          const blockLevel = level ?? targetBlock.level ?? 1
          const originalText = targetBlock.runs?.map((r: any) => r.text).join('') || ''

          let runs: any[] = []
          if (trackChanges && originalText.trim() !== '') {
            runs = [
              {
                text: originalText,
                del: { author: authorName, date: nowIso }
              },
              {
                text,
                ins: { author: authorName, date: nowIso },
                bold: bold ?? (blockType === 'heading'),
                italic
              }
            ]
          } else {
            runs = [{ text, bold: bold ?? (blockType === 'heading'), italic }]
          }

          const newXml = generateParagraphXml(
            {
              type: blockType,
              level: blockType === 'heading' ? blockLevel : undefined,
              runs
            },
            defaultCtx
          )
          replacementBlocks.push({ kind: 'xml' as const, xml: newXml })
        }
      }

      // Build new saveBlocks array with slice replacement
      const saveBlocks: SaveBlock[] = []
      for (let i = 0; i < visible.length; i++) {
        const b = visible[i]
        if (i < startIdx) {
          saveBlocks.push({ kind: 'original' as const, docxIndex: b.docxIndex! })
        } else if (i === startIdx) {
          saveBlocks.push(...replacementBlocks)
        } else if (i > startIdx && i <= endIdx) {
          // Replaced by multi-block slice, skip original block
        } else {
          saveBlocks.push({ kind: 'original' as const, docxIndex: b.docxIndex! })
        }
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      const trackSuffix = trackChanges ? ' (Track Changes revision recorded)' : ''
      const navLabel = isMultiBlock ? `第 ${startIdx}-${endIdx} 块` : `第 ${startIdx} 块`
      const blockSummary = isMultiBlock ? `blocks ${startIdx}-${endIdx}` : `block ${startIdx}`
      return `Successfully modified ${blockSummary} in ${filePath}${trackSuffix}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"\n👉 [点击定位查看改动位置 (${navLabel})](docnav://block/${startIdx})`
    } catch (err: any) {
      throw new Error(`Failed to modify block in docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 4.5. docx_apply_ops tool (atomic batch formatting, structure, and find-replace operations) */
export const docxApplyOpsTool: AgentTool = {
  name: 'docx_apply_ops',
  description: (ctx) =>
    'Run a list of formatting, structure, and batch ops (setFont, setParagraphFormat, findReplace, setMatchedFont, setHeadingLevel, setList, deleteBlocks, etc.) as one atomic transaction on the active Word canvas.' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: ops run on the open editor and save automatically.]'
      : ' [Offline mode: UNAVAILABLE — open the document in the Word drawer first.]'),
  parameters: z.object({
    filePath: z.string().describe('Path to the existing .docx document'),
    ops: z
      .array(z.record(z.any()))
      .describe(
        'Array of flat op objects, e.g. [{"op":"setFont","target":{"nodeType":"docHeading"},"color":"#FF0000"}] or [{"op":"findReplace","find":"old","replace":"new","target":{"blockIndexes":[1]}}]'
      ),
    dryRun: z.boolean().optional().describe('Validate and return the execution plan without changing the document')
  }),
  requiresApproval: () => false,
  // P2b pilot: live-only tool — deny at the gate (clear model feedback)
  // instead of throwing mid-execution when the canvas is not mounted.
  checkPermissions: async () => {
    if (!isDocsEditorReady()) {
      return {
        behavior: 'deny',
        message:
          'docx_apply_ops requires the Live Word Canvas to be mounted. Open the document in the Word drawer first, or use docx_modify_block for offline disk editing.',
      }
    }
    return { behavior: 'allow' }
  },
  execute: async ({ filePath, ops, dryRun }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    if (isDocsEditorReady()) {
      try {
        const result: any = await runDocsCommandForPath('apply_ops', fullPath, { ops, dryRun: !!dryRun })
        if (!dryRun) {
          await runDocsCommandForPath('save_document', fullPath, { path: fullPath, overwrite: true })
        }
        return `Successfully executed ${ops.length} op(s) on ${filePath}.\n${result?.summary || result?.output || ''}`
      } catch (err: any) {
        throw new Error(`Failed to apply ops on live canvas: ${err.message}`)
      }
    }
    throw new Error(
      `docx_apply_ops requires the document to be open in the Word canvas. Please use docx_modify_block for offline AST modifications.`
    )
  }
}

/** 5. docx_insert_table tool */
export const docxInsertTableTool: AgentTool = {
  name: 'docx_insert_table',
  description: (ctx) =>
    'Insert a formatted table into an existing Word (.docx) document, with optional Track Changes.' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: the table is inserted into the open editor in real time.]'
      : ' [Offline disk OOXML mode: the table is written to the file on disk.]'),
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    headers: z.array(z.string()).describe('Table header column titles'),
    rows: z.array(z.array(z.string())).describe('2D array of row cell texts'),
    afterBlockIndex: z.number().int().optional().describe('Insert after this block index. If omitted, appends to the end of the document'),
    trackChanges: z.boolean().optional().describe('Whether to record inserted table contents as tracked revision marks (<w:ins>)'),
    author: z.string().optional().describe('Author name for tracked changes (defaults to "Nexus Agent")')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, headers, rows, afterBlockIndex, trackChanges } = rawArgs
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    const authorName = rawArgs.author || 'Nexus Agent'
    const nowIso = new Date().toISOString()

    if (isDocsEditorReady()) {
      try {
        const thead = headers && headers.length > 0 ? `<thead><tr>${headers.map((h: string) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` : ''
        const tbody = `<tbody>${rows.map((row: string[]) => `<tr>${row.map((cell: string) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
        const tableHtml = `<table>${thead}${tbody}</table>`

        await runDocsCommandForPath('insert_content', fullPath, {
          html: tableHtml,
          afterBlockIndex,
          trackChanges: !!trackChanges,
          author: authorName
        })
        await runDocsCommandForPath('save_document', fullPath, { path: fullPath, overwrite: true })

        const trackSuffix = trackChanges ? ' (recorded as Track Changes <w:ins>)' : ''
        return `Successfully inserted a ${rows.length + (headers?.length ? 1 : 0)}x${headers?.length || (rows[0]?.length ?? 0)} table into ${filePath} via live Word canvas${trackSuffix}.`
      } catch {
        // Fallback to offline engine
      }
    }

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)

      const tableData = [headers, ...rows]
      const tblXml = generateTableXml(tableData.length, headers.length, { headerRow: true })

      let patchedTblXml: string
      if (trackChanges) {
        const cellPatches = tableData.map((row: string[], rIdx: number) =>
          row.map((cellText: string) => [
            {
              runs: [
                {
                  text: cellText,
                  bold: rIdx === 0 ? true : undefined,
                  ins: { author: authorName, date: nowIso }
                }
              ]
            }
          ])
        )
        patchedTblXml = patchTableCellTexts(tblXml, cellPatches as any)
      } else {
        patchedTblXml = patchTableCellTexts(
          tblXml,
          tableData.map((row: string[]) => row.map((cellText: string) => [cellText]))
        )
      }

      const saveBlocks: SaveBlock[] = []
      const insertAt =
        afterBlockIndex !== undefined ? Math.min(afterBlockIndex, visible.length - 1) : visible.length - 1

      visible.forEach((b: any, idx: number) => {
        saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
        if (idx === insertAt) {
          saveBlocks.push({ kind: 'xml', xml: patchedTblXml })
        }
      })

      if (visible.length === 0 || afterBlockIndex === undefined) {
        if (!saveBlocks.some((sb) => sb.kind === 'xml')) {
          saveBlocks.push({ kind: 'xml', xml: patchedTblXml })
        }
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      const trackSuffix = trackChanges ? ' (recorded as Track Changes <w:ins>)' : ''
      return `Successfully inserted a ${tableData.length}x${headers.length} table into ${filePath}${trackSuffix}.`
    } catch (err: any) {
      throw new Error(`Failed to insert table into docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 6. docx_delete_block tool */
export const docxDeleteBlockTool: AgentTool = {
  name: 'docx_delete_block',
  description: (ctx) =>
    'Delete a block (paragraph or heading) from an existing Word (.docx) document by its block index, either physically or as a Track Changes deletion (<w:del>).' +
    (ctx?.docsEditorReady
      ? ' [Live Word Canvas ACTIVE: deletion applies to the open editor in real time.]'
      : ' [Offline disk OOXML mode: deletion rewrites the file on disk.]'),
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    blockIndex: z.number().int().nonnegative().describe('Index of the block to delete (obtained from docx_read)'),
    trackChanges: z.boolean().optional().describe('Whether to record this deletion as a tracked revision mark (<w:del>) instead of physically removing it'),
    author: z.string().optional().describe('Author name for tracked change (defaults to "Nexus Agent")')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, blockIndex, trackChanges } = rawArgs
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    const authorName = rawArgs.author || 'Nexus Agent'
    const nowIso = new Date().toISOString()

    if (isDocsEditorReady()) {
      try {
        await runDocsCommandForPath('apply_ops', fullPath, {
          ops: [
            {
              op: 'deleteBlocks',
              target: { blockIndexes: [blockIndex] }
            }
          ]
        })
        await runDocsCommandForPath('save_document', fullPath, { path: fullPath, overwrite: true })
        return `Successfully deleted block ${blockIndex} in ${filePath} via live Word canvas.`
      } catch {
        // Fallback to offline engine
      }
    }

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)

      if (blockIndex < 0 || blockIndex >= visible.length) {
        throw new Error(
          `Block index ${blockIndex} is out of bounds (document has ${visible.length} blocks: 0-${visible.length - 1})`
        )
      }

      const targetBlock = visible[blockIndex]
      const targetDocxIndex = targetBlock.docxIndex!

      let saveBlocks: SaveBlock[]
      if (trackChanges) {
        // Soft delete: keep the block, mark all its runs with del
        const originalRuns = targetBlock.runs && targetBlock.runs.length > 0
          ? targetBlock.runs
          : [{ text: '' }]

        const runs = originalRuns.map((r: any) => ({
          ...r,
          del: { author: authorName, date: nowIso }
        }))

        const blockType = targetBlock.type === 'heading' ? 'heading' : 'paragraph'
        const blockLevel = targetBlock.level ?? 1
        const delXml = generateParagraphXml(
          {
            type: blockType,
            level: blockType === 'heading' ? blockLevel : undefined,
            runs
          },
          defaultCtx
        )

        saveBlocks = visible.map((b: any) => {
          if (b.docxIndex === targetDocxIndex) {
            return { kind: 'xml' as const, xml: delXml }
          }
          return { kind: 'original' as const, docxIndex: b.docxIndex! }
        })
      } else {
        // Physical removal: omit target block
        saveBlocks = visible
          .filter((b: any) => b.docxIndex !== targetDocxIndex)
          .map((b: any) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      const trackSuffix = trackChanges ? ' (marked with Track Changes <w:del>)' : ' (physically removed)'
      return `Successfully deleted block ${blockIndex} in ${filePath}${trackSuffix}.`
    } catch (err: any) {
      throw new Error(`Failed to delete block in docx file "${filePath}": ${err.message}`)
    }
  }
}

export interface DocxRevisionItem {
  id: string
  type: 'insertion' | 'deletion'
  author: string
  date?: string
  blockIndex: number
  docxIndex: number
  text: string
}

function extractDocxRevisions(parsed: any): DocxRevisionItem[] {
  const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)
  const revisions: DocxRevisionItem[] = []
  let revCounter = 1

  visible.forEach((b: any, bIdx: number) => {
    if (b.type === 'paragraph' || b.type === 'heading') {
      if (b.runs) {
        for (const r of b.runs) {
          if (r.ins) {
            revisions.push({
              id: `r${revCounter++}`,
              type: 'insertion',
              author: r.ins.author || 'unknown',
              date: r.ins.date,
              blockIndex: bIdx,
              docxIndex: b.docxIndex,
              text: r.text || ''
            })
          }
          if (r.del) {
            revisions.push({
              id: `r${revCounter++}`,
              type: 'deletion',
              author: r.del.author || 'unknown',
              date: r.del.date,
              blockIndex: bIdx,
              docxIndex: b.docxIndex,
              text: r.text || ''
            })
          }
        }
      }
    } else if (b.type === 'table') {
      const rows = b.table?.rows || b.tableModel?.rows || []
      rows.forEach((row: any) => {
        const cells = row.cells || row || []
        cells.forEach((cell: any) => {
          const runs: any[] = [...(cell.runs || [])]
          if (cell.richParas) {
            for (const p of cell.richParas) {
              if (p.runs) runs.push(...p.runs)
            }
          }
          for (const r of runs) {
            if (r.ins) {
              revisions.push({
                id: `r${revCounter++}`,
                type: 'insertion',
                author: r.ins.author || 'unknown',
                date: r.ins.date,
                blockIndex: bIdx,
                docxIndex: b.docxIndex,
                text: r.text || ''
              })
            }
            if (r.del) {
              revisions.push({
                id: `r${revCounter++}`,
                type: 'deletion',
                author: r.del.author || 'unknown',
                date: r.del.date,
                blockIndex: bIdx,
                docxIndex: b.docxIndex,
                text: r.text || ''
              })
            }
          }
        })
      })
    }
  })

  return revisions
}

/** 7. docx_read_revisions tool */
export const docxReadRevisionsTool: AgentTool = {
  name: 'docx_read_revisions',
  description: 'List all pending Track Changes revisions (insertions, deletions) in a Word (.docx) document.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file')
  }),
  execute: async ({ filePath }, context) => {
    const fullPath = resolvePath(filePath, context.workspaceRoot)
    notifyFocusWordDoc(fullPath)
    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const revisions = extractDocxRevisions(parsed)

      if (revisions.length === 0) {
        return `Docx: ${filePath}\nNo pending Track Changes revisions found in the document.`
      }

      const summaries = revisions.map((r) => {
        const textDisplay = r.text.length > 80 ? r.text.slice(0, 80) + '...' : r.text
        return `[${r.id}] [${r.type}] Block: ${r.blockIndex} | Author: "${r.author}"${r.date ? ` | Date: ${r.date}` : ''} | Text: "${textDisplay}"`
      })

      return `Docx: ${filePath} (Total Pending Revisions: ${revisions.length})\n` + summaries.join('\n')
    } catch (err: any) {
      throw new Error(`Failed to read revisions from docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 8. docx_accept_revisions tool */
export const docxAcceptRevisionsTool: AgentTool = {
  name: 'docx_accept_revisions',
  description: 'Accept pending Track Changes revisions in a Word (.docx) document: insertions become regular text, deleted text is permanently removed.',
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    all: z.boolean().optional().describe('Accept all pending revisions if true'),
    ids: z.array(z.string()).optional().describe('Array of revision IDs to accept, e.g. ["r1", "r2"]'),
    author: z.string().optional().describe('Filter by author name to accept')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, all, ids, author } = rawArgs
    const fullPath = resolvePath(filePath, context.workspaceRoot)

    notifyFocusWordDoc(fullPath)

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const allRevisions = extractDocxRevisions(parsed)

      if (allRevisions.length === 0) {
        return `No pending revisions found in ${filePath} to accept.`
      }

      const shouldMatch = (r: DocxRevisionItem) => {
        if (ids && ids.length > 0) return ids.includes(r.id)
        if (author) return r.author.toLowerCase() === author.toLowerCase()
        if (all) return true
        return true // Default to accepting all if called
      }

      const accepted = allRevisions.filter(shouldMatch)
      if (accepted.length === 0) {
        return `No revisions matched the given filter in ${filePath}.`
      }

      const acceptedIds = new Set(accepted.map((r) => r.id))
      const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)

      let revCounter = 1
      const saveBlocks: SaveBlock[] = []

      for (let bIdx = 0; bIdx < visible.length; bIdx++) {
        const b = visible[bIdx]
        if (b.type === 'paragraph' || b.type === 'heading') {
          if (!b.runs || b.runs.length === 0) {
            saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
            continue
          }

          let blockModified = false
          const nextRuns: any[] = []

          for (const r of b.runs) {
            const hasIns = !!r.ins
            const hasDel = !!r.del
            const currentId = hasIns || hasDel ? `r${revCounter++}` : null

            if (currentId && acceptedIds.has(currentId)) {
              blockModified = true
              if (hasIns) {
                // Accept insertion: keep run text, remove ins mark
                const cleanRun = { ...r }
                delete cleanRun.ins
                nextRuns.push(cleanRun)
              }
              // If hasDel: accept deletion means DROP the run entirely!
            } else {
              // Unchanged
              nextRuns.push(r)
            }
          }

          if (blockModified) {
            const cleanRuns = nextRuns.length > 0 ? nextRuns : [{ text: '' }]
            const xml = generateParagraphXml(
              {
                type: b.type === 'heading' ? 'heading' : 'paragraph',
                level: b.level,
                runs: cleanRuns
              },
              defaultCtx
            )
            saveBlocks.push({ kind: 'xml', xml })
          } else {
            saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
          }
        } else {
          // Keep other blocks as original
          saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
        }
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      return `Successfully accepted ${accepted.length} revision(s) in ${filePath} (${accepted.map((r) => r.id).join(', ')}).`
    } catch (err: any) {
      throw new Error(`Failed to accept revisions in docx file "${filePath}": ${err.message}`)
    }
  }
}

/** 9. docx_reject_revisions tool */
export const docxRejectRevisionsTool: AgentTool = {
  name: 'docx_reject_revisions',
  description: 'Reject pending Track Changes revisions in a Word (.docx) document: inserted text is permanently removed, deleted text is restored as regular text.',
  parameters: z.object({
    filePath: z.string().describe('Path to existing .docx file'),
    all: z.boolean().optional().describe('Reject all pending revisions if true'),
    ids: z.array(z.string()).optional().describe('Array of revision IDs to reject, e.g. ["r1", "r2"]'),
    author: z.string().optional().describe('Filter by author name to reject')
  }),
  requiresApproval: () => false,
  execute: async (rawArgs: any, context) => {
    const { filePath, all, ids, author } = rawArgs
    const fullPath = resolvePath(filePath, context.workspaceRoot)

    notifyFocusWordDoc(fullPath)

    try {
      const buffer = await fs.readFile(fullPath)
      const parsed = await parseDocx(buffer)
      const allRevisions = extractDocxRevisions(parsed)

      if (allRevisions.length === 0) {
        return `No pending revisions found in ${filePath} to reject.`
      }

      const shouldMatch = (r: DocxRevisionItem) => {
        if (ids && ids.length > 0) return ids.includes(r.id)
        if (author) return r.author.toLowerCase() === author.toLowerCase()
        if (all) return true
        return true // Default to rejecting all if called
      }

      const rejected = allRevisions.filter(shouldMatch)
      if (rejected.length === 0) {
        return `No revisions matched the given filter in ${filePath}.`
      }

      const rejectedIds = new Set(rejected.map((r) => r.id))
      const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)

      let revCounter = 1
      const saveBlocks: SaveBlock[] = []

      for (let bIdx = 0; bIdx < visible.length; bIdx++) {
        const b = visible[bIdx]
        if (b.type === 'paragraph' || b.type === 'heading') {
          if (!b.runs || b.runs.length === 0) {
            saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
            continue
          }

          let blockModified = false
          const nextRuns: any[] = []

          for (const r of b.runs) {
            const hasIns = !!r.ins
            const hasDel = !!r.del
            const currentId = hasIns || hasDel ? `r${revCounter++}` : null

            if (currentId && rejectedIds.has(currentId)) {
              blockModified = true
              if (hasDel) {
                // Reject deletion: restore run text as normal text, remove del mark
                const restoredRun = { ...r }
                delete restoredRun.del
                nextRuns.push(restoredRun)
              }
              // If hasIns: reject insertion means DROP the run entirely!
            } else {
              // Unchanged
              nextRuns.push(r)
            }
          }

          if (blockModified) {
            const cleanRuns = nextRuns.length > 0 ? nextRuns : [{ text: '' }]
            const xml = generateParagraphXml(
              {
                type: b.type === 'heading' ? 'heading' : 'paragraph',
                level: b.level,
                runs: cleanRuns
              },
              defaultCtx
            )
            saveBlocks.push({ kind: 'xml', xml })
          } else {
            saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
          }
        } else {
          // Keep other blocks as original
          saveBlocks.push({ kind: 'original', docxIndex: b.docxIndex! })
        }
      }

      const saved = await saveDocx(parsed, saveBlocks)
      await fs.writeFile(fullPath, saved)

      notifyWordFileChanged(fullPath)

      return `Successfully rejected ${rejected.length} revision(s) in ${filePath} (${rejected.map((r) => r.id).join(', ')}).`
    } catch (err: any) {
      throw new Error(`Failed to reject revisions in docx file "${filePath}": ${err.message}`)
    }
  }
}
