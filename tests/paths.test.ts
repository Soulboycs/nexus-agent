/**
 * TDD Test Suite: P3-a 路径身份契约(计划 §6.3/R12)
 * 联动表 key 的唯一权威规范化;Windows 大小写不敏感 + 分隔符混用。
 */
import { describe, it, expect } from 'bun:test'
import { normalizeKeyPath, samePath } from '../src/shared/paths'

describe('normalizeKeyPath — P1 规范化', () => {
  it('反斜杠统一正斜杠 + 全路径小写', () => {
    expect(normalizeKeyPath('D:\\论文\\博士论文.DOCX')).toBe('d:/论文/博士论文.docx')
    expect(normalizeKeyPath('D:/论文/博士论文.docx')).toBe('d:/论文/博士论文.docx')
  })
  it('file:// 前缀剥除 + 引号/空白清理', () => {
    expect(normalizeKeyPath('file:///D:/x/y.docx')).toBe('d:/x/y.docx')
    expect(normalizeKeyPath('  "D:\\x\\y.docx" ')).toBe('d:/x/y.docx')
  })
  it('WSL UNC 前缀保留大小写(对端 ext4 大小写敏感)', () => {
    expect(normalizeKeyPath('\\\\wsl$\\Ubuntu\\Home\\A.Txt')).toBe('//wsl$/Ubuntu/Home/A.Txt')
    expect(normalizeKeyPath('\\\\wsl.localhost\\Ubuntu\\A.txt').startsWith('//wsl.localhost/Ubuntu/')).toBe(true)
  })
  it('samePath:大小写/分隔符变体等价', () => {
    expect(samePath('D:\\A\\B.docx', 'd:/a/b.docx')).toBe(true)
    expect(samePath('D:\\A\\B.docx', 'D:\\A\\C.docx')).toBe(false)
  })
})
