import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../src/main/agent/tools/ToolRegistry'
import { StreamingToolExecutor, MAX_CONCURRENT_STREAMING_TOOLS } from '../../src/agent/core/StreamingToolExecutor'
import { z } from 'zod'

describe('StreamingToolExecutor - Parallelism, Safety & Discard', () => {
  it('executes read-only concurrency-safe tools concurrently with correct toolCallId', async () => {
    const registry = new ToolRegistry()
    let concurrentCount = 0
    let maxConcurrentObserved = 0

    registry.registerTool({
      name: 'concurrent_read',
      description: 'concurrent test',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      parameters: z.object({ id: z.number() }),
      execute: async ({ id }, ctx) => {
        expect(ctx.toolCallId).toBeDefined()
        concurrentCount++
        maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount)
        await new Promise((r) => setTimeout(r, 20))
        concurrentCount--
        return `Read ${id}`
      }
    })

    const executor = new StreamingToolExecutor(registry, {
      workspaceRoot: process.cwd()
    })

    executor.addTool({ id: 'call_1', name: 'concurrent_read', arguments: JSON.stringify({ id: 1 }) })
    executor.addTool({ id: 'call_2', name: 'concurrent_read', arguments: JSON.stringify({ id: 2 }) })
    executor.addTool({ id: 'call_3', name: 'concurrent_read', arguments: JSON.stringify({ id: 3 }) })

    const results = []
    for await (const res of executor.drainRemaining()) {
      results.push(res)
    }

    expect(results).toHaveLength(3)
    expect(maxConcurrentObserved).toBeGreaterThanOrEqual(2)
    expect(results.map((r) => r.toolCallId)).toEqual(['call_1', 'call_2', 'call_3'])
  })

  it('serializes non-concurrency-safe tools strictly', async () => {
    const registry = new ToolRegistry()
    let running = 0
    let maxRunning = 0

    registry.registerTool({
      name: 'write_op',
      description: 'exclusive write',
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      parameters: z.object({ step: z.number() }),
      execute: async ({ step }) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 15))
        running--
        return `Wrote ${step}`
      }
    })

    const executor = new StreamingToolExecutor(registry, {
      workspaceRoot: process.cwd()
    })

    executor.addTool({ id: 'w1', name: 'write_op', arguments: { step: 1 } })
    executor.addTool({ id: 'w2', name: 'write_op', arguments: { step: 2 } })

    const results = []
    for await (const res of executor.drainRemaining()) {
      results.push(res)
    }

    expect(results).toHaveLength(2)
    expect(maxRunning).toBe(1)
  })

  it('caps concurrent streaming executions at MAX_CONCURRENT_STREAMING_TOOLS (10)', async () => {
    const registry = new ToolRegistry()
    let active = 0
    let peak = 0

    registry.registerTool({
      name: 'batch_read',
      description: 'batch read',
      isConcurrencySafe: () => true,
      parameters: z.object({ idx: z.number() }),
      execute: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      }
    })

    const executor = new StreamingToolExecutor(registry, {
      workspaceRoot: process.cwd()
    })

    // Add 15 tools
    for (let i = 0; i < 15; i++) {
      executor.addTool({ id: `call_${i}`, name: 'batch_read', arguments: { idx: i } })
    }

    const results = []
    for await (const res of executor.drainRemaining()) {
      results.push(res)
    }

    expect(results).toHaveLength(15)
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_STREAMING_TOOLS)
  })

  it('handles discard() by aborting active and cancelling queued tools', async () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      name: 'slow_task',
      description: 'slow task',
      parameters: z.object({}),
      execute: async (_, ctx) => {
        return new Promise((resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => {
            reject(new Error('Aborted by signal'))
          })
        })
      }
    })

    const executor = new StreamingToolExecutor(registry, {
      workspaceRoot: process.cwd()
    })

    executor.addTool({ id: 't1', name: 'slow_task', arguments: {} })
    executor.addTool({ id: 't2', name: 'slow_task', arguments: {} })

    // Immediately discard
    executor.discard()

    // Add a tool after discard
    executor.addTool({ id: 't3', name: 'slow_task', arguments: {} })

    const results = []
    for await (const res of executor.drainRemaining()) {
      results.push(res)
    }

    expect(results.length).toBeGreaterThan(0)
    for (const res of results) {
      expect(res.isError).toBe(true)
    }
  })
})
