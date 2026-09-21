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

import { buildSessionLabel } from '../src/renderer/src/utils/mentions'

describe('buildSessionLabel — M4 会话可区分标签(三级回退+去重)', () => {
  it('M4a: 有真实标题 → 用标题', () => {
    expect(buildSessionLabel('论文分析', undefined, 'sess-1234', new Map())).toBe('论文分析')
  })
  it('M4b: 默认标题 → 用最近任务摘要 + 短编号', () => {
    const label = buildSessionLabel('New Conversation', '帮我改第三章', 'sess-1234', new Map())
    expect(label).toBe('帮我改第三章… #1234')
  })
  it('M4c: 空会话 → 空会话标记 + 短编号', () => {
    expect(buildSessionLabel('New Conversation', undefined, 'sess-1234', new Map())).toBe('空会话 #1234')
  })
  it('M4d: 同名去重追加序号', () => {
    const used = new Map([['数据分析', 1]])
    expect(buildSessionLabel('数据分析', undefined, 'sess-5678', used)).toBe('数据分析 #2')
  })
})

import { stripMentionTokens } from '../src/renderer/src/utils/mentions'

describe('stripMentionTokens — M6 完整剥离带空格的会话名', () => {
  it('M6a: 带空格的候选名整体剥离', () => {
    const local = [...candidates, { type: 'session' as const, id: 'sess-X', name: 'Explain the project archite...' }]
    const out = stripMentionTokens('@Explain the project archite... 这里的最新会话讲的什么', local)
    expect(out).toBe('这里的最新会话讲的什么')
  })
  it('M6b: 未匹配的孤立 @token 兜底剥离', () => {
    expect(stripMentionTokens('@unknown_task 帮我跑测试', candidates)).toBe('帮我跑测试')
  })
  it('M6c: 无 @ 时原样保留', () => {
    expect(stripMentionTokens('普通问题', candidates)).toBe('普通问题')
  })
})

import { buildSessionReferenceBlock } from '../src/renderer/src/utils/mentions'

describe('buildSessionReferenceBlock — M7 会话引用块(引用语义)', () => {
  const msgs = [
    { id: '1', role: 'user', content: '帮我分析项目架构', timestamp: 1 },
    { id: '2', role: 'assistant', content: '项目分为三层:入口、核心、工具层', timestamp: 2 },
    { id: '3', role: 'user', content: '继续', timestamp: 3 }
  ] as never[]

  it('M7a: 输出标题 + 近期对话转录', () => {
    const block = buildSessionReferenceBlock('架构分析', msgs as any)
    expect(block).toContain('【引用会话:「架构分析」近期内容】')
    expect(block).toContain('用户: 帮我分析项目架构')
    expect(block).toContain('助手: 项目分为三层')
  })

  it('M7b: 预算截断:超长会话只保留近期内容且不超预算', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: String(i), role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(200), timestamp: i
    }))
    const block = buildSessionReferenceBlock('长会话', many as any, 3000)
    expect(block.length).toBeLessThanOrEqual(3200)
    expect(block).toContain('用户:')
  })

  it('M7c: 空会话 → (空)', () => {
    const block = buildSessionReferenceBlock('empty', [] as never)
    expect(block).toContain('(空)')
  })
})
