import { describe, it, expect, afterEach } from 'bun:test'
import { resolveToolDescription } from '../src/main/agent/utils/toolSchemas'
import { setDocsEditorReadyProbe } from '../src/main/agent/utils/runtimeContext'
import { docxReadTool, docxApplyOpsTool, docxModifyBlockTool } from '../src/main/agent/tools/docxTools'
import { viewFileTool } from '../src/main/agent/tools/fileTools'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { ToolSearchManager, createToolSearchTool } from '../src/main/agent/tools/ToolSearchTool'
import { ToolRegistry } from '../src/main/agent/tools/ToolRegistry'

/**
 * P3 动态 description：docx 工具按 Live Word Canvas 状态切换描述，
 * provider 请求体与 tool_search 结果随探针联动；探针默认 false（server 安全）。
 */

const resetProbe = () => setDocsEditorReadyProbe(() => false)
afterEach(resetProbe)

describe('P3 — 动态 description（探针驱动）', () => {
  it('探针关闭（默认/server）：docx 工具描述标注 Offline disk 模式', () => {
    resetProbe()
    expect(resolveToolDescription(docxReadTool as any)).toContain('Offline disk OOXML mode')
    expect(resolveToolDescription(docxModifyBlockTool as any)).toContain('Offline disk OOXML mode')
    // apply_ops 离线不可用的事实必须告知模型
    expect(resolveToolDescription(docxApplyOpsTool as any)).toContain('UNAVAILABLE')
  })

  it('探针开启：docx 工具描述标注 Live Word Canvas ACTIVE', () => {
    setDocsEditorReadyProbe(() => true)
    expect(resolveToolDescription(docxReadTool as any)).toContain('Live Word Canvas ACTIVE')
    expect(resolveToolDescription(docxModifyBlockTool as any)).toContain('docnav://')
  })

  it('负向：探针抛异常 → fail-closed 回落 Offline（不得 crash provider 路径）', () => {
    setDocsEditorReadyProbe(() => {
      throw new Error('bridge exploded')
    })
    expect(resolveToolDescription(docxReadTool as any)).toContain('Offline disk OOXML mode')
  })

  it('静态工具不受影响（view_file 描述原样透传）', () => {
    setDocsEditorReadyProbe(() => true)
    expect(resolveToolDescription(viewFileTool as any)).toBe(viewFileTool.description as string)
  })

  it('provider 请求体随探针联动（同一工具两种描述都真实到达 API）', async () => {
    const captured: string[] = []
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      captured.push(body.tools.find((t: any) => t.name === 'docx_read').description)
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        text: async () => '',
      } as any
    }
    try {
      const provider = new AnthropicProvider({ model: 'm', apiKey: 'k' } as any)
      resetProbe()
      await provider.chatStream([{ role: 'user', content: 'x' }], [docxReadTool] as any[], () => {})
      setDocsEditorReadyProbe(() => true)
      await provider.chatStream([{ role: 'user', content: 'x' }], [docxReadTool] as any[], () => {})
    } finally {
      ;(globalThis as any).fetch = realFetch
    }
    expect(captured[0]).toContain('Offline disk OOXML mode')
    expect(captured[1]).toContain('Live Word Canvas ACTIVE')
  })

  it('tool_search 结果文案使用解析后的动态描述', async () => {
    const registry = new ToolRegistry()
    const manager = new ToolSearchManager()
    registry.registerTool(docxReadTool)
    registry.registerTool(createToolSearchTool(registry, manager))
    const searchTool = registry.getTool('tool_search')!

    setDocsEditorReadyProbe(() => true)
    manager.markDiscovered('tool_search')
    const live = await searchTool.execute({ query: 'docx inspect structure' }, { workspaceRoot: '.' } as any)

    resetProbe()
    const offline = await searchTool.execute({ query: 'docx inspect structure' }, { workspaceRoot: '.' } as any)

    expect(String(live)).toContain('Live Word Canvas ACTIVE')
    expect(String(offline)).toContain('Offline disk OOXML mode')
  })
})
