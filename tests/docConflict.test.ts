/**
 * TDD Test Suite: P3-e 文档冲突检测器(计划 §6.2 规则5/R6)
 * in-flight 写注册表:精确重叠判定(非时间窗);同会话互斥豁免。
 */
import { describe, it, expect } from 'bun:test'
import { DocConflictDetector } from '../src/main/agent/utils/docConflictDetector'
import { normalizeKeyPath } from '../src/shared/paths'

const K = (p: string) => normalizeKeyPath(p)

describe('DocConflictDetector — C1/C2/C3', () => {
  it('C1: A 占用时 B 查询 → 冲突并返回 A;A 自己查询 → 不冲突', () => {
    const d = new DocConflictDetector()
    d.register('sessA', 'D:\\论文\\a.docx')
    expect(d.findOther('sessB', 'd:/论文/a.docx')).toBe('sessA') // 变体路径归一
    expect(d.findOther('sessA', 'D:\\论文\\A.docx')).toBeNull() // 自己
  })

  it('C2: release 后冲突解除;多会话占用按注册计数', () => {
    const d = new DocConflictDetector()
    d.register('sessA', 'D:\\a.docx')
    d.register('sessB', 'D:\\a.docx') // 两个都 in-flight
    expect(d.findOther('sessC', 'D:\\a.docx')).not.toBeNull()
    d.release('sessA', 'D:\\a.docx')
    expect(d.findOther('sessC', 'D:\\a.docx')).toBe('sessB')
    d.release('sessB', 'D:\\a.docx')
    expect(d.findOther('sessC', 'D:\\a.docx')).toBeNull()
  })

  it('C3: 不同路径互不影响;重复 release 安全', () => {
    const d = new DocConflictDetector()
    d.register('sessA', 'D:\\x.docx')
    expect(d.findOther('sessB', 'D:\\y.docx')).toBeNull()
    d.release('sessA', 'D:\\x.docx')
    d.release('sessA', 'D:\\x.docx') // 重复 release 不抛
    expect(d.findOther('sessB', 'D:\\x.docx')).toBeNull()
  })
})
