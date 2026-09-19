/**
 * TDD Test Suite: P4 @提及解析与委派消息(计划 §6.6 L3/§6.7)
 */
import { describe, it, expect } from 'bun:test'
import {
  extractMentionQuery,
  filterMentionCandidates,
  resolveMentions,
  type MentionCandidate
} from '../src/renderer/src/utils/mentions'

const candidates: MentionCandidate[] = [
  { type: 'session', id: 'sess-A', name: '修改论文结论' },
  { type: 'session', id: 'sess-B', name: '数据分析' },
  { type: 'doc', id: 'D:\\论文\\博士论文.docx', name: '博士论文.docx' },
  { type: 'doc', id: 'D:\\数据\\实验数据.docx', name: '实验数据.docx' }
]

describe('extractMentionQuery — M1 光标处 @ 查询词', () => {
  it('M1a: @ 后无空格 → 提取查询词', () => {
    expect(extractMentionQuery('我希望@论文')).toEqual({ query: '论文', start: 3 })
    expect(extractMentionQuery('帮我 @数')).toEqual({ query: '数', start: 3 })
  })
  it('M1b: @ 后有空格/无 @ → null(弹层关闭)', () => {
    expect(extractMentionQuery('我希望@ 论文')).toBeNull()
    expect(extractMentionQuery('普通文本')).toBeNull()
  })
})

describe('filterMentionCandidates — M2 过滤与排序', () => {
  it('M2: 名称子串匹配,大小写不敏感;空查询返回全部', () => {
    expect(filterMentionCandidates(candidates, '论文').map((c) => c.id)).toEqual(['sess-A', 'D:\\论文\\博士论文.docx'])
    expect(filterMentionCandidates(candidates, '').length).toBe(4)
  })
})

describe('resolveMentions — M3 发送解析', () => {
  it('M3a: 会话提及 → 委派目标;文档提及 → 上下文路径', () => {
    const r = resolveMentions('请审查 @修改论文结论 的结果,并参考 @博士论文.docx', candidates)
    expect(r.delegatedSessionIds).toEqual(['sess-A'])
    expect(r.docPaths).toEqual(['D:\\论文\\博士论文.docx'])
  })
  it('M3b: 无提及 → 空结果;同会话多次提及去重', () => {
    expect(resolveMentions('没有提及', candidates).delegatedSessionIds).toEqual([])
    const r = resolveMentions('@数据分析 @数据分析 加把劲', candidates)
    expect(r.delegatedSessionIds).toEqual(['sess-B'])
  })
})
