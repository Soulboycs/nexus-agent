// @vitest-environment happy-dom
/**
 * 真实行为测试（替代已删除的字符串断言垃圾测试 e-batch-contracts.test.ts）：
 * 渲染真实组件 + 真实 Tiptap 编辑器，驱动交互并断言真实副作用——
 * 不再断言源码字符串。
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'

import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import { ImageWrapPopover } from '../../src/renderer/src/components/word/components/ImageWrapPopover'
import { TableSortModal } from '../../src/renderer/src/components/word/components/TableSortModal'
import { VRuler } from '../../src/renderer/src/components/word/components/VRuler'
import { FindPanel } from '../../src/renderer/src/components/word/components/FindPanel'
import type { SectionSettings } from '@genoffice/docx-engine'

const cell = (text: string) => ({
  type: 'docTableCell',
  content: [{ type: 'docParagraph', content: text ? [{ type: 'text', text }] : [] }],
})
const row = (...cells: string[]) => ({ type: 'docTableRow', content: cells.map(cell) })

const SECTION: SectionSettings = {
  pageWidth: 11906,
  pageHeight: 16838,
  marginTop: 1440,
  marginRight: 1800,
  marginBottom: 1440,
  marginLeft: 1800,
  orientation: 'portrait',
  columns: 1,
} as SectionSettings

const twipsToPx = (twips: number) => (twips / 1440) * 96

describe('ImageWrapPopover — 选中图片浮现，环绕选项真实写入节点', () => {
  it('shows on image NodeSelection and applies the picked wrap to the node', async () => {
    const editor = new Editor({
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            content: [
              {
                type: 'docProtected',
                attrs: { blockType: 'image', imageDataUrl: 'data:image/png;base64,AAA' },
              },
            ],
          },
        ],
      },
    })
    // select the image node
    const pos = 1
    const { NodeSelection } = await import('@tiptap/pm/state')
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
    )

    const { container } = render(<ImageWrapPopover editor={editor} />)
    const toggle = container.querySelector('.image-wrap-pop-toggle')
    expect(toggle).toBeTruthy()

    fireEvent.click(toggle!)
    const options = container.querySelectorAll('.image-wrap-pop-menu button')
    expect(options.length).toBe(6) // Word layout-options set: inline/square-l/square-r/topBottom/behind/front

    // pick the second option (四周型 · 靠左) — a real non-null wrap value
    const target = options[1]!
    fireEvent.click(target!)

    let imageNode: { attrs: { imageWrap: unknown } } | null = null
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'docProtected') imageNode = n as never
    })
    expect((imageNode!.attrs as { imageWrap: unknown }).imageWrap).toBe('square-left')
    editor.destroy()
  })
})

describe('TableSortModal — 表头列名选项 + 确认后真实重排', () => {
  it('labels options from the header row and sorts descending on apply', () => {
    const editor = new Editor({
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docTable',
            content: [
              {
                type: 'docTableRow',
                content: [
                  {
                    type: 'docTableHeader',
                    content: [{ type: 'docParagraph', content: [{ type: 'text', text: '得分' }] }],
                  },
                  {
                    type: 'docTableHeader',
                    content: [{ type: 'docParagraph', content: [{ type: 'text', text: '姓名' }] }],
                  },
                ],
              },
              row('90', '张三'),
              row('60', '李四'),
            ],
          },
        ],
      },
    })
    // cursor into the first body cell so findTableAtSelection resolves
    editor.commands.setTextSelection(4)

    const { container } = render(<TableSortModal editor={editor} onClose={() => {}} />)
    // column options are labelled by the header row
    expect(container.textContent).toContain('得分')
    expect(container.textContent).toContain('姓名')
    // pick 降序 and apply
    const desc = Array.from(container.querySelectorAll('input[type="radio"]'))[1] as HTMLInputElement
    fireEvent.click(desc)
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '确定')!,
    )
    const table = editor.state.doc.child(0)
    const texts: string[] = []
    table.forEach((tr) =>
      tr.forEach((td) => texts.push(td.textContent)),
    )
    // descending by 得分: 90 before 60, header pinned
    expect(texts.slice(0, 2)).toEqual(['得分', '姓名'])
    expect(texts.slice(2, 4)).toEqual(['90', '张三'])
    editor.destroy()
  })
})

describe('VRuler — 上下边距区与拖拽把手按 section 几何渲染', () => {
  it('renders margin zones and both handles at the section-derived positions', () => {
    const { container } = render(<VRuler section={SECTION} onVerticalMargins={() => {}} />)
    const zones = container.querySelectorAll('.vruler-zone')
    expect(zones.length).toBe(2)
    const top = container.querySelector('.vruler-handle-top') as HTMLElement
    const bottom = container.querySelector('.vruler-handle-bottom') as HTMLElement
    // 1440 twips = 96px from the page top; bottom handle at page height minus margin
    expect(parseFloat(top.style.top)).toBeCloseTo(twipsToPx(1440), 3)
    expect(parseFloat(bottom.style.top)).toBeCloseTo(twipsToPx(16838 - 1440), 3)
  })
})

describe('FindPanel — 格式过滤真实驱动匹配与替换', () => {
  it('find-format narrows matches and replace-all applies the replacement format', async () => {
    const editor = new Editor({
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    })
    const add = (pos: number, text: string, color?: string) => {
      const tr = editor.state.tr
      tr.insertText(text, pos, pos)
      if (color)
        tr.addMark(pos, pos + text.length, editor.state.schema.marks.docTextStyle.create({ color }))
      else tr.removeMark(pos, pos + text.length)
      tr.setMeta('trackIgnore', true)
      editor.view.dispatch(tr)
    }
    add(1, 'red one', 'FF0000') // only this run is red — format filter must keep just its 2 'e' matches
    add(8, 'blue two')
    add(16, 'plain')

    const onClose = () => {}
    const { container } = render(<FindPanel editor={editor} onClose={onClose} />)

    // open the format popover and set find-format color = FF0000
    const fmtToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('格式'),
    )
    expect(fmtToggle).toBeTruthy()
    fireEvent.click(fmtToggle!)
    const colorInputs = container.querySelectorAll('.find-fmt-color input, input.find-fmt-color')
    const colorInput = (colorInputs.length > 0 ? colorInputs[0] : container.querySelector('.find-fmt-color')) as HTMLInputElement
    fireEvent.change(colorInput, { target: { value: '#FF0000' } })

    // query "one": text matches 2 ("one" also matches?) — "one" appears once; filter keeps only the red run
    const input = container.querySelector('.find-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'e' } })

    // debounce is 150ms — wait for the count surface to settle
    // the red run "red one" holds both 'e's; blue/plain runs hold one more —
    // the format filter must reduce "1/3" to exactly "1/2" after the debounce
    await waitFor(
      () => {
        expect(container.querySelector('.find-count')!.textContent).toMatch(/\/2$/)
      },
      { timeout: 2000 },
    )

    // replace-all: replacement 'e' -> 'e' (same text) + green format — the
    // text must survive and every replaced span must carry the new color
    const replaceInput = container.querySelectorAll('.find-input')[1] as HTMLInputElement
    expect(replaceInput).toBeTruthy()
    fireEvent.change(replaceInput, { target: { value: 'e' } })
    const replColor = container.querySelectorAll('.find-fmt-color')[1] as HTMLInputElement
    fireEvent.change(replColor, { target: { value: '#00B140' } })
    const actionButtons = Array.from(container.querySelectorAll('.find-action'))
    const replaceAllBtn = actionButtons[actionButtons.length - 1]!
    expect(replaceAllBtn).toBeTruthy()
    fireEvent.click(replaceAllBtn!)
    await waitFor(() => {
      // both replaced 'e's are green; the untouched parts of the red run keep
      // their original color — exactly Word's replace-with-format semantics
      expect(findFormatColorCount(editor, '00B140')).toBe(2)
      expect(findFormatColorCount(editor, 'FF0000')).toBe(2)
    })
    expect(editor.state.doc.textContent).toBe('red oneblue twoplain')
    editor.destroy()
  })
})

function findFormatColorCount(editor: Editor, color: string): number {
  let n = 0
  editor.state.doc.descendants((node) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'docTextStyle')
    if (mark && String(mark.attrs.color).toUpperCase() === color.toUpperCase()) n++
  })
  return n
}
