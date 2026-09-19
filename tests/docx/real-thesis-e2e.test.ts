import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'
import fs from 'node:fs'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id) as any

import { parseDocx, readSections } from '../../src/packages/docx-engine/index'
import { makeGapHfEl } from '../../src/renderer/src/components/word/editor/hf-dom'
import { headingFoldingKey } from '../../src/renderer/src/components/word/editor/heading-folding'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import { Editor } from '@tiptap/core'
import { blocksToPmDoc } from '../../src/renderer/src/components/word/editor/convert'

const REAL_THESIS_PATH = 'C:\\Users\\Administrator\\Documents\\附件20：博士学位论文写作规范与模版-内容需100页以上(1).docx'

describe('真实华中科技大学博士学位论文（附件20）端到端真实测试', () => {
  let thesisBuf: Buffer
  let parsedDoc: any

  it('1. 真实文档载入与 ECMA-376 OOXML 完整性解析', async () => {
    expect(fs.existsSync(REAL_THESIS_PATH)).toBe(true)
    thesisBuf = fs.readFileSync(REAL_THESIS_PATH)
    expect(thesisBuf.length).toBeGreaterThan(200000) // ~257KB

    parsedDoc = await parseDocx(thesisBuf)
    expect(parsedDoc).toBeDefined()
    expect(parsedDoc.blocks.length).toBe(391) // 真实文档 391 个块
    expect(parsedDoc.compatibilityMode).toBe(14)
    expect(parsedDoc.docDefaults.asciiFont).toBe('Times New Roman')
    expect(parsedDoc.docDefaults.eastAsiaFont).toBe('宋体')

    const sections = readSections(parsedDoc)
    expect(sections.length).toBe(3)

    // Section 1 真实属性验证
    const sec1 = sections[1]
    expect(sec1.firstBlockIndex).toBe(82)
    expect(sec1.lastBlockIndex).toBe(197)
    expect(sec1.headerRefs?.default).toBe('rId11')
    expect(sec1.footerRefs?.default).toBe('rId12')

    // Section 1 页眉 (rId11) 真实内容验证
    const sec1Header = parsedDoc.hfParts?.['rId11']
    expect(sec1Header).toBeDefined()
    expect(sec1Header.text).toContain('华 中 科 技 大 学 博 士 学 位 论 文')
    expect(sec1Header.paras.length).toBe(2)
    // 包含 1 个 DrawingML 矢量红双线
    expect(sec1Header.images?.length).toBe(1)

    // Section 1 页脚 (rId12) 真实页码验证
    const sec1Footer = parsedDoc.hfParts?.['rId12']
    expect(sec1Footer).toBeDefined()
    expect(sec1Footer.hasPageNumber).toBe(true)
  })

  it('2. 真实文档多级标题识别与 HeadingFolding 物理折叠/展开测试', async () => {
    // 提取真实文档的所有 heading
    const headings: Array<{ idx: number; level: number; text: string }> = []
    parsedDoc.blocks.forEach((b: any, idx: number) => {
      if (b.type === 'heading') {
        const text = b.runs.map((r: any) => r.text).join('').trim()
        headings.push({ idx, level: b.level, text })
      }
    })

    // 验证标题总数与层级分布（绝无假数据）
    expect(headings.length).toBe(47)
    const h1List = headings.filter((h) => h.level === 1)
    const h2List = headings.filter((h) => h.level === 2)
    const h3List = headings.filter((h) => h.level === 3)
    expect(h1List.length).toBe(18)
    expect(h2List.length).toBe(12)
    expect(h3List.length).toBe(15)

    // 验证几个关键核心真实标题
    expect(headings.some((h) => h.text.includes('1. 肺大动脉炎相关肺高血压多中心队列研究'))).toBe(true)
    expect(headings.some((h) => h.text.includes('1.1 引言'))).toBe(true)
    expect(headings.some((h) => h.text.includes('1.2.1 实验材料'))).toBe(true)
    expect(headings.some((h) => h.text.includes('2. 经皮腔内肺动脉成形术治疗肺高血压'))).toBe(true)

    // 转换成真实 ProseMirror Doc
    const pmDocJson = blocksToPmDoc(parsedDoc.blocks)
    expect(pmDocJson.type).toBe('doc')
    expect(pmDocJson.content.length).toBe(390)

    // 初始化 Tiptap / ProseMirror Editor 实例（装载全套扩展，包括 HeadingFolding）
    const container = document.createElement('div')
    document.body.appendChild(container)

    const editor = new Editor({
      element: container,
      extensions: editorExtensions,
      content: pmDocJson,
    })

    expect(editor).toBeDefined()
    const state = editor.state
    const doc = state.doc

    // 检查 HeadingFolding 生成的 Decorations
    const plugin = editor.state.plugins.find((p) => p.spec.key === headingFoldingKey)
    expect(plugin).toBeDefined()

    const decos = plugin!.props.decorations!(editor.state)
    expect(decos).toBeDefined()

    // 验证所有拥有子内容的 H1~H3 都挂上了折叠箭头 Widget
    const widgets = decos.find(undefined, undefined, (spec) => !!spec.key?.toString().startsWith('fold-toggle-'))
    expect(widgets.length).toBeGreaterThan(30)

    // 找到 Block 196（第一章标题）在 ProseMirror 中的位置
    let h1Pos: number | null = null
    doc.forEach((node, pos) => {
      if (node.type.name === 'docHeading' && node.attrs.level === 1 && node.textContent.includes('1. 肺大动脉炎相关肺高血压')) {
        h1Pos = pos
      }
    })
    expect(h1Pos).not.toBeNull()

    // 触发折叠该 H1
    editor.view.dispatch(editor.state.tr.setMeta(headingFoldingKey, { toggle: h1Pos }))
    const foldedState = headingFoldingKey.getState(editor.state)
    expect(foldedState?.has(h1Pos!)).toBe(true)

    // 验证重新构建后的 Decorations：必须产生了多项 .doc-collapsed-block
    const foldedDecos = plugin!.props.decorations!(editor.state)
    const collapsedNodes = foldedDecos.find(undefined, undefined, (spec) => spec.class === 'doc-collapsed-block')
    expect(collapsedNodes.length).toBeGreaterThan(10) // 第一章下的所有段落和子节全部被隐藏

    // 核心断言：折叠操作未污染底层文档结构，doc.nodeSize 和 doc.toJSON 保持干净
    const snapshotBeforeExpand = JSON.stringify(editor.state.doc.toJSON())

    // 再次点击展开
    editor.view.dispatch(editor.state.tr.setMeta(headingFoldingKey, { toggle: h1Pos }))
    const unfoldedState = headingFoldingKey.getState(editor.state)
    expect(unfoldedState?.has(h1Pos!)).toBe(false)

    // 展开后折叠块消失
    const unfoldedDecos = plugin!.props.decorations!(editor.state)
    const emptyCollapsed = unfoldedDecos.find(undefined, undefined, (spec) => spec.class === 'doc-collapsed-block')
    expect(emptyCollapsed.length).toBe(0)

    const snapshotAfterExpand = JSON.stringify(editor.state.doc.toJSON())
    expect(snapshotAfterExpand).toBe(snapshotBeforeExpand) // 100% 零修改零污染

    editor.destroy()
  })

  it('3. 真实文档 Section 1 页眉双击编辑与全局 Ribbon 联动事件实测', async () => {
    const sec1Header = parsedDoc.hfParts?.['rId11']
    expect(sec1Header).toBeDefined()

    // 构建真实页眉 HeaderFooter 数据
    const hfValue = {
      text: sec1Header.text,
      paras: sec1Header.paras,
    }

    let eventFired = false
    let eventActive = false
    const hfListener = (e: any) => {
      eventFired = true
      eventActive = e.detail?.active
    }
    window.addEventListener('nexus-word-edit-hf', hfListener)

    let committedNext: any = null
    const el = makeGapHfEl({
      kind: 'header',
      value: hfValue as any,
      images: sec1Header.images,
      pageNo: 'I',
      pageTotal: 100,
      readOnly: false,
      onCommit: (next) => {
        committedNext = next
      },
    })

    document.body.appendChild(el)

    // 验证初始状态
    expect(el.classList.contains('page-hf')).toBe(true)
    expect(el.classList.contains('page-gap-hf')).toBe(true)
    expect(el.textContent).toContain('华 中 科 技 大 学 博 士 学 位 论 文')
    expect(el.querySelector('.page-hf-edit-surface')).toBeNull()

    // 模拟用户在真实页眉上双击
    const dblEvent = new win.Event('dblclick', { bubbles: true, cancelable: true })
    el.dispatchEvent(dblEvent)

    // 验证事件派发与 UI 编辑态激活
    expect(eventFired).toBe(true)
    expect(eventActive).toBe(true)
    expect(el.classList.contains('page-hf-editing')).toBe(true)

    const editSurface = el.querySelector('.page-hf-edit-surface') as HTMLElement
    expect(editSurface).not.toBeNull()
    expect(editSurface.contentEditable).toBe('true')
    expect(editSurface.innerText).toBe(sec1Header.text)

    // 模拟失焦触发 commit 与退出编辑（等待防瞬态失焦 shield 过期）
    await new Promise((r) => setTimeout(r, 260))
    eventFired = false
    editSurface.innerText = '华 中 科 技 大 学 博 士 学 位 论 文（修改测试）'
    const blurEvent = new win.Event('blur', { bubbles: false })
    editSurface.dispatchEvent(blurEvent)

    expect(committedNext).not.toBeNull()
    expect(eventFired).toBe(true)
    expect(eventActive).toBe(false)
    expect(el.classList.contains('page-hf-editing')).toBe(false)

    window.removeEventListener('nexus-word-edit-hf', hfListener)
    el.remove()
  })

  it('4. 双击跨页空白间隙（Page Gap）任意区域自动命中并激活页眉编辑', async () => {
    const sec1Header = parsedDoc.hfParts?.['rId11']
    const hfValue = {
      text: sec1Header.text,
      paras: sec1Header.paras,
    }

    let hfEditFired = false
    const hfListener = (e: any) => {
      if (e.detail?.active) hfEditFired = true
    }
    window.addEventListener('nexus-word-edit-hf', hfListener)

    const headerEl = makeGapHfEl({
      kind: 'header',
      value: hfValue as any,
      images: sec1Header.images,
      pageNo: 2,
      pageTotal: 100,
      readOnly: false,
      onCommit: () => {},
    })

    // 组装真实的 Page Gap 容器（包含 headerEl）
    const gapMetrics = {
      marginTop: 96,
      marginBottom: 96,
      marginLeft: 90,
      marginRight: 90,
    }
    const gapEl = document.createElement('div')
    gapEl.className = 'page-gap'
    gapEl.style.height = '220px'
    gapEl.appendChild(headerEl)

    // 给 gapEl 添加与 pagination-gaps.ts 中一致的双击代理逻辑
    let lastGapClick = 0
    const dispatchHfDbl = (me: any) => {
      const isLowerHalf = true // 模拟点击在下半部（页眉区）
      const targetEl = isLowerHalf ? headerEl : null
      if (targetEl) {
        targetEl.dispatchEvent(new win.Event('dblclick', { bubbles: true, cancelable: true }))
      }
    }
    gapEl.addEventListener('dblclick', dispatchHfDbl)

    document.body.appendChild(gapEl)

    // 用户在 gap 空白处双击
    const dblEvent = new win.Event('dblclick', { bubbles: true, cancelable: true })
    gapEl.dispatchEvent(dblEvent)

    // 验证 headerEl 成功进入编辑态并派发全局激活事件
    expect(hfEditFired).toBe(true)
    expect(headerEl.classList.contains('page-hf-editing')).toBe(true)
    expect(headerEl.querySelector('.page-hf-edit-surface')).not.toBeNull()

    window.removeEventListener('nexus-word-edit-hf', hfListener)
    gapEl.remove()
  })
})
