import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  parseDocx,
  buildBlankDocx,
  type CommentInfo,
} from '../../src/packages/docx-engine'
import {
  blankDocument,
  closeDocument,
  headerFooterState,
  listComments,
  listNotes,
  listRevisions,
  listStyles,
  runTool,
  saveDocument,
  type OpenDocument,
} from '../../src/main/docx/headless/headlessDocument'
import { opNames } from '../../src/renderer/src/components/word/ai/ops'

/**
 * R8-B 门禁：headless 引擎（主进程 jsdom + 渲染层编辑栈）真实往返。
 *
 * 捕获的真实故障：headless 管线任一环断裂——jsdom shim 失效、editor 装配
 * 错、access 对象未接线（评论/脚注/页眉/样式静默丢失）、save 计划漏 side
 * 状态（改动只在内存、落盘字节不变）。判定准则全部锚定"保存后重新
 * parseDocx 的物理字节事实"，杜绝假写。
 */

let doc: OpenDocument

// 冷启动（jsdom shim + 渲染层模块图 + editor 装配）在 bun test 环境需 ~10-20s，
// 远超 bun 默认 hook 超时；显式放宽。后续测试共享同一文档实例。
beforeAll(async () => {
  doc = await blankDocument()
}, 180_000)

afterAll(() => {
  if (doc) closeDocument(doc)
})

