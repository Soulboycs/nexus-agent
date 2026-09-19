import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { ResponsesProvider } from '../src/main/agent/providers/ResponsesProvider'
import { GeminiProvider } from '../src/main/agent/providers/GeminiProvider'
import { LLMStreamChunk } from '../src/main/agent/providers/LLMProvider'

/**
 * P1 回归：provider SSE 解析的块级完成信号（completedToolCalls）。
 * Anthropic = content_block_stop；Responses = response.output_item.done；
 * Gemini = functionCall part 整块到达。
 */

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

function sseResponse(lines: string[]) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
  return { ok: true, status: 200, body: stream, text: async () => '' } as any
}

describe('Anthropic — content_block_stop 触发 completedToolCalls', () => {
  const realFetch = globalThis.fetch
  let chunks: LLMStreamChunk[] = []

  beforeEach(() => {
    chunks = []
    ;(globalThis as any).fetch = async () =>
      sseResponse([
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'view_file' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"filePa' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th": "a.ts"}' } }),
        ev({ type: 'content_block_stop', index: 0 }),
        ev({ type: 'message_stop' }),
      ])
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('块完成时上抛完整参数串；最终 toolCalls 解析一致', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    const result = await provider.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))

    const completed = chunks.flatMap((c) => c.completedToolCalls ?? [])
    expect(completed).toEqual([{ id: 'toolu_1', name: 'view_file', arguments: '{"filePath": "a.ts"}' }])
    expect(result.toolCalls[0].arguments).toEqual({ filePath: 'a.ts' })
  })
})

describe('Responses — response.output_item.done 触发 completedToolCalls', () => {
  const realFetch = globalThis.fetch
  let chunks: LLMStreamChunk[] = []

  beforeEach(() => {
    chunks = []
    ;(globalThis as any).fetch = async () =>
      sseResponse([
        ev({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'fc_1', name: 'view_file' } }),
        ev({ type: 'response.function_call_arguments.delta', call_id: 'fc_1', delta: '{"filePa' }),
        ev({ type: 'response.function_call_arguments.delta', call_id: 'fc_1', delta: 'th": "a.ts"}' }),
        ev({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fc_1', name: 'view_file', arguments: '{"filePath": "a.ts"}' } }),
      ])
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('item 完成时上抛累积参数；最终 toolCalls 解析一致', async () => {
    const provider = new ResponsesProvider({ model: 'gpt-5', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    const result = await provider.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))

    const completed = chunks.flatMap((c) => c.completedToolCalls ?? [])
    expect(completed).toEqual([{ id: 'fc_1', name: 'view_file', arguments: '{"filePath": "a.ts"}' }])
    expect(result.toolCalls[0].arguments).toEqual({ filePath: 'a.ts' })
  })
})

describe('Gemini — functionCall part 整块到达即完成', () => {
  const realFetch = globalThis.fetch
  let chunks: LLMStreamChunk[] = []

  beforeEach(() => {
    chunks = []
    ;(globalThis as any).fetch = async () =>
      sseResponse([
        ev({ candidates: [{ content: { parts: [{ functionCall: { name: 'view_file', args: { filePath: 'a.ts' } } }] } }] }),
      ])
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('part 到达即上抛 completedToolCalls 且 id 与最终结果一致（回归：两次 Date.now() 曾产生不同 id）', async () => {
    const provider = new GeminiProvider({ model: 'gemini-2.0-flash', apiKey: 'k' } as any)
    const result = await provider.chatStream([{ role: 'user', content: 'go' }], [], (c) => chunks.push(c))

    const completed = chunks.flatMap((c) => c.completedToolCalls ?? [])
    expect(completed.length).toBe(1)
    expect(completed[0].name).toBe('view_file')
    expect(JSON.parse(completed[0].arguments)).toEqual({ filePath: 'a.ts' })
    expect(completed[0].id).toBe(result.toolCalls[0].id)
  })
})
