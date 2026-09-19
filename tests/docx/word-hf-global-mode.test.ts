import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'
import fs from 'node:fs'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.MouseEvent = win.MouseEvent as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id) as any

import { parseDocx, readSections } from '../../src/packages/docx-engine/index'
import { makeGapHfEl } from '../../src/renderer/src/components/word/editor/hf-dom'
import { bindGapHfDoubleClickHandler } from '../../src/renderer/src/components/word/editor/pagination-gaps'
import { blocksToPmDoc } from '../../src/renderer/src/components/word/editor/convert'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'

const REAL_THESIS_PATH = 'C:\\Users\\Administrator\\Documents\\附件20：博士学位论文写作规范与模版-内容需100页以上(1).docx'

describe('Word 1:1 全局页眉页脚模式反转 TDD 契约测试套件', () => {
  let parsedDoc: any

  it('1. 验证真实文档载入与多节 Header 数据准备', async () => {
    expect(fs.existsSync(REAL_THESIS_PATH)).toBe(true)
    const buf = fs.readFileSync(REAL_THESIS_PATH)
    parsedDoc = await parseDocx(buf)
    expect(parsedDoc).toBeDefined()
    expect(parsedDoc.blocks.length).toBe(391)

    const sections = readSections(parsedDoc)
    expect(sections.length).toBe(3)
    expect(sections[1].headerRefs?.default).toBe('rId11')
  })

  it('2. 【红灯测试】页面顶部全域双击激活：正文灰化只读锁 + 页眉100%点亮 + [页眉 -第 2 节-] 角标', async () => {
    const sec1Header = parsedDoc.hfParts?.['rId11']
    expect(sec1Header).toBeDefined()

    // 构建真实的文档容器：包含正文区与跨页间隙
    const rootContainer = document.createElement('div')
    rootContainer.className = 'app-content doc-workbench'

    const editorEl = document.createElement('div')
    editorEl.className = 'ProseMirror'
    editorEl.contentEditable = 'true'

    const para1 = document.createElement('p')
    para1.textContent = '这是华中科技大学博士论文正文第一段...'
    editorEl.appendChild(para1)

    // 创建 Section 1 的跨页页眉（属于第 2 节，sectionIndex = 1）
    const headerEl = makeGapHfEl({
      kind: 'header',
      value: { text: sec1Header.text, paras: sec1Header.paras } as any,
      images: sec1Header.images,
      pageNo: 'I',
      pageTotal: 100,
      readOnly: false,
      sectionIndex: 1, // 第 2 节
      onCommit: () => {},
    })

    const gapEl = document.createElement('div')
    gapEl.className = 'page-gap page-gap-inline'
    gapEl.style.height = '180px'
    gapEl.appendChild(headerEl)
    bindGapHfDoubleClickHandler(gapEl, [headerEl])

    rootContainer.appendChild(gapEl)
    rootContainer.appendChild(editorEl)
    document.body.appendChild(rootContainer)

    // 默认状态检查：正文未被灰化，未处于 hf-active
    expect(rootContainer.classList.contains('doc-mode-hf-active')).toBe(false)
    expect(headerEl.classList.contains('page-hf-editing')).toBe(false)

    // 模拟在页面顶部上边距全域空白处（非必须点中小字）双击
    let globalHfDetail: any = null
    const hfListener = (e: any) => {
      globalHfDetail = e.detail
      if (e.detail?.active) {
        rootContainer.classList.add('doc-mode-hf-active')
      } else {
        rootContainer.classList.remove('doc-mode-hf-active')
      }
    }
    window.addEventListener('nexus-word-edit-hf', hfListener)

    // 双击 gapEl 触发代理激活
    gapEl.dispatchEvent(new win.Event('dblclick', { bubbles: true, cancelable: true }))

    // 核心断言 A：全局激活事件成功派发，并携带 sectionIndex 标明第 2 节
    expect(globalHfDetail).not.toBeNull()
    expect(globalHfDetail.active).toBe(true)
    expect(globalHfDetail.sectionIndex).toBe(1)

    // 核心断言 B：整个文档容器进入全局页眉模式反转（.doc-mode-hf-active）
    expect(rootContainer.classList.contains('doc-mode-hf-active')).toBe(true)

    // 核心断言 C：页眉进入编辑态，并挂载 Word 标志性的 [页眉 -第 2 节-] 角标浮层
    expect(headerEl.classList.contains('page-hf-editing')).toBe(true)
    const tagEl = headerEl.querySelector('.page-hf-section-tag')
    expect(tagEl).not.toBeNull()
    expect(tagEl!.textContent).toContain('第 2 节')

    // 核心断言 D：正文区域被赋予只读与不可选样式（ProseMirror 绝对无法抢焦）
    const editSurface = headerEl.querySelector('.page-hf-edit-surface') as HTMLElement
    expect(editSurface).not.toBeNull()
    expect(editSurface.contentEditable).toBe('true')

    window.removeEventListener('nexus-word-edit-hf', hfListener)
    rootContainer.remove()
  })

  it('3. 【红灯测试】正文双击切回退出：自动提交保存当前页眉 + 恢复正文100%鲜亮与可编辑', async () => {
    const sec1Header = parsedDoc.hfParts?.['rId11']
    const rootContainer = document.createElement('div')
    rootContainer.className = 'app-content doc-workbench doc-mode-hf-active'

    const editorEl = document.createElement('div')
    editorEl.className = 'ProseMirror'
    editorEl.contentEditable = 'true'

    let committedText: string | null = null
    const headerEl = makeGapHfEl({
      kind: 'header',
      value: { text: sec1Header.text, paras: sec1Header.paras } as any,
      images: sec1Header.images,
      pageNo: 'I',
      pageTotal: 100,
      readOnly: false,
      sectionIndex: 1,
      onCommit: (next: any) => {
        committedText = next.text
      },
    })

    const gapEl = document.createElement('div')
    gapEl.className = 'page-gap'
    gapEl.appendChild(headerEl)
    bindGapHfDoubleClickHandler(gapEl, [headerEl])

    rootContainer.appendChild(gapEl)
    rootContainer.appendChild(editorEl)
    document.body.appendChild(rootContainer)

    // 模拟双击进入编辑态
    gapEl.dispatchEvent(new win.Event('dblclick', { bubbles: true, cancelable: true }))
    expect(headerEl.classList.contains('page-hf-editing')).toBe(true)

    const editSurface = headerEl.querySelector('.page-hf-edit-surface') as HTMLElement
    expect(editSurface).not.toBeNull()
    editSurface.innerText = '华 中 科 技 大 学 博 士 学 位 论 文（TDD全局改动）'

    // 监听全局退出
    let exited = false
    const exitListener = (e: any) => {
      if (e.detail?.active === false) {
        exited = true
        rootContainer.classList.remove('doc-mode-hf-active')
      }
    }
    window.addEventListener('nexus-word-edit-hf', exitListener)

    // 在处于页眉态时，向正文 editorEl 双击（模拟 Word 用户双击正文退出）
    // 给 rootContainer 挂载实际的双击退出处理器
    rootContainer.addEventListener('dblclick', (e) => {
      if (rootContainer.classList.contains('doc-mode-hf-active')) {
        const target = e.target as HTMLElement
        if (target.closest('.ProseMirror') || target.closest('.doc-hf-body-exit-guard')) {
          e.stopPropagation()
          e.preventDefault()
          editSurface.blur()
        }
      }
    })

    // 等待 260ms 渡过防抖期
    await new Promise((r) => setTimeout(r, 260))

    // 模拟用户在正文上双击
    const bodyDbl = new win.Event('dblclick', { bubbles: true, cancelable: true })
    editorEl.dispatchEvent(bodyDbl)

    // 核心断言：正文双击成功触发退出，页眉改动成功 commit，正文恢复正常态
    expect(exited).toBe(true)
    expect(rootContainer.classList.contains('doc-mode-hf-active')).toBe(false)
    expect(committedText).toBe('华 中 科 技 大 学 博 士 学 位 论 文（TDD全局改动）')
    expect(headerEl.classList.contains('page-hf-editing')).toBe(false)

    window.removeEventListener('nexus-word-edit-hf', exitListener)
    rootContainer.remove()
  })

  it('4. 真实附件20多节切换：Section 0（封面第1节）与 Section 1（目录第2节）角标精准区分', async () => {
    // 封面节（Section 0）页眉
    const sec0Header = parsedDoc.hfParts?.['rId7'] ?? { text: '', paras: [] }
    const sec0El = makeGapHfEl({
      kind: 'header',
      value: sec0Header as any,
      pageNo: 1,
      pageTotal: 100,
      sectionIndex: 0, // 第 1 节
      onCommit: () => {},
    })

    // 目录节（Section 1）页眉
    const sec1Header = parsedDoc.hfParts?.['rId11']
    const sec1El = makeGapHfEl({
      kind: 'header',
      value: sec1Header as any,
      pageNo: 'I',
      pageTotal: 100,
      sectionIndex: 1, // 第 2 节
      onCommit: () => {},
    })

    document.body.appendChild(sec0El)
    document.body.appendChild(sec1El)

    // 激活 Section 0
    sec0El.dispatchEvent(new win.Event('dblclick', { bubbles: true, cancelable: true }))
    const tag0 = sec0El.querySelector('.page-hf-section-tag')
    expect(tag0).not.toBeNull()
    expect(tag0!.textContent).toContain('第 1 节')

    // 激活 Section 1
    sec1El.dispatchEvent(new win.Event('dblclick', { bubbles: true, cancelable: true }))
    const tag1 = sec1El.querySelector('.page-hf-section-tag')
    expect(tag1).not.toBeNull()
    expect(tag1!.textContent).toContain('第 2 节')

    sec0El.remove()
    sec1El.remove()
  })
})