describe('R8-B: headless 引擎往返（内存 → 落盘 → 重解析）', () => {
  test('op 注册表 = GenOffice 全量 23 op（目录契约，防漂移）', async () => {
    // 注册名以引擎为准：splitTableCell 是单数（GenOffice table-ops.ts:719）
    const GENOFFICE_OPS = [
      'setFont', 'setMatchedFont', 'setParagraphFormat', 'setHeadingLevel',
      'findReplace', 'deleteBlocks', 'moveBlocks', 'setList', 'clearList',
      'setImageProperties', 'insertToc', 'insertField', 'insertBookmark',
      'updateFields', 'insertTableRow', 'deleteTableRow', 'insertTableColumn',
      'deleteTableColumn', 'mergeTableCells', 'splitTableCell',
      'setTableCellFormat', 'setTableStyle', 'applyStyle',
    ].sort()
    expect([...opNames()].sort()).toEqual(GENOFFICE_OPS)
  })

  test('insert_content 无 afterBlockIndex = 追加文档末尾（headless 语义）', async () => {
    const r = await runTool(doc, 'insert_content', {
      html: '<h1>Report</h1><p>first paragraph</p><p>second paragraph</p>',
    })
    expect(r.isError).toBeFalsy()
    expect(doc.editor.state.doc.childCount).toBeGreaterThanOrEqual(3)
  })

  test('replace_blocks 重写保留语义 + get_document_context 块列表', async () => {
    const r = await runTool(doc, 'replace_blocks', {
      startBlockIndex: 2,
      endBlockIndex: 2,
      html: '<p>second paragraph, rewritten</p>',
    })
    expect(r.isError).toBeFalsy()
    const ctx = await runTool(doc, 'get_document_context', {})
    expect(ctx.isError).toBeFalsy()
    expect(ctx.output).toContain('second paragraph, rewritten')
    expect(ctx.output).toMatch(/\d+\|h1\|Report/)
  })

  test('read_blocks 返回受限 HTML', async () => {
    const r = await runTool(doc, 'read_blocks', { startBlockIndex: 0, endBlockIndex: 2 })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('<h1>Report</h1>')
  })

  test('负面：越界块索引 → GenOffice 原文错误信息', async () => {
    const r = await runTool(doc, 'read_blocks', { startBlockIndex: 0, endBlockIndex: 999 })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('block index invalid or out of range')
    expect(r.output).toContain('get_document_context')
  })

  test('负面：裸 JSON 回声 html 被拒（toolEcho 防护在 headless 生效）', async () => {
    const r = await runTool(doc, 'insert_content', {
      html: '{"index":0,"type":"paragraph"}',
    })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('raw JSON')
  })

  test('apply_ops：表格结构 op + 样式 op 全链路', async () => {
    const insert = await runTool(doc, 'insert_content', {
      html: '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>2</td></tr></table>',
    })
    expect(insert.isError).toBeFalsy()
    // 定位表格块须扫描（尾随空段落使 childCount-1 不可靠——索引纪律同 agent）
    let tableIndex = -1
    doc.editor.state.doc.forEach((node, _offset, index) => {
      if (tableIndex < 0 && node.type.name === 'docTable') tableIndex = index
    })
    expect(tableIndex).toBeGreaterThanOrEqual(0)
    const addRow = await runTool(doc, 'apply_ops', {
      ops: [{ op: 'insertTableRow', target: { blockIndexes: [tableIndex] }, row: 1 }],
    })
    expect(addRow.isError).toBeFalsy()
    // 行数以 PM 表格节点为准（ctx 预览只含拼接文本，不含行数）
    const tableNode = doc.editor.state.doc.child(tableIndex)
    expect(tableNode.type.name).toBe('docTable')
    expect(tableNode.childCount).toBe(3)
  })

  test('apply_ops dryRun：校验通过但不改动文档', async () => {
    const before = doc.editor.state.doc.childCount
    const r = await runTool(doc, 'apply_ops', {
      ops: [{ op: 'deleteBlocks', target: { nodeType: 'docParagraph' } }],
      dryRun: true,
    })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Dry run')
    expect(doc.editor.state.doc.childCount).toBe(before)
  })

  test('评论闭环：add → list → reply → resolve（ids 真实）', async () => {
    const add = await runTool(doc, 'add_comment', {
      blockIndex: 1,
      comment: 'check this figure',
      author: 'Reviewer',
    })
    expect(add.isError).toBeFalsy()
    const threads = listComments(doc)
    expect(threads).toHaveLength(1)
    const id = threads[0]!.id
    const reply = await runTool(doc, 'reply_comment', { parentId: id, text: 'fixed in v2' })
    expect(reply.isError).toBeFalsy()
    const resolve = await runTool(doc, 'resolve_comment', { id })
    expect(resolve.isError).toBeFalsy()
    expect(listComments(doc).filter((c) => c.done)).toHaveLength(2)
  })

  test('负面：未知 comment id 报错并指向 read_comments', async () => {
    const r = await runTool(doc, 'resolve_comment', { id: 'nope' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('no comment with id nope')
  })

  test('脚注：insert_footnote + read_notes', async () => {
    const r = await runTool(doc, 'insert_footnote', {
      blockIndex: 1,
      afterText: 'paragraph',
      text: 'source: internal data',
    })
    expect(r.isError).toBeFalsy()
    const notes = listNotes(doc)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toBe('source: internal data')
    expect(notes[0]!.blockIndex).toBe(1)
  })

  test('页眉：set_header_footer 带 {PAGE} token', async () => {
    const r = await runTool(doc, 'set_header_footer', {
      kind: 'header',
      text: 'Report · {PAGE} / {NUMPAGES}',
    })
    expect(r.isError).toBeFalsy()
    expect(headerFooterState(doc).header).toBe('Report · {PAGE} / {NUMPAGES}')
  })

  test('样式：define_style + applyStyle op', async () => {
    const def = await runTool(doc, 'define_style', {
      styleId: 'CalloutBox',
      name: 'Callout Box',
      type: 'paragraph',
      run: { bold: true, color: '#1A73E8' },
    })
    expect(def.isError).toBeFalsy()
    const apply = await runTool(doc, 'apply_ops', {
      ops: [{ op: 'applyStyle', target: { blockIndexes: [1] }, styleId: 'CalloutBox' }],
    })
    expect(apply.isError).toBeFalsy()
    const styles = listStyles(doc)
    expect(styles.some((s) => s.styleId === 'CalloutBox' && s.pending)).toBe(true)
  })

  test('修订：track 作者插入 → listRevisions → reject_changes 还原', async () => {
    const count = doc.editor.state.doc.childCount
    const ins = await runTool(doc, 'insert_content', {
      html: '<p>tracked insertion that will be rejected</p>',
      afterBlockIndex: -1,
    }, { trackAuthor: 'Headless Tester' })
    expect(ins.isError).toBeFalsy()
    const revs = listRevisions(doc)
    expect(revs.length).toBeGreaterThan(0)
    expect(revs[0]!.author).toBe('Headless Tester')
    expect(revs[0]!.type).toBe('insertion')
    const reject = await runTool(doc, 'reject_changes', { all: true })
    expect(reject.isError).toBeFalsy()
    expect(doc.editor.state.doc.childCount).toBe(count)
  })

  test('落盘：保存 → 重新 parseDocx 物理断言（文字/评论/脚注/页眉/样式/表格全在场）', async () => {
    const bytes = await saveDocument(doc)
    const reparsed = await parseDocx(bytes)
    const text = reparsed.blocks
      .map((b: { runs?: Array<{ text?: string }>; table?: { rows?: Array<Array<{ paras: string[] }>> } }) => {
        const runText = (b.runs ?? []).map((r) => r.text ?? '').join('')
        // 表格文本住在 table 模型 cells 的 paras 里（预览 NameQtyApple2 由此而来）
        const cellText = (b.table?.rows ?? []).flat().flatMap((c) => c.paras).join('')
        return runText + cellText
      })
      .join('|')
    expect(text).toContain('Report')
    expect(text).toContain('second paragraph, rewritten')
    expect(text).toContain('Apple')
    expect(reparsed.comments.map((c: CommentInfo) => c.text)).toEqual(
      expect.arrayContaining(['check this figure', 'fixed in v2']),
    )
    expect(reparsed.footnotes).toHaveLength(1)
    // {PAGE}/{NUMPAGES} 在保存时成为真页码域：token 从文本消失、hasPageNumber 置位
    //（GenOffice 同款语义；token 前后的空白被域边界规整，不做逐字符比对）
    expect(reparsed.headerText.startsWith('Report')).toBe(true)
    expect(reparsed.headerText).not.toContain('{PAGE}')
    expect(reparsed.headerHasPageNumber).toBe(true)
    expect([...reparsed.styles.keys()]).toContain('CalloutBox')
    // 修订被拒绝：插入文字不得残留在正文
    expect(text).not.toContain('tracked insertion that will be rejected')
  })

  test('字节保留：未改动块的 originalXml 在保存计划中原样透传', async () => {
    const fresh = await blankDocument()
    try {
      await runTool(fresh, 'insert_content', { html: '<p>only edit</p>' })
      const saved = await saveDocument(fresh)
      const again = await parseDocx(saved)
      // 空白模板只有一个空段（被替换）；新文档不应凭空多块
      expect(again.blocks.filter((b: { hidden?: boolean }) => !b.hidden)).toHaveLength(1)
      expect(again.blocks[0]!.runs?.[0]?.text).toBe('only edit')
    } finally {
      closeDocument(fresh)
    }
  })
})
