import { describe, expect, test } from 'bun:test'
// 真实依赖文件：word/ 子树各模块的 '../shared/ipc' 都解析到这里
// （components/word/shared/ipc.ts 是零引用孪生，见契约 R8 过程记录）
import { MCP_EDITOR_COMMANDS } from '../src/renderer/src/components/shared/ipc'
import { AGENT_TOOLS } from '../src/renderer/src/components/word/ai/tools'

/**
 * R8-A 契约测试：live 桥命令面 = 内置 AGENT_TOOLS 目录的"全部同步工具"。
 *
 * 捕获的真实故障：mcp-bridge 的 switch 与 AGENT_TOOLS 目录脱节——上游新增/
 * 改名工具后桥面漂移，外部 agent 调用主进程宣称的工具名在渲染层落空。
 * 判定准则直接读运行时 AGENT_TOOLS（而非硬编码名单），工具目录一变即红。
 */

/** 主进程 agent 自行实现、不经 live 桥的异步/云/流式工具（契约 R8 §1） */
const SERVED_BY_MAIN = new Set([
  'web_search',
  'image_search',
  'insert_image',
  'generate_image',
  'create_document',
  'write_document',
])

/** 桥名与内置工具名不同者（历史命名，见 mcp-bridge mcpErrorText 同款映射） */
const BRIDGE_NAME: Record<string, string> = {
  get_document_context: 'read_document',
}

describe('R8-A: MCP 桥命令面覆盖内置工具目录', () => {
  test('命令面 = AGENT_TOOLS 同步子集 + read_document 映射 + save_document', () => {
    const expected = [
      ...AGENT_TOOLS.map((tool) => tool.name)
        .filter((name) => !SERVED_BY_MAIN.has(name))
        .map((name) => BRIDGE_NAME[name] ?? name),
      'save_document',
    ].sort()
    const actual = [...MCP_EDITOR_COMMANDS].sort()
    expect(actual).toEqual(expected)
  })

  test('命令名无重复', () => {
    expect(new Set(MCP_EDITOR_COMMANDS).size).toBe(MCP_EDITOR_COMMANDS.length)
  })

  test('AGENT_TOOLS 目录本身无重名（34 工具契约）', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBe(34)
  })

  test('异步六件套被明确排除在桥面之外', () => {
    for (const name of SERVED_BY_MAIN) {
      expect(AGENT_TOOLS.some((tool) => tool.name === name)).toBe(true)
      expect((MCP_EDITOR_COMMANDS as readonly string[]).includes(name)).toBe(false)
    }
  })
})
