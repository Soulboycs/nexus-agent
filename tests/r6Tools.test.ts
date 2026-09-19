import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { notebookEditTool } from '../src/main/agent/tools/notebookTool'
import { askUserQuestionTool } from '../src/main/agent/tools/askUserQuestionTool'
import { enterPlanModeTool, exitPlanModeTool } from '../src/main/agent/tools/planModeTools'
import { skillTool } from '../src/main/agent/tools/skillTool'
import {
  taskCreateTool,
  taskListTool,
  taskOutputTool,
  taskStopTool,
  stopAllBackgroundTasks,
} from '../src/main/agent/tools/taskTools'
import { wrapMcpTool, connectMcpServers } from '../src/main/agent/tools/mcpTools'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { PermissionMode } from '../src/shared/types'

/**
 * R6 — NotebookEdit / AskUserQuestion / PlanMode / Skill / Task 系列 / MCP。
 * 除 E2E 级的 MCP 连接外全部使用真实文件与真实进程验证。
 */

let workspace = ''
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-r6-'))
})
afterEach(() => {
  stopAllBackgroundTasks()
  // Windows：后台进程可能仍持有目录句柄，延迟删除并容忍 EBUSY
  setTimeout(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true })
    } catch {
      // ignore EBUSY
    }
  }, 250)
})

