import type { ILLMProvider, LLMMessage, LLMStreamChunk } from '../providers/LLMProvider'
import type { AgentTool } from '../tools/ToolRegistry'

export interface PerfLoadOptions {
  /** 产出的总字符数(thinking 前 50% + content 后 50%) */
  totalChars: number
  /** 每个 chunk 的字符数 */
  chunkChars: number
  /** chunk 间延迟(ms;0 = 尽快,压测时建议 33) */
  delayMs: number
  /** 每 N 个 chunk 注入一次大块洪峰(0 = 关闭) */
  burstEvery?: number
  /** 洪峰字符数(默认 10_240) */
  burstChars?: number
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

/**
 * 合成流式负载 provider(计划 §8.3):
 * 性能验收的确定性负载源——固定速率 delta + 周期性大块突发,
 * 使 rAF 抖动/send 速率/内存指标在 CI 可复现。不经真实 LLM。
 */
export function createPerfLoadProvider(opts: PerfLoadOptions): ILLMProvider {
  const burstChars = opts.burstChars ?? 10_240
  const burstEvery = opts.burstEvery ?? 0
  const half = Math.floor(opts.totalChars / 2)

  async function* generate(): AsyncGenerator<LLMStreamChunk> {
    let emitted = 0
    let chunks = 0
    while (emitted < opts.totalChars) {
      const isThinking = emitted < half
      const field = isThinking ? 'thinking' : 'content'
      let size = Math.min(opts.chunkChars, opts.totalChars - emitted)
      // 洪峰:周期性把本块放大(只放大 content 段,更接近 markdown 重渲染压力)
      chunks++
      if (!isThinking && burstEvery > 0 && chunks % burstEvery === 0) {
        size = Math.min(size + burstChars, Math.max(0, opts.totalChars - emitted))
      }
      const text = 'x'.repeat(size)
      emitted += size
      yield isThinking ? { thinking: text } : { content: text }
      if (emitted < opts.totalChars) await sleep(opts.delayMs)
    }
  }

  return {
    async chatStream(
      _messages: LLMMessage[],
      _tools: AgentTool[],
      onChunk: (chunk: LLMStreamChunk) => void
    ) {
      for await (const chunk of generate()) onChunk(chunk)
      return { fullThinking: '', fullContent: '', toolCalls: [] }
    }
  } as ILLMProvider
}
