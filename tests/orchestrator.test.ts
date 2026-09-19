import { describe, it, expect } from 'bun:test'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'
import { ToolOrchestrator } from '../src/agent/core/ToolOrchestrator'
import { viewFileTool, writeToFileTool, listDirectoryTool } from '../src/main/agent/tools/fileTools'
import { globTool, grepTool } from '../src/main/agent/tools/globGrepTools'
import { docxReadTool } from '../src/main/agent/tools/docxTools'
import { z } from 'zod'

describe('ToolOrchestrator - Concurrency Partitioning & Execution Tests', () => {
  it('correctly partitions consecutive read-only tools and isolates write tools', () => {
    const registry = new ToolRegistry()

    // Register read-only tools
    registry.registerTool({
      name: 'read_a',
      description: 'Read a',
      parameters: z.object({ path: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => 'data_a',
    } as any)

    registry.registerTool({
      name: 'read_b',
      description: 'Read b',
      parameters: z.object({ path: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => 'data_b',
    } as any)

    // Register mutating write tool
    registry.registerTool({
      name: 'write_c',
      description: 'Write c',
      parameters: z.object({ path: z.string() }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => 'wrote_c',
    } as any)

    const orchestrator = new ToolOrchestrator(registry)

    // Sequence: read_a, read_b, write_c, read_a
    const batches = orchestrator.partition([
      { id: '1', name: 'read_a', arguments: { path: '1.txt' } },
      { id: '2', name: 'read_b', arguments: { path: '2.txt' } },
      { id: '3', name: 'write_c', arguments: { path: '3.txt' } },
      { id: '4', name: 'read_a', arguments: { path: '4.txt' } },
    ])

    expect(batches.length).toBe(3)
    // Batch 1: Concurrent reads [read_a, read_b]
    expect(batches[0].isConcurrencySafe).toBe(true)
    expect(batches[0].calls.length).toBe(2)

    // Batch 2: Serial write [write_c]
    expect(batches[1].isConcurrencySafe).toBe(false)
    expect(batches[1].calls.length).toBe(1)

    // Batch 3: Concurrent read [read_a]
    expect(batches[2].isConcurrencySafe).toBe(true)
    expect(batches[2].calls.length).toBe(1)
  })

  it('executes concurrent read-only tools in parallel with bounded concurrency', async () => {
    const registry = new ToolRegistry()
    let concurrentCount = 0
    let peakConcurrency = 0

    registry.registerTool({
      name: 'parallel_fetch',
      description: 'Parallel read test',
      parameters: z.object({ id: z.number() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        concurrentCount++
        if (concurrentCount > peakConcurrency) peakConcurrency = concurrentCount
        await new Promise((r) => setTimeout(r, 20))
        concurrentCount--
        return 'done'
      },
    } as any)

    const orchestrator = new ToolOrchestrator(registry, 4)
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `call_${i}`,
      name: 'parallel_fetch',
      arguments: { id: i },
    }))

    const batches = orchestrator.partition(calls)
    const results: string[] = []

    for await (const update of orchestrator.executeBatches(batches, () => ({
      workspaceRoot: '.',
    }))) {
      if (update.result) {
        results.push(update.toolCallId)
      }
    }

    expect(results.length).toBe(6)
    // Peak concurrency should be greater than 1 (demonstrating true parallel execution)
    expect(peakConcurrency).toBeGreaterThan(1)
    // Peak concurrency should not exceed max limit of 4
    expect(peakConcurrency).toBeLessThanOrEqual(4)
  })

  it('correctly partitions REAL built-in tools (view_file, list_directory, GlobTool, GrepTool, docx_read vs write_to_file)', () => {
    const registry = new ToolRegistry()
    registry.registerTool(viewFileTool)
    registry.registerTool(listDirectoryTool)
    registry.registerTool(globTool)
    registry.registerTool(grepTool)
    registry.registerTool(docxReadTool)
    registry.registerTool(writeToFileTool)

    const orchestrator = new ToolOrchestrator(registry)

    // Sequence of real calls: 3 read tools, 1 write tool, 2 read tools
    const batches = orchestrator.partition([
      { id: '1', name: 'view_file', arguments: { filePath: 'a.txt' } },
      { id: '2', name: 'list_directory', arguments: { dirPath: '.' } },
      { id: '3', name: 'GlobTool', arguments: { pattern: '*.ts' } },
      { id: '4', name: 'write_to_file', arguments: { filePath: 'out.txt', content: 'hello' } },
      { id: '5', name: 'GrepTool', arguments: { pattern: 'test' } },
      { id: '6', name: 'docx_read', arguments: { filePath: 'doc.docx' } }
    ])

    expect(batches.length).toBe(3)

    // Batch 1: Real read-only tools combined concurrently
    expect(batches[0].isConcurrencySafe).toBe(true)
    expect(batches[0].calls.map((c) => c.name)).toEqual(['view_file', 'list_directory', 'GlobTool'])

    // Batch 2: Real mutating write tool isolated serially
    expect(batches[1].isConcurrencySafe).toBe(false)
    expect(batches[1].calls.map((c) => c.name)).toEqual(['write_to_file'])

    // Batch 3: Real read-only tools combined concurrently
    expect(batches[2].isConcurrencySafe).toBe(true)
    expect(batches[2].calls.map((c) => c.name)).toEqual(['GrepTool', 'docx_read'])
  })
})
