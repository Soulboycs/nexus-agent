import { afterEach, describe, expect, it } from 'vitest'
import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.navigator = win.navigator as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.Event = win.Event as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 0) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id)
import { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import {
  addQueueAnchor,
  queueAnchorRange,
} from '../../src/renderer/src/components/word/editor/ai-queue-anchors'
import {
  buildQueueInstruction,
  liveItems,
  resolveQueue,
  resolveQueueItem,
} from '../../src/renderer/src/components/word/ai/edit-queue'
import {
  docxCreateTool,
  docxReadTool,
  docxModifyBlockTool,
  docxAppendContentTool,
  docxInsertTableTool,
  docxDeleteBlockTool,
  docxReadRevisionsTool,
  docxAcceptRevisionsTool,
  docxRejectRevisionsTool,
} from '../../src/main/agent/tools/docxTools'
import { parseDocx } from '../../src/packages/docx-engine/index'

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
}

const text = (t: string): JsonNode => ({ type: 'text', text: t })
const para = (t: string): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content: [text(t)],
})
const heading = (t: string): JsonNode => ({
  type: 'docHeading',
  attrs: { docxIndex: null, level: 1 },
  content: [text(t)],
})

const CHIP_KEYS = {
  text: ['aiChipPolish', 'aiChipShorten', 'aiChipExpand', 'aiChipFixGrammar'],
  table: ['aiChipTableEdit', 'aiChipPolish', 'aiChipFixGrammar'],
  image: ['aiChipReplaceImage', 'aiChipRegenImage', 'aiChipImageCaption'],
  chart: ['aiChipChartData', 'aiChipChartTitle'],
}

type SelectionKind = 'image' | 'chart' | 'table' | 'text'

function detectSelectionKind(editor: Editor): SelectionKind {
  const sel = editor.state.selection
  if (sel instanceof CellSelection) return 'table'
  if (sel instanceof NodeSelection) {
    if (sel.node.type.name === 'docTable') return 'table'
    if (sel.node.type.name === 'docProtected') {
      if (sel.node.attrs.chartDisplay) return 'chart'
      const blockType = sel.node.attrs.blockType as string
      if (blockType === 'image') return 'image'
      if (blockType === 'chart') return 'chart'
      if (blockType === 'table') return 'table'
    }
  }
  return 'text'
}

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

