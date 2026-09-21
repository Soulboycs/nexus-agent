import { describe, it, expect } from 'bun:test'
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win as any
globalThis.document = win.document as any
globalThis.Event = win.Event as any
globalThis.CustomEvent = win.CustomEvent as any
globalThis.HTMLElement = win.HTMLElement as any
globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any
globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id) as any

import {
  CHINESE_FONT_SIZE_MAP,
  PT_TO_CHINESE_FONT_SIZE,
  FONT_SIZES,
  parseFontSizeInput,
  formatFontSizeDisplay,
} from '../../src/renderer/src/components/word/font-sizes'

import {
  applyTablePreset,
  type TablePreset,
} from '../../src/renderer/src/components/word/editor/table-properties'

import {
  marginsFitPage,
  cmFromTwips,
  twipsFromCmInput,
  type PageMargins,
} from '../../src/renderer/src/components/word/components/MarginDialog'

import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/renderer/src/components/word/editor/extensions'
import { setParaAttrs } from '../../src/renderer/src/components/word/components/ribbon-tabs'

describe('Word 1:1 核心排版与交互差距优先攻坚验证套件 (P1 阶段)', () => {
  describe('1. 中文字号阶梯体系 (初号~八号与 pt 双向映射)', () => {
    it('权威中文字号映射与磅值换算完全精准', () => {
      expect(CHINESE_FONT_SIZE_MAP['初号']).toBe(42)
      expect(CHINESE_FONT_SIZE_MAP['小初']).toBe(36)
      expect(CHINESE_FONT_SIZE_MAP['一号']).toBe(26)
      expect(CHINESE_FONT_SIZE_MAP['小一']).toBe(24)
      expect(CHINESE_FONT_SIZE_MAP['二号']).toBe(22)
      expect(CHINESE_FONT_SIZE_MAP['小二']).toBe(18)
      expect(CHINESE_FONT_SIZE_MAP['三号']).toBe(16)
      expect(CHINESE_FONT_SIZE_MAP['小三']).toBe(15)
      expect(CHINESE_FONT_SIZE_MAP['四号']).toBe(14)
      expect(CHINESE_FONT_SIZE_MAP['小四']).toBe(12)
      expect(CHINESE_FONT_SIZE_MAP['五号']).toBe(10.5)
      expect(CHINESE_FONT_SIZE_MAP['小五']).toBe(9)
      expect(CHINESE_FONT_SIZE_MAP['六号']).toBe(7.5)
      expect(CHINESE_FONT_SIZE_MAP['小六']).toBe(6.5)
      expect(CHINESE_FONT_SIZE_MAP['七号']).toBe(5.5)
      expect(CHINESE_FONT_SIZE_MAP['八号']).toBe(5)
    })

    it('支持输入中文名称或阿拉伯数字并准确解析', () => {
      expect(parseFontSizeInput('小四')).toBe(12)
      expect(parseFontSizeInput('五号')).toBe(10.5)
      expect(parseFontSizeInput('  初号  ')).toBe(42)
      expect(parseFontSizeInput('12')).toBe(12)
      expect(parseFontSizeInput('10.5')).toBe(10.5)
      expect(parseFontSizeInput('16.5')).toBe(16.5)
      expect(parseFontSizeInput('invalid')).toBeNull()
      expect(parseFontSizeInput('')).toBeNull()
    })

    it('格式化显示：中文环境显示中文名称，英文环境显示磅值数字', () => {
      expect(formatFontSizeDisplay(12, 'zh')).toBe('小四')
      expect(formatFontSizeDisplay(10.5, 'zh-CN')).toBe('五号')
      expect(formatFontSizeDisplay(42, 'zh')).toBe('初号')
      expect(formatFontSizeDisplay(13, 'zh')).toBe('13') // 非标字号降级为数字
      expect(formatFontSizeDisplay(12, 'en')).toBe('12')
    })

    it('完整预设列表包含全部常用公文字号与常用标准阶梯', () => {
      const allChinesePts = Object.values(CHINESE_FONT_SIZE_MAP)
      for (const pt of allChinesePts) {
        expect(FONT_SIZES.includes(pt)).toBe(true)
      }
    })
  })

  describe('2. 学术标准“三线表”一键应用模板', () => {
    it('将普通表格转为符合 GB/T 7713.1 规范的标准学术三线表 (顶底 1.5pt，栏目线 0.75pt)', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      const editor = new Editor({
        element: container,
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
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '表头1' }] }] },
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '表头2' }] }] },
                  ],
                },
                {
                  type: 'docTableRow',
                  content: [
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '数据1' }] }] },
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '数据2' }] }] },
                  ],
                },
                {
                  type: 'docTableRow',
                  content: [
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '结尾1' }] }] },
                    { type: 'docTableCell', content: [{ type: 'docParagraph', content: [{ type: 'text', text: '结尾2' }] }] },
                  ],
                },
              ],
            },
          ],
        },
      })

      // 选中表格内部
      editor.commands.setTextSelection(3)
      expect(editor.isActive('docTable')).toBe(true)

      const preset: TablePreset = {
        label: 'ribbonTablePresetThreeLine' as any,
        headerFill: null,
        band1Fill: null,
        band2Fill: null,
        borderColor: '000000',
        kind: 'threeLine',
      }

      // 执行应用三线表命令
      const cmd = applyTablePreset(preset)
      const res = cmd(editor.state, editor.view.dispatch)
      expect(res).toBe(true)

      // 验证边框数据结构
      const tableNode = editor.state.doc.child(0)
      expect(tableNode.type.name).toBe('docTable')
      expect(tableNode.childCount).toBe(3) // 3 行

      // 第 0 行 (表头行)
      const row0 = tableNode.child(0)
      const cell00 = row0.child(0)
      expect(cell00.attrs.borders.top.szEighths).toBe(12) // 1.5pt (12 eighths)
      expect(cell00.attrs.borders.bottom.szEighths).toBe(6) // 0.75pt (6 eighths)
      expect(cell00.attrs.borders.left).toBeNull()
      expect(cell00.attrs.borders.right).toBeNull()
      expect(cell00.attrs.fill).toBeNull()

      // 第 1 行 (中间数据行)
      const row1 = tableNode.child(1)
      const cell10 = row1.child(0)
      expect(cell10.attrs.borders.top).toBeNull()
      expect(cell10.attrs.borders.bottom).toBeNull()
      expect(cell10.attrs.borders.left).toBeNull()
      expect(cell10.attrs.borders.right).toBeNull()

      // 第 2 行 (末尾行)
      const row2 = tableNode.child(2)
      const cell20 = row2.child(0)
      expect(cell20.attrs.borders.top).toBeNull()
      expect(cell20.attrs.borders.bottom.szEighths).toBe(12) // 1.5pt (12 eighths)
      expect(cell20.attrs.borders.left).toBeNull()
      expect(cell20.attrs.borders.right).toBeNull()

      editor.destroy()
      container.remove()
    })
  })

  describe('3. 标尺缩进手柄与段落格式原子写入', () => {
    it('setParaAttrs 能够原子级更新首行缩进、左缩进与右缩进', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      const editor = new Editor({
        element: container,
        extensions: editorExtensions,
        content: {
          type: 'doc',
          content: [
            {
              type: 'docParagraph',
              content: [{ type: 'text', text: '这是一个测试段落，用于验证标尺缩进滑块的拖拽生效契约。' }],
            },
          ],
        },
      })

      editor.commands.setTextSelection(2)

      // 模拟首行缩进 2 字符 (480 twips) 与左缩进 1 字符 (240 twips)
      setParaAttrs(editor, {
        indentFirstLine: 480,
        indentLeft: 240,
        indentRight: 360,
      })

      const paraAttrs = editor.state.doc.child(0).attrs
      expect(paraAttrs.indentFirstLine).toBe(480)
      expect(paraAttrs.indentLeft).toBe(240)
      expect(paraAttrs.indentRight).toBe(360)

      editor.destroy()
      container.remove()
    })
  })

  describe('4. 装订线 (Gutter) 边距与位置配置', () => {
    it('装订线与物理页边距合法性校验与单位换算', () => {
      const twips1cm = twipsFromCmInput('1', 0)
      expect(twips1cm).toBeGreaterThan(560)
      expect(twips1cm).toBeLessThan(570) // 1440 / 2.54 = ~566.9 twips

      const margins: PageMargins = {
        top: 1440,
        bottom: 1440,
        left: 1440,
        right: 1440,
        gutter: 567, // 1cm 装订线
        gutterAtTop: false, // 左侧装订
      }

      // A4 宽度 11906, 高度 16838
      expect(marginsFitPage(margins, 11906, 16838)).toBe(true)

      // 超大装订线超出页面
      const hugeMargins: PageMargins = {
        ...margins,
        gutter: 10000,
      }
      expect(marginsFitPage(hugeMargins, 11906, 16838)).toBe(false)
    })
  })
})
