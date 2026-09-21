import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.requestAnimationFrame = ((cb: any) => setTimeout(cb, 16)) as any
globalThis.cancelAnimationFrame = ((id: any) => clearTimeout(id)) as any

import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'

describe('Expanded Cross-Reference (CrossRefModal) Headings & Captions Discovery', () => {
  it('1. Traverses editor doc to collect docHeading and caption paragraphs', () => {
    const editor = new Editor({
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docHeading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '第一章 绪论与研究背景' }]
          },
          {
            type: 'docHeading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: '1.1 国内外研究现状' }]
          },
          {
            type: 'docParagraph',
            content: [{ type: 'text', text: '相关实验对比参见图 1-1 所示。' }]
          },
          {
            type: 'docParagraph',
            content: [{ type: 'text', text: '图 1-1 总体系统架构设计示意图' }]
          },
          {
            type: 'docParagraph',
            content: [{ type: 'text', text: '表 1-1 主要软硬件环境配置参数' }]
          }
        ]
      }
    })

    const headings: Array<{ text: string; level: number }> = []
    const captions: string[] = []

    editor.state.doc.descendants((node) => {
      if (node.type.name === 'docHeading') {
        headings.push({ text: node.textContent.trim(), level: node.attrs.level })
      } else if (node.type.name === 'docParagraph') {
        const t = node.textContent.trim()
        if (/^(?:图|表|公式|Figure|Table|Equation)\s*[\d一二三四五六七八九十IVXLCDM.-]+/i.test(t)) {
          captions.push(t)
        }
      }
    })

    expect(headings.length).toBe(2)
    expect(headings[0].text).toBe('第一章 绪论与研究背景')
    expect(headings[0].level).toBe(1)
    expect(headings[1].text).toBe('1.1 国内外研究现状')
    expect(headings[1].level).toBe(2)

    expect(captions.length).toBe(2)
    expect(captions[0]).toBe('图 1-1 总体系统架构设计示意图')
    expect(captions[1]).toBe('表 1-1 主要软硬件环境配置参数')
  })
})
