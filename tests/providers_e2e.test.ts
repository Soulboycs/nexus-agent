import { describe, it, expect } from 'bun:test'
import { MockLLMProvider } from '../src/main/agent/providers/LLMProvider'
import { AgentEngine } from '../src/main/agent/core/AgentEngine'

describe('AgentEngine E2E — MockProvider', () => {
  it('completes a full turn with text-only response', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({ content: 'Hello from mock!' })

    const engine = new AgentEngine({
      workspaceRoot: 'C:/Temp',
      customProvider: mock
    })

    const events: string[] = []
    engine.on('event', (e: any) => events.push(e.type))

    await engine.run('Say hello')

    expect(events).toContain('status_change')
    expect(events).toContain('message_delta')
    // At minimum: thinking + completed status_change
    const statusEvents = events.filter(t => t === 'status_change')
    expect(statusEvents.length).toBeGreaterThanOrEqual(2)
    expect(engine.getStatus()).toBe('completed')
  })

  it('emits thinking_delta when provider returns thinking', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({ thinking: 'Let me think...', content: 'Done thinking.' })

    const engine = new AgentEngine({ workspaceRoot: 'C:/Temp', customProvider: mock })
    const events: Array<{ type: string; delta?: string }> = []
    engine.on('event', (e: any) => events.push(e))

    await engine.run('Think hard')

    const thinkingEvents = events.filter(e => e.type === 'thinking_delta')
    expect(thinkingEvents.length).toBeGreaterThan(0)
  })

  it('switches provider via setProvider and the new provider actually serves the next turn', async () => {
    // 2026-09-18 重写：原版本仅 not.toThrow（setter 无抛错路径，永真）。
    // 现验证切换后下一回合由新 provider 真实接管。
    const mock1 = new MockLLMProvider()
    mock1.queueResponse({ content: 'FIRST_PROVIDER_OK' })
    const engine = new AgentEngine({ workspaceRoot: 'C:/Temp', customProvider: mock1 })
    await engine.run('Say first')
    expect(engine.getStatus()).toBe('completed')

    const mock2 = new MockLLMProvider()
    mock2.queueResponse({ content: 'SECOND_PROVIDER_OK' })
    engine.setProvider(mock2)

    const deltas: string[] = []
    engine.on('event', (e: any) => {
      if (e.type === 'message_delta') deltas.push(e.delta)
    })
    await engine.run('Say second')

    expect(engine.getStatus()).toBe('completed')
    // 若 setProvider 未生效，mock1 队列已空只会返回默认兜底文案
    expect(deltas.join('')).toBe('SECOND_PROVIDER_OK')
  })

  it('should abort mid-run cleanly', async () => {
    const mock = new MockLLMProvider()
    
    // Override chatStream to delay and allow abort to fire
    const originalChatStream = mock.chatStream.bind(mock)
    mock.chatStream = async (messages, tools, onChunk, signal) => {
      await new Promise(r => setTimeout(r, 20))
      if (signal?.aborted) throw new Error('AbortError')
      return originalChatStream(messages, tools, onChunk)
    }
    
    mock.queueResponse({ content: 'Step 1' })

    const engine = new AgentEngine({ workspaceRoot: 'C:/Temp', customProvider: mock })
    const runPromise = engine.run('Long task')
    
    // Abort immediately
    engine.abort()
    await runPromise

    // abort() sets status to 'idle' (cancelled cleanly)
    expect(engine.getStatus()).toBe('idle')
  })

  it('halts exactly at maxSteps with error status and step-limit message', async () => {
    // 2026-09-18 重写：原版本 toContain(['error','completed','idle']) 接受一切
    // 终态（删掉 maxSteps 逻辑也通过）。现钉死精确停点与错误语义。
    const mock = new MockLLMProvider()
    for (let i = 0; i < 10; i++) {
      mock.queueResponse({
        toolCalls: [{ id: `call_${i}`, name: 'read_file', arguments: { path: 'test.ts' } }]
      })
    }
    mock.queueResponse({ content: 'Final response' })

    const engine = new AgentEngine({
      workspaceRoot: 'C:/Temp',
      customProvider: mock,
      maxSteps: 3
    })

    const errorStatuses: Array<{ status: string; message?: string }> = []
    let toolStarts = 0
    engine.on('event', (e: any) => {
      if (e.type === 'status_change') {
        if (e.status === 'error') errorStatuses.push({ status: e.status, message: e.message })
      }
      if (e.type === 'tool_call_start') toolStarts++
    })

    await engine.run('Read files forever')

    // 恰好在第 3 步封顶 —— maxSteps 失效则会执行全部 10 次工具调用并 completed
    expect(toolStarts).toBe(3)
    expect(engine.getStatus()).toBe('error')
    expect(errorStatuses.length).toBeGreaterThan(0)
    expect(errorStatuses[0].message).toContain('maximum step limit')
  })

  it('handles multiple sequential runs', async () => {
    const mock = new MockLLMProvider()
    mock.queueResponse({ content: 'First run done' })
    mock.queueResponse({ content: 'Second run done' })

    const engine = new AgentEngine({ workspaceRoot: 'C:/Temp', customProvider: mock })

    await engine.run('First task')
    expect(engine.getStatus()).toBe('completed')

    await engine.run('Second task')
    expect(engine.getStatus()).toBe('completed')
  })
})
