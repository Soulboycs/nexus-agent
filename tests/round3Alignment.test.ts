import { describe, it, expect } from 'bun:test'
import { query, expandObservablePath, buildObservableArgs } from '../src/agent/core/query'
import { ILLMProvider, LLMMessage, LLMStreamChunk, AgentTool } from '../src/main/agent/providers/LLMProvider'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { MemoryExtractor } from '../src/main/agent/memory/MemoryExtractor'
import { MemoryManager } from '../src/main/agent/memory/MemoryManager'
import { AgentEvent, ApprovalRequest } from '../src/shared/types'
import { createDefaultAgentEngine } from '../src/main/agent'
import { z } from 'zod'
import * as nodeOs from 'os'
import * as nodePath from 'path'

/**
 * R3 回归 — backfillObservableInput 与 LLM 记忆抽取。
 */

describe('R3-1 — expandObservablePath / buildObservableArgs', () => {
  const WS = 'C:/ws'.replace(/\//g, nodePath.sep)

  it('相对路径 → 基于 workspaceRoot 的绝对路径；绝对路径与 URL 原样保留（负向）', () => {
    expect(nodePath.isAbsolute(expandObservablePath('src/app.ts', 'C:/ws'))).toBe(true)
    expect(expandObservablePath('C:/abs/a.ts', 'C:/ws')).toBe('C:/abs/a.ts')
    expect(expandObservablePath('https://x.com/a', 'C:/ws')).toBe('https://x.com/a')
  })

  it('~ 展开到用户主目录', () => {
    const expanded = expandObservablePath('~/notes/a.txt', 'C:/ws')
    expect(expanded.startsWith(nodeOs.homedir())).toBe(true)
    expect(expandObservablePath('~', 'C:/ws')).toBe(nodeOs.homedir())
  })

  it('buildObservableArgs 只动路径键；command 等其余字段原样（负向）', () => {
    const out = buildObservableArgs({ filePath: 'a.ts', command: 'echo ~/x', count: 3 }, 'C:/ws')
    expect(nodePath.isAbsolute(out.filePath as string)).toBe(true)
    expect(out.command).toBe('echo ~/x') // 非路径键不展开
    expect(out.count).toBe(3)
    // 无变化时返回原引用（零拷贝快路径）
    const unchanged = { name: 'x' }
    expect(buildObservableArgs(unchanged, 'C:/ws')).toBe(unchanged)
  })
})

describe('R3-1 — gate 事件/审批可见展开路径，执行保留模型原始输入', () => {
  class ToolUseProvider implements ILLMProvider {
    constructor(private calls: any[]) {}
    async chatStream(_m: LLMMessage[], _t: AgentTool[], _c: (x: LLMStreamChunk) => void) {
      return { fullThinking: '', fullContent: '', toolCalls: this.calls.splice(0) }
    }
  }

  async function collect(q: AsyncGenerator<AgentEvent, any>) {
    const events: AgentEvent[] = []
    while (true) {
      const next = await q.next()
      if (next.done) return { events, terminal: next.value }
      events.push(next.value)
    }
  }

  it('tool_call_start 与 approval_required 展示绝对路径；execute 收到原始相对路径', async () => {
    const WS_ROOT = 'C:/Temp/nexus-r3-ws'
    const registry = new ToolRegistry()
    let executedWith: any
    const approvalRequests: ApprovalRequest[] = []
    registry.registerTool({
      name: 'sensitive_write',
      description: 'write needing approval',
      parameters: z.object({ filePath: z.string() }),
      requiresApproval: () => true,
      execute: async (args: any) => {
        executedWith = args
        return 'written'
      },
    } as any)

    const mock = new ToolUseProvider([
      { id: 'c1', name: 'sensitive_write', arguments: { filePath: 'src/app.ts' } },
    ])
    const { events, terminal } = await collect(
      query({
        messages: [{ role: 'user', content: 'go' }],
        toolRegistry: registry,
        provider: mock,
        workspaceRoot: WS_ROOT,
        onApprovalRequired: async (req) => {
          approvalRequests.push(req)
          return true
        },
      } as any)
    )

    const start = events.find((e) => e.type === 'tool_call_start') as any
    expect(nodePath.isAbsolute(start.toolCall.arguments.filePath)).toBe(true)
    expect(start.toolCall.arguments.filePath).toContain(nodePath.sep)
    expect(approvalRequests.length).toBe(1)
    expect(nodePath.isAbsolute(approvalRequests[0].arguments.filePath)).toBe(true)
    // 执行侧保留模型原始输入（1:1 Claude Code callInput 语义）
    expect(executedWith.filePath).toBe('src/app.ts')
    expect(terminal.reason).toBe('completed')
  })
})

describe('R3-2 — LLM 记忆抽取', () => {
  class FakeExtractProvider implements ILLMProvider {
    callCount = 0
    constructor(private reply: () => string, private throwErr = false) {}
    async chatStream(messages: LLMMessage[], _t: AgentTool[], _c: (x: LLMStreamChunk) => void) {
      this.callCount++
      if (this.throwErr) throw new Error('provider down')
      return { fullThinking: '', fullContent: this.reply(), toolCalls: [] }
    }
  }

  const makeExtractor = (provider: ILLMProvider, mode: 'regex' | 'llm' = 'llm') => {
    const saved: any[] = []
    const notified: any[] = []
    const mm = new MemoryManager({ workspaceRoot: 'C:/Temp/nexus-r3-mem' })
    const extractor = new MemoryExtractor({
      memoryManager: mm,
      llmProvider: provider,
      mode,
      onMemoryUpdated: (item) => notified.push(item),
    })
    const origSave = mm.saveMemory.bind(mm)
    mm.saveMemory = async (item: any) => {
      saved.push(item)
      await origSave(item)
    }
    return { extractor, saved, notified }
  }

  const messagesFor = (user: string): LLMMessage[] => [
    { role: 'user', content: user },
    { role: 'assistant', content: 'Understood, I will follow that.' },
  ]

  it('mode llm：LLM 返回合法 JSON → 保存、回调触发、类型归一', async () => {
    const provider = new FakeExtractProvider(() =>
      JSON.stringify({
        memories: [
          {
            type: 'feedback',
            name: 'Always Use Bun',
            description: 'User requires bun instead of npm',
            content: 'Use bun for all package operations.',
          },
        ],
      })
    )
    const { extractor, saved, notified } = makeExtractor(provider)
    const items = await extractor.extractFromTurn(messagesFor('Please remember to always use bun in this repo'))
    expect(provider.callCount).toBe(1)
    expect(saved.length).toBe(1)
    expect(saved[0].type).toBe('feedback')
    expect(saved[0].filename).toMatch(/^feedback_/)
    expect(notified.length).toBe(1)
    expect(items.length).toBe(1)
  })

  it('负向：LLM 抛错 → 回退正则候选（remember 触发 feedback）', async () => {
    const provider = new FakeExtractProvider(() => '', true)
    const { extractor, saved } = makeExtractor(provider)
    const items = await extractor.extractFromTurn(messagesFor('Remember: never touch the main branch directly'))
    expect(provider.callCount).toBe(1)
    expect(saved.length).toBe(1)
    expect(items[0].type).toBe('feedback')
  })

  it('负向：LLM 返回垃圾文本 → 回退正则；非法 type 被过滤', async () => {
    // 带前缀的非纯 JSON → 解析失败回退正则（本用户文本无正则命中 → 0 条）
    const garbageProvider = new FakeExtractProvider(() =>
      'Sure! Here is my answer: ' +
      JSON.stringify({
        memories: [
          { type: 'hacking', name: 'bad', description: 'x', content: 'y' },
          { type: 'project', name: 'Valid One', description: 'd', content: 'c' },
        ],
      })
    )
    const { extractor, saved } = makeExtractor(garbageProvider)
    const items1 = await extractor.extractFromTurn(messagesFor('plain text without any memory triggers'))
    expect(items1.length).toBe(0)
    expect(saved.length).toBe(0)

    // 纯 JSON 但含非法 type → 只留合法项
    const jsonProvider = new FakeExtractProvider(() =>
      JSON.stringify({
        memories: [
          { type: 'hacking', name: 'bad', description: 'x', content: 'y' },
          { type: 'project', name: 'Valid One', description: 'd', content: 'c' },
        ],
      })
    )
    const extractor2 = makeExtractor(jsonProvider).extractor
    const items2 = await extractor2.extractFromTurn(messagesFor('plain text without any memory triggers'))
    expect(items2.length).toBe(1)
    expect(items2[0].name).toBe('Valid One')
  })

  it('mode regex（默认）：完全不调用 LLM（保护既有测试契约）', async () => {
    const provider = new FakeExtractProvider(() => '{"memories":[]}')
    const { extractor, saved } = makeExtractor(provider, 'regex')
    const items = await extractor.extractFromTurn(messagesFor('Remember the deadline is Friday'))
    expect(provider.callCount).toBe(0)
    expect(saved.length).toBe(1) // 正则路径照常工作
    expect(items[0].type).toBe('feedback')
  })

  it('createDefaultAgentEngine 默认启用 llm 模式', () => {
    const engine = createDefaultAgentEngine({
      workspaceRoot: 'C:/Temp/nexus-r3-engine',
      customProvider: new FakeExtractProvider(() => '{"memories":[]}'),
    })
    const extractor = engine.getMemoryExtractor()
    expect((extractor as any).mode).toBe('llm')
  })
})
