/**
 * TDD Test Suite: P3/P4 session_read / session_list 工具(引用语义的精确读取通道,§6.6 L2)
 * 用户/agent 拿到引用骨架后,按需精确读取会话原文。
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { rmSync, mkdirSync } from 'fs'
import { SessionStore } from '../src/main/session/sessionStore'
import { createSessionReadTool, createSessionListTool } from '../src/main/agent/tools/sessionTools'

const DIR = join(process.cwd(), 'tests', '.temp_session_read_' + Date.now())

beforeAll(() => { mkdirSync(DIR, { recursive: true }) })
afterAll(() => { rmSync(DIR, { recursive: true, force: true }) })

async function seed() {
  const store = new SessionStore(DIR)
  const s = await store.createSession('架构讨论', 'D:/Agent')
  await store.appendMessage(s.id, { id: 'u1', role: 'user', content: '项目用什么架构?', timestamp: 1 })
  await store.appendMessage(s.id, { id: 'a1', role: 'assistant', content: '三层架构:入口/核心/工具层', timestamp: 2 })
  return { store, s }
}

describe('session_read 工具 — 精确读取(引用骨架 → 按需细读)', () => {
  it('R1: 按 sessionId 读取完整转录(角色+内容)', async () => {
    const { store, s } = await seed()
    const tool = createSessionReadTool(() => store)
    const out = await tool.execute({ sessionId: s.id }, { workspaceRoot: 'D:/Agent' } as never)
    expect(String(out)).toContain('用户: 项目用什么架构?')
    expect(String(out)).toContain('助手: 三层架构')
    rmSync(DIR, { recursive: true, force: true })
  })

  it('R2: lastN 限制条数(预算)', async () => {
    const { store, s } = await seed()
    const tool = createSessionReadTool(() => store)
    const out = await tool.execute({ sessionId: s.id, lastN: 1 }, { workspaceRoot: 'D:/Agent' } as never)
    expect(String(out)).toContain('三层架构')
    expect(String(out)).not.toContain('项目用什么架构')
    rmSync(DIR, { recursive: true, force: true })
  })

  it('R3: 不存在的会话 → 明确报错(fail-closed)', async () => {
    const { store } = await seed()
    const tool = createSessionReadTool(() => store)
    await expect(tool.execute({ sessionId: 'nope' }, { workspaceRoot: 'D:/Agent' } as never)).rejects.toThrow(/not found/i)
    rmSync(DIR, { recursive: true, force: true })
  })
})

describe('session_list 工具 — 会话枚举(找哪个会话)', () => {
  it('R4: 列出会话(id/标题/时间)', async () => {
    const { store, s } = await seed()
    const list = createSessionListTool(() => store)
    const out = String(await list.execute({}, { workspaceRoot: 'D:/Agent' } as never))
    expect(out).toContain('架构讨论')
    expect(out).toContain(s.id.slice(0, 8))
    rmSync(DIR, { recursive: true, force: true })
  })
})