const ipynb = (cells: Array<Partial<{ id: string; cell_type: string; source: string }>>) =>
  JSON.stringify({
    cells: cells.map((c, i) => ({
      id: c.id ?? `cell-${i}`,
      cell_type: c.cell_type ?? 'code',
      source: c.source ?? '',
      outputs: [],
      execution_count: null,
      metadata: {},
    })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })

describe('R6 — NotebookEdit', () => {
  const ctx = () => ({ workspaceRoot: workspace }) as any

  it('replace：更新 source 并重置 code cell 执行状态', async () => {
    fs.writeFileSync(path.join(workspace, 'n.ipynb'), ipynb([{ id: 'cell-0', source: 'print(1)' }]))
    const result = await notebookEditTool.execute!(
      { notebookPath: 'n.ipynb', cellId: 'cell-0', newSource: 'print(42)' } as any,
      ctx()
    )
    const nb = JSON.parse(fs.readFileSync(path.join(workspace, 'n.ipynb'), 'utf-8'))
    expect(nb.cells[0].source).toBe('print(42)')
    expect(nb.cells[0].execution_count).toBeNull()
    expect(String(result)).toContain('Updated code cell cell-0')
  })

  it('insert：cellType 必填（负向）+ 正常插入到指定 cell 之后', async () => {
    fs.writeFileSync(path.join(workspace, 'n.ipynb'), ipynb([{ id: 'cell-0', source: 'a' }]))
    let thrown: any
    try {
      await notebookEditTool.execute!(
        { notebookPath: 'n.ipynb', cellId: 'cell-0', newSource: 'b', editMode: 'insert' } as any,
        ctx()
      )
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('cellType is required')

    const result = await notebookEditTool.execute!(
      { notebookPath: 'n.ipynb', cellId: 'cell-0', newSource: '# md', cellType: 'markdown', editMode: 'insert' } as any,
      ctx()
    )
    const nb = JSON.parse(fs.readFileSync(path.join(workspace, 'n.ipynb'), 'utf-8'))
    expect(nb.cells.length).toBe(2)
    expect(nb.cells[1].cell_type).toBe('markdown')
    expect(String(result)).toContain('Inserted markdown cell')
  })

  it('delete + 负向：cell 不存在给出结构化错误', async () => {
    fs.writeFileSync(path.join(workspace, 'n.ipynb'), ipynb([{ id: 'cell-0', source: 'a' }, { id: 'cell-1', source: 'b' }]))
    await notebookEditTool.execute!(
      { notebookPath: 'n.ipynb', cellId: 'cell-0', newSource: '', editMode: 'delete' } as any,
      ctx()
    )
    const nb = JSON.parse(fs.readFileSync(path.join(workspace, 'n.ipynb'), 'utf-8'))
    expect(nb.cells.length).toBe(1)

    let thrown: any
    try {
      await notebookEditTool.execute!(
        { notebookPath: 'n.ipynb', cellId: 'cell-99', newSource: 'x', editMode: 'delete' } as any,
        ctx()
      )
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('Cell not found')
  })

  it('负向：非 .ipynb 文件拒绝', async () => {
    let thrown: any
    try {
      await notebookEditTool.execute!({ notebookPath: 'n.txt', cellId: 'cell-0', newSource: 'x' } as any, ctx())
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('.ipynb')
  })
})

describe('R6 — AskUserQuestion', () => {
  const questions = [
    {
      question: 'Which database should we use?',
      header: 'Database',
      options: [
        { label: 'SQLite', description: 'embedded' },
        { label: 'Postgres', description: 'server' },
      ],
    },
  ]

  it('checkPermissions 恒 ask（1:1 cc：交互发生在权限层）', async () => {
    const cp = await askUserQuestionTool.checkPermissions!(questions as any, {} as any)
    expect(cp.behavior).toBe('ask')
  })

  it('有 answers → 输出作答与 guidance；有 notes 附加', async () => {
    const result = await askUserQuestionTool.execute!(
      {
        questions,
        answers: { 'Which database should we use?': 'SQLite' },
        annotations: { 'Which database should we use?': { notes: 'no server allowed' } },
      } as any,
      {} as any
    )
    expect(String(result)).toContain('"Which database should we use?"="SQLite"')
    expect(String(result)).toContain('no server allowed')
    expect(String(result)).toContain('Continue with these answers.')
  })

  it('负向：无 answers（bypass/无审批回调）→ 提示模型自行决策且不重试', async () => {
    const result = await askUserQuestionTool.execute!({ questions } as any, {} as any)
    expect(String(result)).toContain('Do NOT call AskUserQuestion again')
    expect(String(result)).toContain('Decide yourself')
  })
})

describe('R6 — EnterPlanMode / ExitPlanMode', () => {
  function makeCtx(mode: PermissionMode) {
    const state = { mode }
    return {
      ctx: {
        workspaceRoot: workspace,
        getPermissionMode: () => state.mode,
        setPermissionMode: (m: PermissionMode) => {
          state.mode = m
        },
      } as any,
      state,
    }
  }

  it('EnterPlanMode：切换到 plan 并返回行为指令', async () => {
    const { ctx, state } = makeCtx('ask')
    const result = await enterPlanModeTool.execute!({}, ctx)
    expect(state.mode).toBe('plan')
    expect(String(result)).toContain('Plan mode is now ACTIVE')
    expect(String(result)).toContain('do NOT write or edit any files')
  })

  it('EnterPlanMode：已在 plan 模式 → 幂等提示', async () => {
    const { ctx } = makeCtx('plan')
    const result = await enterPlanModeTool.execute!({}, ctx)
    expect(String(result)).toContain('Already in plan mode')
  })

  it('ExitPlanMode：非 plan 模式拒绝（负向）；plan 模式批准后恢复 ask 并回显计划全文', async () => {
    const bad = makeCtx('ask')
    let thrown: any
    try {
      await exitPlanModeTool.execute!({ plan: 'x' } as any, bad.ctx)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('not in plan mode')

    const good = makeCtx('plan')
    const result = await exitPlanModeTool.execute!(
      { plan: '## Step 1: write tests\n## Step 2: implement', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] } as any,
      good.ctx
    )
    expect(good.state.mode).toBe('ask') // 批准后恢复
    expect(String(result)).toContain('User has approved your plan')
    expect(String(result)).toContain('## Step 1: write tests')
    expect(String(result)).toContain('run tests')
  })

  it('ExitPlanMode checkPermissions 恒 ask（计划必须经用户批准）', async () => {
    const cp = await exitPlanModeTool.checkPermissions!({ plan: 'x' } as any, {} as any)
    expect(cp.behavior).toBe('ask')
  })
})

describe('R6 — Skill', () => {
  it('加载 .agents/skills/<name>/SKILL.md，$ARGUMENTS 替换 + frontmatter 剥离', async () => {
    const dir = path.join(workspace, '.agents', 'skills', 'commit')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: commit\ndescription: create a commit\n---\nCommit the staged changes. Args: $ARGUMENTS'
    )
    const result = await skillTool.execute!({ skill: 'commit', args: 'fix login bug' } as any, {
      workspaceRoot: workspace,
    } as any)
    expect(String(result)).toContain('Launching skill: commit')
    expect(String(result)).toContain('Args: fix login bug')
    expect(String(result)).not.toContain('$ARGUMENTS')
    expect(String(result)).not.toContain('name: commit') // frontmatter 已剥离
  })

  it('负向：未知 skill → 列出可用 skills 的结构化错误', async () => {
    const dir = path.join(workspace, '.agents', 'skills', 'real-one')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: real-one\n---\nbody')
    let thrown: any
    try {
      await skillTool.execute!({ skill: 'nope' } as any, { workspaceRoot: workspace } as any)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('Unknown skill')
    expect(String(thrown?.message)).toContain('real-one')
  })
})

describe('R6 — Task 系列（真实后台进程）', () => {
  it('TaskCreate → TaskOutput 读到真实输出 → TaskStop 终止长任务', async () => {
    const ctx = { workspaceRoot: workspace } as any

    // 1. 短任务：真实输出可读
    const created = await taskCreateTool.execute!(
      { command: 'echo TASK_OUTPUT_MARKER', description: 'echo probe' } as any,
      ctx
    )
    const taskId = /task_[a-z0-9_]+/.exec(String(created))![0]
    expect(String(created)).toContain(taskId)

    let output = ''
    for (let i = 0; i < 50; i++) {
      output = String(await taskOutputTool.execute!({ taskId, lastLines: 20 } as any, ctx))
      // 等待输出到达且进程 exit 事件已触发（两件事不同时发生）
      if (output.includes('TASK_OUTPUT_MARKER') && output.includes('[completed]')) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(output).toContain('TASK_OUTPUT_MARKER')
    expect(output).toContain('[completed]')

    // 2. 长任务：TaskStop 真实终止
    const longCmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const longCreated = String(await taskCreateTool.execute!({ command: longCmd } as any, ctx))
    const longId = /task_[a-z0-9_]+/.exec(longCreated)![0]
    await new Promise((r) => setTimeout(r, 300))
    const stopResult = await taskStopTool.execute!({ taskId: longId } as any, ctx)
    expect(String(stopResult)).toContain('Stop signal sent')

    const list = String(await taskListTool.execute!({}, ctx))
    expect(list).toContain(taskId)
    expect(list).toContain(longId)
  }, 20000)

  it('负向：不存在的 taskId → 列表回显', async () => {
    const result = await taskOutputTool.execute!({ taskId: 'task_missing' } as any, { workspaceRoot: workspace } as any)
    expect(String(result)).toContain('Task not found: task_missing')
  })
})

describe('R6 — MCP 客户端', () => {
  it('wrapMcpTool：isError 透传为异常、content 拼接、空结果占位', async () => {
    const ok = wrapMcpTool(
      'srv',
      { name: 'query', description: 'run query', inputSchema: { type: 'object' } },
      async () => ({ content: [{ type: 'text', text: 'row1' }, { type: 'text', text: 'row2' }] })
    )
    expect(ok.name).toBe('mcp__srv__query')
    expect(ok.isMcp).toBe(true)
    expect(ok.mcpInfo).toEqual({ serverName: 'srv', toolName: 'query' })
    // passthrough schema：任意对象通过 zod parse
    expect(() => (ok.parameters as any).parse({ sql: 'select 1' })).not.toThrow()
    expect(await ok.execute({ sql: 'select 1' } as any, {} as any)).toContain('row1')

    const errTool = wrapMcpTool('srv', { name: 'boom' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'boom happened' }],
    }))
    let thrown: any
    try {
      await errTool.execute({} as any, {} as any)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown?.message)).toContain('boom happened')

    const empty = wrapMcpTool('srv', { name: 'empty' }, async () => ({ content: [] }))
    expect(await empty.execute({} as any, {} as any)).toContain('(empty')
  })

  it('connectMcpServers：无配置 → 零连接；缺失 command → failed（负向）', async () => {
    const empty = await connectMcpServers(workspace, new ToolRegistry())
    expect(empty.connected).toEqual([])
    expect(empty.tools).toEqual([])

    const wsWithCfg = path.join(workspace, 'cfg')
    fs.mkdirSync(path.join(wsWithCfg, '.nexus'), { recursive: true })
    fs.writeFileSync(
      path.join(wsWithCfg, '.nexus', 'mcp.json'),
      JSON.stringify({ mcpServers: { broken: { args: [] } } }) // 缺 command
    )
    const summary = await connectMcpServers(wsWithCfg, new ToolRegistry())
    expect(summary.failed.length).toBe(1)
    expect(summary.failed[0].name).toBe('broken')
    expect(summary.failed[0].error).toContain('command')
  })
})
