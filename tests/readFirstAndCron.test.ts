import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { viewFileTool, writeToFileTool, replaceFileContentTool } from '../src/main/agent/tools/fileTools'
import {
  recordFileRead,
  assertReadBeforeWrite,
  findSimilarFile,
  clearFileStates,
} from '../src/main/agent/tools/fileState'
import { validateCronSchedule, cronMatchesNow, checkAndFire, registerCronRunner, stopCronRunner } from '../src/main/agent/tools/cronTools'
import { CronEntry } from '../src/main/agent/tools/cronTools'

/**
 * R7 判别测试（复核补缺）：read-before-write 状态机三判别 + Cron 校验/匹配/触发去重。
 * 这些用例对应测试矩阵 TM-R7-03/04/08 的可运行证据（此前复核发现矩阵引用的
 * 文件不存在）。
 */

let workspace = ''
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-readfirst-'))
  clearFileStates()
})
afterEach(() => {
  clearFileStates()
  stopCronRunner()
  fs.rmSync(workspace, { recursive: true, force: true })
})

const ctx = () => ({ workspaceRoot: workspace }) as any

describe('R7 判别 — read-before-write 状态机', () => {
  it('判别 1：已存在文件未 Read 直接 Write → 拒绝（cc 文案）', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'original')
    let thrown: any
    try {
      await writeToFileTool.execute!({ file_path: 'a.txt', content: 'blind write' } as any, ctx())
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('has not been read yet')
    // 真实副作用：文件内容未被盲写覆盖
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf-8')).toBe('original')
  })

  it('判别 2：Read 后 Write → 成功；外部修改后 Write → 陈旧拒绝；重读后放行', async () => {
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'v1')
    // Read（记录 mtime）
    await viewFileTool.execute!({ file_path: 'b.txt' } as any, ctx())
    // 正常写入
    await writeToFileTool.execute!({ file_path: 'b.txt', content: 'v2' } as any, ctx())
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf-8')).toBe('v2')

    // 外部修改（绕过状态机）
    await new Promise((r) => setTimeout(r, 2100)) // 超出 ±2s 容差
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'user-edited')
    let thrown: any
    try {
      await writeToFileTool.execute!({ file_path: 'b.txt', content: 'v3' } as any, ctx())
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('modified since read')
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf-8')).toBe('user-edited')

    // 重读后放行
    await viewFileTool.execute!({ file_path: 'b.txt' } as any, ctx())
    await writeToFileTool.execute!({ file_path: 'b.txt', content: 'v3' } as any, ctx())
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf-8')).toBe('v3')
  }, 15000)

  it('判别 3：Edit 同样受 read-first 约束；新建文件放行；findSimilarFile 给 Did-you-mean', async () => {
    // 未读 Edit → 拒绝
    fs.writeFileSync(path.join(workspace, 'c.txt'), 'hello world')
    let thrown: any
    try {
      await replaceFileContentTool.execute!(
        { file_path: 'c.txt', old_string: 'hello', new_string: 'hi' } as any,
        ctx()
      )
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('has not been read yet')

    // Read 后 Edit 成功
    await viewFileTool.execute!({ file_path: 'c.txt' } as any, ctx())
    await replaceFileContentTool.execute!(
      { file_path: 'c.txt', old_string: 'hello', new_string: 'hi' } as any,
      ctx()
    )
    expect(fs.readFileSync(path.join(workspace, 'c.txt'), 'utf-8')).toBe('hi world')

    // ENOENT 自诊：相似文件建议
    fs.writeFileSync(path.join(workspace, 'config.json'), '{}')
    let thrown2: any
    try {
      await viewFileTool.execute!({ file_path: 'config.jso' } as any, ctx())
    } catch (e) {
      thrown2 = e
    }
    expect(String(thrown2?.message)).toContain('Did you mean')

    // 新建文件（Write）不受 read-first 影响
    await writeToFileTool.execute!({ file_path: 'new-file.txt', content: 'fresh' } as any, ctx())
    expect(fs.readFileSync(path.join(workspace, 'new-file.txt'), 'utf-8')).toBe('fresh')
  })
})

describe('R7 判别 — Cron 四件套核心语义', () => {
  it('validateCronSchedule：合法通过；非法格式/超范围精确拒绝（负向）', () => {
    expect(validateCronSchedule('*/5 9-17 * * 1-5')).toBeNull()
    expect(validateCronSchedule('0 9 * * *')).toBeNull()
    expect(validateCronSchedule('* * * *')).toContain('5 fields')
    expect(validateCronSchedule('60 * * * *')).toContain('out of range')
    expect(validateCronSchedule('0 25 * * *')).toContain('out of range')
    expect(validateCronSchedule('*/abc * * * *')).toContain('Invalid step')
  })

  it('cronMatchesNow：字段/范围/步进语义（构造日期验证）', () => {
    const monday930 = new Date(2026, 8, 21, 9, 30) // 2026-09-21 周一
    expect(cronMatchesNow('30 9 * * 1-5', monday930)).toBe(true)
    expect(cronMatchesNow('*/5 9-17 * * 1-5', monday930)).toBe(true)
    expect(cronMatchesNow('0 0 * * 0', new Date(2026, 8, 20, 10, 0))).toBe(false) // 周日但小时不匹配
    expect(cronMatchesNow('10-20/2 9 * * *', new Date(2026, 8, 21, 9, 12))).toBe(true)
    expect(cronMatchesNow('10-20/2 9 * * *', new Date(2026, 8, 21, 9, 13))).toBe(false)
  })

  it('checkAndFire：到点触发回调 + lastFiredAt 落盘 + 55s 去重', async () => {
    const entry: CronEntry = {
      id: 'cron_test_1',
      prompt: 'say hello from cron',
      schedule: '* * * * *', // 每分钟都匹配
      createdAt: new Date().toISOString(),
    }
    fs.mkdirSync(path.join(workspace, '.nexus'), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, '.nexus', 'crons.json'),
      JSON.stringify({ crons: [entry] }),
      'utf-8'
    )

    let calls = 0
    registerCronRunner(workspace, async (prompt) => {
      calls++
      expect(prompt).toBe('say hello from cron')
    })

    const fired1 = await checkAndFire(workspace)
    expect(fired1).toEqual(['cron_test_1'])
    expect(calls).toBe(1)

    // 55s 去重：lastFiredAt 刚写入，同分钟内不重复触发
    const fired2 = await checkAndFire(workspace)
    expect(fired2).toEqual([])
    expect(calls).toBe(1)

    // 持久化校验
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.nexus', 'crons.json'), 'utf-8'))
    expect(saved.crons[0].lastFiredAt).toBeTruthy()
  })

  it('负向：schedule 非法的 cron 永不触发', async () => {
    fs.mkdirSync(path.join(workspace, '.nexus'), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, '.nexus', 'crons.json'),
      JSON.stringify({ crons: [{ id: 'bad', prompt: 'p', schedule: '99 99 99 99 99', createdAt: new Date().toISOString() }] }),
      'utf-8'
    )
    let calls = 0
    registerCronRunner(workspace, async () => {
      calls++
    })
    const fired = await checkAndFire(workspace)
    expect(fired).toEqual([])
    expect(calls).toBe(0)
  })
})
