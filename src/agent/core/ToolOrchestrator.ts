import { ToolRegistry } from '../../main/agent/tools/ToolRegistry'
import { ToolResultPayload } from '../../shared/types'
import { ToolContext } from '../tools/ToolTypes'

export interface ToolCallSpec {
  id: string
  name: string
  arguments: Record<string, unknown> | string
}

export interface ToolBatch {
  isConcurrencySafe: boolean
  calls: ToolCallSpec[]
}

export interface ToolExecutionUpdate {
  toolCallId: string
  result?: ToolResultPayload
  isProgress?: boolean
  progressChunk?: string
}

export class ToolOrchestrator {
  constructor(
    private toolRegistry: ToolRegistry,
    private maxConcurrency: number = 10
  ) {}

  /**
   * Partition incoming tool calls into homogeneous batches.
   * Consecutive concurrency-safe calls are merged into a single concurrent batch.
   * Mutating/non-concurrency-safe calls form strictly serial batches.
   */
  partition(calls: ToolCallSpec[]): ToolBatch[] {
    return calls.reduce((batches: ToolBatch[], call) => {
      const tool = this.toolRegistry.getTool(call.name) as any
      let isConcurrencySafe = false

      if (tool) {
        try {
          const parsed = tool.parameters.safeParse(call.arguments)
          if (parsed.success) {
            isConcurrencySafe = Boolean(
              tool.isConcurrencySafe?.(parsed.data) ?? tool.isReadOnly?.(parsed.data)
            )
          }
        } catch {
          isConcurrencySafe = false
        }
      }

      const lastBatch = batches[batches.length - 1]
      if (isConcurrencySafe && lastBatch?.isConcurrencySafe) {
        lastBatch.calls.push(call)
      } else {
        batches.push({ isConcurrencySafe, calls: [call] })
      }
      return batches
    }, [])
  }

  /**
   * Execute partitioned batches yielding results as they complete.
   */
  async *executeBatches(
    batches: ToolBatch[],
    contextFactory: (call: ToolCallSpec) => ToolContext
  ): AsyncGenerator<ToolExecutionUpdate, void> {
    for (const batch of batches) {
      if (batch.isConcurrencySafe) {
        yield* this.runConcurrentPool(batch.calls, contextFactory)
      } else {
        for (const call of batch.calls) {
          const ctx = contextFactory(call)
          const result = await this.toolRegistry.executeTool(call.name, call.arguments, ctx)
          result.toolCallId = call.id
          yield { toolCallId: call.id, result }
        }
      }
    }
  }

  private async *runConcurrentPool(
    calls: ToolCallSpec[],
    contextFactory: (call: ToolCallSpec) => ToolContext
  ): AsyncGenerator<ToolExecutionUpdate, void> {
    const queue = [...calls]
    const executing = new Map<string, Promise<{ call: ToolCallSpec; result: ToolResultPayload }>>()

    while (queue.length > 0 || executing.size > 0) {
      // Refill the pool up to maxConcurrency unless aborted
      while (queue.length > 0 && executing.size < this.maxConcurrency) {
        const call = queue[0]
        const ctx = contextFactory(call)
        if (ctx.signal?.aborted) {
          queue.length = 0 // Clear pending calls on abort
          break
        }
        queue.shift()

        const promise = this.toolRegistry
          .executeTool(call.name, call.arguments, ctx)
          .then((result) => {
            result.toolCallId = call.id
            return { call, result }
          })
          .catch((err) => {
            const errorResult: ToolResultPayload = {
              toolCallId: call.id,
              name: call.name,
              error: String(err?.message || err),
              isError: true,
            }
            return { call, result: errorResult }
          })

        executing.set(call.id, promise)
      }

      if (executing.size > 0) {
        const finished = await Promise.race(Array.from(executing.values()))
        executing.delete(finished.call.id)
        yield { toolCallId: finished.call.id, result: finished.result }
      }
    }
  }
}