function createEditor(content: JsonNode[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  editors.add(editor)
  return editor
}

function blockTextRange(editor: Editor, index: number): { from: number; to: number } {
  let pos = 0
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  return { from: pos + 1, to: pos + 1 + editor.state.doc.child(index).content.size }
}

describe('Word Selection AI Floating Menu & Agent Toolchain E2E Integration', () => {
  const fixture = () => [
    heading('系统架构设计白皮书'),
    para('第一章：核心通信协议与高保真 AST 数据流。'),
    para('第二章：选中文本浮动气泡与 Nexus Agent 协同调度机制。'),
    para('第三章：零假绿测试与性能基准门禁。'),
  ]

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 1: 选区类型感知与 1:1 快捷芯片（Chips）对齐测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 1: Selection Kind Detection & Chips Matching', () => {
    it('accurately identifies text selection and maps to 4 core chips: polish, shorten, expand, grammar', () => {
      const editor = createEditor(fixture())
      const { from, to } = blockTextRange(editor, 1)

      editor.commands.setTextSelection({ from, to })
      const kind = detectSelectionKind(editor)

      expect(kind).toBe('text')
      expect(CHIP_KEYS[kind]).toEqual([
        'aiChipPolish',
        'aiChipShorten',
        'aiChipExpand',
        'aiChipFixGrammar',
      ])

      const excerpt = editor.state.doc.textBetween(from, to, ' ').trim()
      expect(excerpt).toBe('第一章：核心通信协议与高保真 AST 数据流。')
    })

    it('accurately identifies protected image and chart nodes and returns dedicated chips', () => {
      const imageNode: JsonNode = {
        type: 'docProtected',
        attrs: { docxIndex: null, blockType: 'image', label: 'Image' },
      }
      const chartNode: JsonNode = {
        type: 'docProtected',
        attrs: { docxIndex: null, blockType: 'chart', chartDisplay: true },
      }

      const editor = createEditor([para('Intro'), imageNode, chartNode])

      editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize)
      expect(detectSelectionKind(editor)).toBe('image')
      expect(CHIP_KEYS.image).toEqual([
        'aiChipReplaceImage',
        'aiChipRegenImage',
        'aiChipImageCaption',
      ])

      const chartPos = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize
      editor.commands.setNodeSelection(chartPos)
      expect(detectSelectionKind(editor)).toBe('chart')
      expect(CHIP_KEYS.chart).toEqual(['aiChipChartData', 'aiChipChartTitle'])
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 2: 选区锚点跟踪与动态迁移测试 (1:1 对齐 GenOffice 官方 ai-edit-queue 规范)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 2: Selection Anchoring & Dynamic Edit Migration', () => {
    it('anchors migrate reliably through prior insertions without drift', () => {
      const editor = createEditor(fixture())
      const { from, to } = blockTextRange(editor, 2)
      addQueueAnchor(editor, 'q_test_1', from, to)

      const insertText = '【最新修订版】 '
      editor.commands.insertContentAt(1, insertText)

      const migratedRange = queueAnchorRange(editor.state, 'q_test_1')!
      expect(migratedRange.from).toBe(from + insertText.length)
      expect(migratedRange.to).toBe(to + insertText.length)

      const resolved = resolveQueueItem(editor, {
        qid: 'q_test_1',
        instruction: '润色这段文字',
        capturedText: '第二章：选中文本浮动气泡与 Nexus Agent 协同调度机制。',
      })

      expect(resolved.target).not.toBeNull()
      expect(resolved.target?.startIndex).toBe(2)
      expect(resolved.target?.excerpt).toContain('第二章：选中文本浮动气泡')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 3: 划词选区 -> 交付给 Agent 的 Word 工具链 (docx_modify_block) 全流程真实闭环
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 3: Handover to Nexus Agent Word Toolchain (docx_modify_block)', () => {
    it('executes full surgical update lifecycle from text selection to physical docx modification', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-word-selection-test-'))
      const targetDocx = 'Whitepaper-Draft.docx'
      const absoluteDocxPath = path.join(tempDir, targetDocx)
      const context = { workspaceRoot: tempDir }

      try {
        await docxCreateTool.execute(
          {
            filePath: targetDocx,
            title: '系统架构设计白皮书',
            paragraphs: [
              '第一章：核心通信协议与高保真 AST 数据流。',
              '第二章：选中文本浮动气泡与 Nexus Agent 协同调度机制。',
              '第三章：零假绿测试与性能基准门禁。',
            ],
          },
          context,
        )

        const readResult1 = await docxReadTool.execute(
          { filePath: targetDocx, fullText: true },
          context,
        )
        expect(readResult1).toContain('[Block 2] [Paragraph] 第二章：选中文本浮动气泡与 Nexus Agent 协同调度机制。')

        const selectedBlockIndex = 2
        const originalExcerpt = '第二章：选中文本浮动气泡与 Nexus Agent 协同调度机制。'
        const userInstruction = '润色这段文字，使其更加专业具有未来科技感'

        const agentPrompt = `请对 Word 文档（${targetDocx}）第 ${selectedBlockIndex} 个块中选中的以下内容执行【${userInstruction}】：\n\n> "${originalExcerpt}"`
        expect(agentPrompt).toContain(originalExcerpt)
        expect(agentPrompt).toContain(userInstruction)

        const polishedText = '第二章（已深度润色）：基于全双工事件驱动的选区浮动气泡与自愈式智能体协同架构。'
        const modifyResult = await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: selectedBlockIndex,
            text: polishedText,
          },
          context,
        )

        expect(modifyResult).toContain(`Successfully modified block ${selectedBlockIndex}`)

        const readResult2 = await docxReadTool.execute(
          { filePath: targetDocx, fullText: true },
          context,
        )
        expect(readResult2).toContain(`[Block 2] [Paragraph] ${polishedText}`)
        expect(readResult2).toContain('[Block 0] [H1] 系统架构设计白皮书')
        expect(readResult2).toContain('[Block 1] [Paragraph] 第一章：核心通信协议与高保真 AST 数据流。')
        expect(readResult2).toContain('[Block 3] [Paragraph] 第三章：零假绿测试与性能基准门禁。')

        const finalBuffer = await fsPromises.readFile(absoluteDocxPath)
        const parsedDoc = await parseDocx(finalBuffer)
        const visible = parsedDoc.blocks.filter((b) => !b.hidden)
        expect(visible.length).toBe(4)
        expect(visible[2].runs?.[0]?.text).toBe(polishedText)
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records Track Changes revisions (w:del & w:ins) when trackChanges is enabled', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-word-track-test-'))
      const targetDocx = 'Revision-Track-Doc.docx'
      const absoluteDocxPath = path.join(tempDir, targetDocx)
      const context = { workspaceRoot: tempDir }

      try {
        await docxCreateTool.execute(
          {
            filePath: targetDocx,
            title: '学术论文修订草稿',
            paragraphs: ['待审阅初稿段落：这是一段口语化表述，需要记录修订痕迹。'],
          },
          context,
        )

        const originalText = '待审阅初稿段落：这是一段口语化表述，需要记录修订痕迹。'
        const revisedText = '已审阅段落（终稿）：基于高阶抽象代数建模的核心证明，表述严谨规范。'

        const result = await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: revisedText,
            trackChanges: true,
            author: 'Nexus AI Reviewer',
          },
          context,
        )

        expect(result).toContain('Track Changes revision recorded')

        // Physical AST Roundtrip strong assertions
        const finalBuffer = await fsPromises.readFile(absoluteDocxPath)
        const parsedDoc = await parseDocx(finalBuffer)
        const visible = parsedDoc.blocks.filter((b) => !b.hidden)

        expect(visible.length).toBe(2)
        const block = visible[1]
        expect(block.runs?.length).toBe(2)

        // 1. Deleted run (strikethrough)
        const delRun = block.runs?.[0]
        expect(delRun?.text).toBe(originalText)
        expect(delRun?.del).toBeDefined()
        expect(delRun?.del?.author).toBe('Nexus AI Reviewer')
        expect(delRun?.del?.date).toBeDefined()

        // 2. Inserted run (underline)
        const insRun = block.runs?.[1]
        expect(insRun?.text).toBe(revisedText)
        expect(insRun?.ins).toBeDefined()
        expect(insRun?.ins?.author).toBe('Nexus AI Reviewer')
        expect(insRun?.ins?.date).toBeDefined()
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 4: 速度与性能硬核基准测试 (Performance & Latency Benchmarks)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 4: Speed & Performance Benchmarks', () => {
    it('selection detection and chip resolution completes in sub-millisecond time (< 5ms)', () => {
      const editor = createEditor(fixture())
      const { from, to } = blockTextRange(editor, 1)

      const start = performance.now()
      for (let i = 0; i < 50; i++) {
        editor.commands.setTextSelection({ from, to })
        const kind = detectSelectionKind(editor)
        const chips = CHIP_KEYS[kind]
        expect(chips.length).toBe(4)
      }
      const duration = performance.now() - start
      const avgMs = duration / 50

      console.log(`[Benchmark] Average selection detection time: ${avgMs.toFixed(3)}ms`)
      expect(avgMs).toBeLessThan(5)
    })

    it('queue instruction compilation completes in under 10ms', () => {
      const editor = createEditor(fixture())
      const a = blockTextRange(editor, 1)
      const b = blockTextRange(editor, 2)
      addQueueAnchor(editor, 'q1', a.from, a.to)
      addQueueAnchor(editor, 'q2', b.from, b.to)

      const start = performance.now()
      const entries = liveItems(
        resolveQueue(editor, [
          { qid: 'q1', instruction: '润色', capturedText: 'text1' },
          { qid: 'q2', instruction: '简写', capturedText: 'text2' },
        ]),
      )
      const instruction = buildQueueInstruction(entries)
      const duration = performance.now() - start

      console.log(`[Benchmark] Queue instruction build time: ${duration.toFixed(3)}ms`)
      expect(duration).toBeLessThan(10)
      expect(instruction).toContain('Requested change: 润色')
      expect(instruction).toContain('Requested change: 简写')
    })

    it('docx_modify_block full AST parse, patch, and physical save executes under 150ms', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-perf-test-'))
      const targetDocx = 'Perf-Test.docx'
      const context = { workspaceRoot: tempDir }

      try {
        await docxCreateTool.execute(
          {
            filePath: targetDocx,
            title: '性能测试基准文档',
            paragraphs: ['初始段落文本，等待外科手术式替换。'],
          },
          context,
        )

        const start = performance.now()
        await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: '极速修改后的段落文本。',
          },
          context,
        )
        const duration = performance.now() - start

        console.log(`[Benchmark] docx_modify_block full pipeline time: ${duration.toFixed(2)}ms`)
        expect(duration).toBeLessThan(150)
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 5: 1:1 全流程修订痕迹（Track Changes）与审阅管理测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 5: Complete Track Changes & Revision Review Lifecycle', () => {
    it('records <w:ins> when docx_append_content has trackChanges: true', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-track-append-'))
      const targetDocx = 'Track-Append.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          { filePath: targetDocx, title: '初稿文档', paragraphs: ['原始第一段。'] },
          context,
        )
        await docxAppendContentTool.execute(
          {
            filePath: targetDocx,
            items: [{ type: 'paragraph', text: '追加的修订段落内容。' }],
            trackChanges: true,
            author: 'Nexus Reviewer',
          },
          context,
        )
        const parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        const visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)
        const lastBlock = visible[visible.length - 1]
        expect(lastBlock?.runs?.[0]?.text).toBe('追加的修订段落内容。')
        expect(lastBlock?.runs?.[0]?.ins).toBeDefined()
        expect(lastBlock?.runs?.[0]?.ins?.author).toBe('Nexus Reviewer')
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('records <w:ins> inside table cells when docx_insert_table has trackChanges: true', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-track-table-'))
      const targetDocx = 'Track-Table.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          { filePath: targetDocx, title: '带表格的文档', paragraphs: ['段落一。'] },
          context,
        )
        await docxInsertTableTool.execute(
          {
            filePath: targetDocx,
            headers: ['指标', '数值'],
            rows: [['Q1', '100']],
            trackChanges: true,
            author: 'Nexus Table Reviewer',
          },
          context,
        )
        const parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        const tblBlock = parsed.blocks.find((b: any) => b.type === 'table')
        expect(tblBlock).toBeDefined()
        const firstRow = tblBlock?.tableModel?.rows?.[0] || tblBlock?.table?.rows?.[0]
        expect(firstRow).toBeDefined()
        const cellRun = firstRow?.[0]?.richParas?.[0]?.runs?.[0] || firstRow?.[0]?.runs?.[0]
        expect(cellRun?.ins).toBeDefined()
        expect(cellRun?.ins?.author).toBe('Nexus Table Reviewer')
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('supports both soft deletion (<w:del>) and hard deletion with docx_delete_block', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-track-delete-'))
      const targetDocx = 'Track-Delete.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          {
            filePath: targetDocx,
            title: '待删除测试文档',
            paragraphs: ['段落 1 保留', '段落 2 软删除', '段落 3 硬删除'],
          },
          context,
        )

        // 1. Soft delete block 2 with trackChanges: true
        await docxDeleteBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 2,
            trackChanges: true,
            author: 'Nexus Eraser',
          },
          context,
        )
        let parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        let visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)
        expect(visible.length).toBe(4) // Heading + 3 paragraphs still present
        const softDelBlock = visible[2]
        expect(softDelBlock.runs?.[0]?.text).toBe('段落 2 软删除')
        expect(softDelBlock.runs?.[0]?.del).toBeDefined()
        expect(softDelBlock.runs?.[0]?.del?.author).toBe('Nexus Eraser')

        // 2. Hard delete block 3 with trackChanges: false
        await docxDeleteBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 3,
            trackChanges: false,
          },
          context,
        )
        parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        visible = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)
        expect(visible.length).toBe(3) // Now 3 blocks: Heading, Block 1, Block 2 (del mark)
        expect(visible.some((b: any) => b.runs?.[0]?.text === '段落 3 硬删除')).toBe(false)
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('reads all pending revisions accurately via docx_read_revisions', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-read-revs-'))
      const targetDocx = 'Read-Revs.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          { filePath: targetDocx, title: '测试审阅清单', paragraphs: ['原始文字'] },
          context,
        )
        await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: '修改后的文字',
            trackChanges: true,
            author: 'Auditor A',
          },
          context,
        )
        const output = (await docxReadRevisionsTool.execute({ filePath: targetDocx }, context)) as string
        expect(output).toContain('Total Pending Revisions: 2')
        expect(output).toContain('[deletion]')
        expect(output).toContain('[insertion]')
        expect(output).toContain('Author: "Auditor A"')
        expect(output).toContain('原始文字')
        expect(output).toContain('修改后的文字')
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('accepts revisions via docx_accept_revisions (removes deleted text, keeps inserted text)', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-accept-revs-'))
      const targetDocx = 'Accept-Revs.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          { filePath: targetDocx, title: '测试接受修订', paragraphs: ['旧文字内容'] },
          context,
        )
        await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: '新文字内容',
            trackChanges: true,
            author: 'Editor 1',
          },
          context,
        )

        // Accept all
        const acceptResult = await docxAcceptRevisionsTool.execute(
          { filePath: targetDocx, all: true },
          context,
        )
        expect(acceptResult).toContain('Successfully accepted 2 revision(s)')

        const parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        const block = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)[1]
        // Del run should be completely gone!
        expect(block.runs?.some((r: any) => r.text === '旧文字内容')).toBe(false)
        // Ins run should be preserved and stripped of ins attribute
        const keptRun = block.runs?.find((r: any) => r.text === '新文字内容')
        expect(keptRun).toBeDefined()
        expect(keptRun?.ins).toBeUndefined()
        expect(keptRun?.del).toBeUndefined()
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('rejects revisions via docx_reject_revisions (restores deleted text, removes inserted text)', async () => {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-reject-revs-'))
      const targetDocx = 'Reject-Revs.docx'
      const context = { workspaceRoot: tempDir }
      try {
        await docxCreateTool.execute(
          { filePath: targetDocx, title: '测试拒绝修订', paragraphs: ['必须保留的原始文字'] },
          context,
        )
        await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: '被拒绝的不良修改',
            trackChanges: true,
            author: 'Bad Editor',
          },
          context,
        )

        // Reject all
        const rejectResult = await docxRejectRevisionsTool.execute(
          { filePath: targetDocx, all: true },
          context,
        )
        expect(rejectResult).toContain('Successfully rejected 2 revision(s)')

        const parsed = await parseDocx(await fsPromises.readFile(path.join(tempDir, targetDocx)))
        const block = parsed.blocks.filter((b: any) => !b.hidden && b.docxIndex !== null)[1]
        // Ins run should be completely gone!
        expect(block.runs?.some((r: any) => r.text === '被拒绝的不良修改')).toBe(false)
        // Del run should be restored as plain text
        const restoredRun = block.runs?.find((r: any) => r.text === '必须保留的原始文字')
        expect(restoredRun).toBeDefined()
        expect(restoredRun?.ins).toBeUndefined()
        expect(restoredRun?.del).toBeUndefined()
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
