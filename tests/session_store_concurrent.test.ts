/**
 * TDD Test Suite: P1-S4 sessionStore.persistIndex 并发加固
 * Contract: docs/CONTRACT-P1-S3-S4.md(D1–D3)
 *
 * R13:persistIndex 原为非原子整文件写,并发 append/listSessions 可撕裂 index.json。
 * 本套件用真实 SessionStore + 并发负载锁定:原子性(可解析)、完整性(不丢会话)、
 * 无临时文件残留。与 session_store.test.ts 互补(那边测行为,这边测并发正确性)。
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs'
import { SessionStore } from '../src/main/session/sessionStore'
import type { ChatMessage } from '../src/shared/types'

const TEST_DIR = join(process.cwd(), 'tests', '.temp_sessions_conc_' + Date.now())

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

function makeMsg(i: number): ChatMessage {
  return { id: `m${i}_${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: `msg ${i}`, timestamp: Date.now() }
}

function readIndexRaw(dir: string): string {
  return readFileSync(join(dir, 'index.json'), 'utf-8')
}

describe('SessionStore persistIndex — D1 并发 append 原子性与完整性', () => {
  it('8 会话 × 10 消息并发追加:index 可解析、全会话在册、无 .tmp 残留', async () => {
    const store = new SessionStore(TEST_DIR)
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.createSession(`conc-${i}`, 'D:/Agent'))
    )
    await Promise.all(
      sessions.flatMap((s, si) =>
        Array.from({ length: 10 }, (_, mi) => store.appendMessage(s.id, makeMsg(si * 10 + mi)))
      )
    )
    // 原子性:整个文件是合法 JSON(撕裂 = 解析抛错)
    const parsed = JSON.parse(readIndexRaw(TEST_DIR))
    expect(Array.isArray(parsed)).toBe(true)
    // 完整性:8 个会话都在
    const ids = new Set((parsed as Array<{ id: string }>).map((x) => x.id))
    for (const s of sessions) expect(ids.has(s.id)).toBe(true)
    // 无临时文件残留
    const leftovers = readdirSync(TEST_DIR).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('D2: append 与 listSessions 交错竞跑不抛异常、index 全程可解析', async () => {
    const store = new SessionStore(TEST_DIR)
    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, i) => store.createSession(`race-${i}`, 'D:/Agent'))
    )
    const jobs: Array<Promise<unknown>> = []
    for (let round = 0; round < 5; round++) {
      for (const s of sessions) jobs.push(store.appendMessage(s.id, makeMsg(round)))
      jobs.push(store.listSessions())
    }
    await Promise.all(jobs)
    const parsed = JSON.parse(readIndexRaw(TEST_DIR))
    expect((parsed as unknown[]).length).toBeGreaterThanOrEqual(sessions.length)
  })

  it('D3: 单会话 200 连发 → index 可解析、tmp 零残留', async () => {
    const store = new SessionStore(TEST_DIR)
    const s = await store.createSession('burst', 'D:/Agent')
    await Promise.all(Array.from({ length: 200 }, (_, i) => store.appendMessage(s.id, makeMsg(i))))
    const parsed = JSON.parse(readIndexRaw(TEST_DIR))
    expect((parsed as Array<{ id: string }>).some((x) => x.id === s.id)).toBe(true)
    const leftovers = readdirSync(TEST_DIR).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
