import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { GeminiProvider } from '../src/main/agent/providers/GeminiProvider'
import { ResponsesProvider } from '../src/main/agent/providers/ResponsesProvider'
import { LLMMessage } from '../src/main/agent/providers/LLMProvider'
import { getMaxConcurrentStreamingTools, MAX_CONCURRENT_STREAMING_TOOLS } from '../src/agent/core/StreamingToolExecutor'
import { z } from 'zod'

/**
 * R2 — 第二轮对齐回归：
 * 1. Anthropic prompt caching：三断点（内置工具前缀末尾 / system / 最后消息），
 *    MCP 工具不带标记（断点不得包含易变工具集）。
 * 2. 四 provider 统一重试策略（429/5xx/网络错误，env 可调次数与延迟）。
 * 3. 工具并发 env 覆盖（CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY）。
 */

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const eofResponse = {
  ok: true,
  status: 200,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  text: async () => '',
} as any

const mkTool = (name: string, isMcp?: boolean) => ({
  name,
  description: `desc ${name}`,
  isMcp,
  parameters: z.object({ path: z.string() }),
})

describe('R2 — Anthropic prompt caching 断点', () => {
  const realFetch = globalThis.fetch
  let bodies: any[] = []
  beforeEach(() => {
    bodies = []
    ;(globalThis as any).fetch = async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body))
      return eofResponse
    }
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    delete process.env.NEXUS_PROVIDER_RETRY_DELAY_MS
  })

  it('三断点齐全：system 块、最后一个内置工具、最后消息内容块各带 cache_control', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    const tools = [mkTool('aaa_read'), mkTool('bbb_write'), mkTool('mcp__x__tool', true)]
    await provider.chatStream(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hello' },
      ] as LLMMessage[],
      tools as any[],
      () => {}
    )

    const body = bodies[0]
    // system：块数组 + 标记
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // 工具：断点在内置前缀末尾（bbb_write），MCP 工具不带
    expect(body.tools.find((t: any) => t.name === 'bbb_write').cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools.find((t: any) => t.name === 'aaa_read').cache_control).toBeUndefined()
    expect(body.tools.find((t: any) => t.name === 'mcp__x__tool').cache_control).toBeUndefined()
    // 最后消息：字符串内容被包成带标记的块
    const last = body.messages[body.messages.length - 1]
    expect(last.content[0].type).toBe('text')
    expect(last.content[0].cache_control).toEqual({ type: 'ephemeral' })
    // 全请求消息级标记恰好一个
    const markers = body.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.cache_control) : []
    )
    expect(markers.length).toBe(1)
  })

  it('无内置工具时断点落在最后一个 MCP 工具上（不丢断点）', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    await provider.chatStream(
      [{ role: 'user', content: 'x' }] as LLMMessage[],
      [mkTool('mcp__y__tool', true)] as any[],
      () => {}
    )
    const tools = bodies[0].tools
    expect(tools[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('tool_result 数组结尾：标记加在最后一个块上，字符串不被重复包裹', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    await provider.chatStream(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'view_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'result text' },
      ] as LLMMessage[],
      [mkTool('view_file')] as any[],
      () => {}
    )
    const last = bodies[0].messages[bodies[0].messages.length - 1]
    expect(last.content[0].type).toBe('tool_result')
    expect(last.content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(bodies[0].messages[0].content[0].cache_control).toBeUndefined()
  })

  it('稳定性：相同输入两次请求的 tools+system 序列化字节一致（缓存前缀不被漂移）', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    const tools = [mkTool('aaa_read'), mkTool('bbb_write')]
    const msgs = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
    ] as LLMMessage[]
    await provider.chatStream(msgs, tools as any[], () => {})
    await provider.chatStream(msgs, tools as any[], () => {})
    expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(bodies[1].tools))
    expect(JSON.stringify(bodies[0].system)).toBe(JSON.stringify(bodies[1].system))
  })
})

