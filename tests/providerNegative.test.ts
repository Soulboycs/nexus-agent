import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { ResponsesProvider } from '../src/main/agent/providers/ResponsesProvider'
import { OpenAICompatibleProvider } from '../src/main/agent/providers/LLMProvider'
import { LLMStreamChunk } from '../src/main/agent/providers/LLMProvider'

// providerHttp.ts 的重试退避(2s×3)会超出 bun 默认 5s 测试超时;
// 该环境变量是 providerHttp 预留给测试的快路开关(退避 0ms,重试次数不变)
// 环境是进程级的:保存旧值,套件结束后恢复,避免泄漏到其他测试文件(如 R2/R4 默认值断言)
const __prevRetryEnv = {
  delay: process.env.NEXUS_PROVIDER_RETRY_DELAY_MS,
  max: process.env.CLAUDE_CODE_MAX_RETRIES,
  legacy: process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX,
}
afterAll(() => {
  for (const [k, v] of Object.entries({
    NEXUS_PROVIDER_RETRY_DELAY_MS: __prevRetryEnv.delay,
    CLAUDE_CODE_MAX_RETRIES: __prevRetryEnv.max,
    CLAUDE_STREAM_TRANSIENT_RETRY_MAX: __prevRetryEnv.legacy,
  })) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
})
process.env.NEXUS_PROVIDER_RETRY_DELAY_MS = '0'
// 锁定重试次数(503 用例断言 1+3=4 次尝试);并用 per-test timeout 放宽墙钟
process.env.CLAUDE_CODE_MAX_RETRIES = '3'
process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX = '3'

/**
 * P0/P1 负向 — provider 层故障面：
 * HTTP 5xx、SSE 损坏行、重试耗尽、流中途断开。
 */

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

function sseResponse(lines: string[], opts?: { errorAfter?: Error }) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      if (opts?.errorAfter) controller.error(opts.errorAfter)
      else controller.close()
    },
  })
  return { ok: true, status: 200, body: stream, text: async () => '' } as any
}

describe('Anthropic 负向', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    // R2 统一重试后，Anthropic 也走 429/5xx 重试 —— 测试用快速退避
    process.env.NEXUS_PROVIDER_RETRY_DELAY_MS = '5'
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    delete process.env.NEXUS_PROVIDER_RETRY_DELAY_MS
  })

  it('HTTP 500：抛错包含状态码与响应正文（不静默吞掉）', async () => {
    ;(globalThis as any).fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'overloaded_error',
    } as any)

    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'go' }], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect(thrown.message).toContain('500')
    expect(thrown.message).toContain('overloaded_error')
  })

  it('SSE 流中混入损坏行：忽略损坏行，后续块完成事件仍正确解析', async () => {
    const chunks: LLMStreamChunk[] = []
    ;(globalThis as any).fetch = async () =>
      sseResponse([
        'data: {broken json line\n\n',
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'view_file' } }),
        'data: [truncated\n\n',
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ filePath: 'a' }) } }),
        'garbage without data prefix\n\n',
        ev({ type: 'content_block_stop', index: 0 }),
      ])

    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    const result = await provider.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))

    const completed = chunks.flatMap((c) => c.completedToolCalls ?? [])
    expect(completed).toEqual([{ id: 't1', name: 'view_file', arguments: '{"filePath":"a"}' }])
    expect(result.toolCalls[0].arguments).toEqual({ filePath: 'a' })
  })
})

describe('Responses 负向', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('流中途断开（socket error）：chatStream 以该错误 reject', async () => {
    ;(globalThis as any).fetch = async () =>
      sseResponse(
        [ev({ type: 'response.output_text.delta', delta: 'partial text' })],
        { errorAfter: new Error('socket died') }
      )

    const provider = new ResponsesProvider({ model: 'gpt-5', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'go' }], [], () => {})
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect(String(thrown?.message || thrown)).toContain('socket died')
  })
})

describe('OpenAICompatible 负向 — 重试耗尽', () => {
  const realFetch = globalThis.fetch
  let callCount = 0
  const chunks: LLMStreamChunk[] = []

  beforeEach(() => {
    callCount = 0
    chunks.length = 0
    process.env.NEXUS_PROVIDER_RETRY_DELAY_MS = '5' 
    ;(globalThis as any).fetch = async () => {
      callCount++
      return { ok: false, status: 503, text: async () => 'service unavailable' } as any
    }
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    delete process.env.NEXUS_PROVIDER_RETRY_DELAY_MS
  })

  it('503 持续：共 4 次尝试（1 + 3 重试）后抛错，期间发出重试 statusUpdate', async () => {
    const provider = new OpenAICompatibleProvider({ model: 'x', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    let thrown: any
    try {
      await provider.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeDefined()
    expect(thrown.message).toContain('503')
    expect(callCount).toBe(4)
    const retries = chunks.filter((c) => (c.statusUpdate || '').includes('Retrying'))
    expect(retries.length).toBe(3)
  }, 15000)
})
