import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createDefaultAgentEngine } from '../src/main/agent'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { todoWriteTool, webFetchTool, webSearchTool } from '../src/main/agent/tools/coreTools'
import { PermissionEngine } from '../src/main/agent/permissions/PermissionEngine'
import { isCommandToolName } from '../src/main/agent/utils/toolSchemas'
import type { AgentEvent } from '../src/shared/types'

/**
 * R5 — 工具目录对齐 cc（命名正名 + TodoWrite/WebFetch/WebSearch 补齐）。
 */

describe('R5 — cc 命名对齐与别名兼容', () => {
  it('正名注册：Bash/Read/Write/Edit/Glob/Grep/LS 为正名（1:1 cc）', () => {
    const registry = new ToolRegistry()
    registry.registerTool({ name: 'Bash', aliases: ['run_command', 'bash'], execute: async () => 'x' } as any)
    const viaNew = registry.getTool('Bash')
    const viaOld = registry.getTool('run_command')
    expect(viaNew).toBeDefined()
    expect(viaOld).toBe(viaNew) // 别名解析到同一工具对象
  })

  it('isCommandToolName：正名与旧名全部命中，非命令工具不命中（负向）', () => {
    for (const n of ['Bash', 'run_command', 'PowerShell', 'bash']) expect(isCommandToolName(n)).toBe(true)
    for (const n of ['Read', 'view_file', 'Write', 'LS']) expect(isCommandToolName(n)).toBe(false)
  })

  it('权限集合双覆盖：新名与旧名在 ask 模式下判定完全一致', () => {
    const engine = new PermissionEngine({ rules: [] })
    const pairs: Array<[string, string]> = [
      ['Read', 'view_file'],
      ['Write', 'write_to_file'],
      ['Edit', 'replace_file_content'],
      ['Glob', 'GlobTool'],
      ['Grep', 'GrepTool'],
      ['LS', 'list_directory'],
      ['Bash', 'run_command'],
    ]
    for (const [newName, oldName] of pairs) {
      const newRes = engine.evaluate(newName, {}, 'ask')
      const oldRes = engine.evaluate(oldName, {}, 'ask')
      // 只比较语义（behavior/requiresApproval），名字本身不同是改名的前提
      expect(`${newName} behavior=${newRes.behavior} approval=${newRes.requiresApproval}`).toBe(
        `${oldName} behavior=${oldRes.behavior} approval=${oldRes.requiresApproval}`.replace(oldName, newName)
      )
    }
    // plan 模式：TodoWrite 可用（内部状态工具），Bash 拒绝
    expect(engine.evaluate('TodoWrite', {}, 'plan').behavior).toBe('allow')
    expect(engine.evaluate('Bash', {}, 'plan').behavior).toBe('deny')
  })

  it('生产引擎注册表包含全部 cc 正名工具', () => {
    const engine = createDefaultAgentEngine({ workspaceRoot: 'C:/Temp', providerConfig: { apiKey: '' } as any })
    const names = new Set(engine.getToolRegistry().getAllTools().map((t) => t.name))
    for (const n of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebFetch', 'WebSearch', 'Agent', 'tool_search']) {
      expect(names.has(n)).toBe(true)
    }
  })
})

describe('R5 — TodoWrite', () => {
  let workspace = ''
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-r5-todo-'))
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('写入 .nexus/todos.json 并返回清单摘要（真实文件副作用）', async () => {
    const result = await todoWriteTool.execute!(
      {
        todos: [
          { content: 'Implement parser', status: 'completed' },
          { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
          { content: 'Ship', status: 'pending' },
        ],
      } as any,
      { workspaceRoot: workspace } as any
    )
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.nexus', 'todos.json'), 'utf-8'))
    expect(saved.todos.length).toBe(3)
    expect(saved.todos[1].status).toBe('in_progress')
    expect(saved.todos[1].activeForm).toBe('Writing tests')
    // R7 对齐 cc：固定确认语（不回显列表）
    expect(String(result)).toContain('Todos have been modified successfully')
  })

  it('负向：多个 in_progress 拒绝执行且不落盘', async () => {
    let thrown: any
    try {
      await todoWriteTool.execute!(
        {
          todos: [
            { content: 'a', status: 'in_progress', activeForm: 'doing a' },
            { content: 'b', status: 'in_progress', activeForm: 'doing b' },
          ],
        } as any,
        { workspaceRoot: workspace } as any
      )
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('Only one task may be in_progress')
    expect(fs.existsSync(path.join(workspace, '.nexus', 'todos.json'))).toBe(false)
  })
})

describe('R5 — WebFetch / WebSearch', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('WebFetch：HTML 去标签提取正文；非 http(s) URL 拒绝（负向）', async () => {
    ;(globalThis as any).fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () =>
          '<html><head><style>b{c}</style></head><body><script>evil()</script><h1>Hello&nbsp;World</h1><p>A &amp; B</p></body></html>',
      }) as any
    const result = await webFetchTool.execute!({ url: 'https://example.com/page', maxChars: 5000 } as any, {
      workspaceRoot: '.',
    } as any)
    expect(String(result)).toContain('Hello World')
    expect(String(result)).toContain('A & B')
    expect(String(result)).not.toContain('evil')
    expect(String(result)).not.toContain('<h1>')

    let thrown: any
    try {
      await webFetchTool.execute!({ url: 'ftp://example.com', maxChars: 100 } as any, { workspaceRoot: '.' } as any)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('http(s)')
  })

  it('WebFetch：HTTP 错误返回结构化错误（负向）', async () => {
    ;(globalThis as any).fetch = async () => ({ ok: false, status: 404, text: async () => '' }) as any
    let thrown: any
    try {
      await webFetchTool.execute!({ url: 'https://example.com/missing', maxChars: 100 } as any, {
        workspaceRoot: '.',
      } as any)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('404')
  })

  it('WebSearch：解析 DDG 结果（含 uddg 解码），空结果返回提示（负向）', async () => {
    const ddgHtml =
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs">Bun <b>docs</b></a>' +
      '<a rel="nofollow" class="result__a" href="https://example.com/direct">Direct Link</a>'
    ;(globalThis as any).fetch = async () =>
      ({ ok: true, status: 200, text: async () => ddgHtml }) as any
    const result = await webSearchTool.execute!({ query: 'bun docs', maxResults: 5 } as any, {
      workspaceRoot: '.',
    } as any)
    const text = String(result)
    expect(text).toContain('https://bun.sh/docs') // uddg 解码成功
    expect(text).toContain('Bun docs') // 内联标签剥离
    expect(text).toContain('Direct Link')

    ;(globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => '<div>nothing</div>' }) as any
    const empty = await webSearchTool.execute!({ query: 'nothing found', maxResults: 5 } as any, {
      workspaceRoot: '.',
    } as any)
    expect(String(empty)).toContain('No results parsed')
  })
})