describe('R2/R4 — 统一重试策略（1:1 cc withRetry 请求级语义）', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    process.env.NEXUS_PROVIDER_RETRY_DELAY_MS = '5'
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    delete process.env.NEXUS_PROVIDER_RETRY_DELAY_MS
    delete process.env.CLAUDE_CODE_MAX_RETRIES
  })

  it('CLAUDE_CODE_MAX_RETRIES=3：503 持续 → 4 次尝试 + 3 条重试 statusUpdate（cc 请求级 env）', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '3'
    let calls = 0
    const updates: string[] = []
    ;(globalThis as any).fetch = async () => {
      calls++
      return { ok: false, status: 503, text: async () => 'overloaded' } as any
    }
    const provider = new AnthropicProvider({ model: 'm', apiKey: 'k' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], (c) => {
        if (c.statusUpdate) updates.push(c.statusUpdate)
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown.message).toContain('503')
    expect(calls).toBe(4)
    expect(updates.filter((u) => u.includes('Retrying')).length).toBe(3)
  }, 15000)

  it('默认 DEFAULT_MAX_RETRIES=10（1:1 cc 常量；单元断言避免外部 env 干扰，行为验证见上一用例）', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    delete process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX
    // getProviderMaxRetries 与 fetchWithStreamingRetry 同源，纯函数无外部依赖
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProviderMaxRetries } = require('../src/main/agent/utils/providerHttp')
    expect(getProviderMaxRetries()).toBe(10)
  })

  it('Gemini：429 持续 → 按 env 限制次数重试后抛错', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      return { ok: false, status: 429, text: async () => 'rate limited' } as any
    }
    const provider = new GeminiProvider({ model: 'gemini-2.0-flash', apiKey: 'k' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown.message).toContain('429')
    expect(calls).toBe(3)
  }, 15000)

  it('R4 新增：408 请求超时属于瞬态（1:1 cc）→ 重试', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    let okBody = false
    ;(globalThis as any).fetch = async () => {
      calls++
      if (calls > 2) {
        okBody = true
        return {
          ok: true,
          status: 200,
          body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
          text: async () => '',
        } as any
      }
      return { ok: false, status: 408, text: async () => 'timeout' } as any
    }
    const provider = new ResponsesProvider({ model: 'gpt-5', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    const result = await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], () => {})
    expect(okBody).toBe(true)
    expect(calls).toBe(3)
    expect(result.fullContent).toBe('')
  }, 15000)

  it('R4 新增：x-should-retry:false → 即使 500 也不重试（1:1 cc 头语义，负向）', async () => {
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      return {
        ok: false,
        status: 500,
        headers: new Headers({ 'x-should-retry': 'false' }),
        text: async () => 'server says no',
      } as any
    }
    const provider = new AnthropicProvider({ model: 'm', apiKey: 'k' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown.message).toContain('500')
    expect(calls).toBe(1)
  }, 15000)

  it('R4 新增：x-should-retry:true → 即使 400 也重试（1:1 cc 头语义）', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      return {
        ok: false,
        status: 400,
        headers: new Headers({ 'x-should-retry': 'true' }),
        text: async () => 'retry me anyway',
      } as any
    }
    const provider = new ResponsesProvider({ model: 'gpt-5', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown.message).toContain('400')
    expect(calls).toBe(3)
  }, 15000)

  it('非瞬态 400 立即抛错不重试', async () => {
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      return { ok: false, status: 400, text: async () => 'bad request' } as any
    }
    const provider = new ResponsesProvider({ model: 'gpt-5', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'x' }] as LLMMessage[], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown.message).toContain('400')
    expect(calls).toBe(1) // 4xx 非瞬态：绝不重试
  }, 15000)
})

describe('R2 — 工具并发 env 覆盖', () => {
  const original = process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
    else process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = original
  })

  it('默认 10；env 合法值覆盖；垃圾值回落默认（负向）', () => {
    delete process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
    expect(getMaxConcurrentStreamingTools()).toBe(MAX_CONCURRENT_STREAMING_TOOLS)
    expect(MAX_CONCURRENT_STREAMING_TOOLS).toBe(10)

    process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '4'
    expect(getMaxConcurrentStreamingTools()).toBe(4)

    for (const junk of ['abc', '-3', '0', '']) {
      process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = junk
      expect(getMaxConcurrentStreamingTools()).toBe(10)
    }
  })
})
