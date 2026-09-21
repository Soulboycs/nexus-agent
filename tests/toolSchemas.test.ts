import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { z } from 'zod'
import { toolToJSONSchema, toGeminiParameters, resolveToolDescription } from '../src/main/agent/utils/toolSchemas'
import { viewFileTool } from '../src/main/agent/tools/fileTools'
import { runCommandTool } from '../src/main/agent/tools/commandTool'
import { docxAppendContentTool } from '../src/main/agent/tools/docxTools'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { GeminiProvider } from '../src/main/agent/providers/GeminiProvider'
import { OpenAICompatibleProvider } from '../src/main/agent/providers/LLMProvider'
import { ResponsesProvider } from '../src/main/agent/providers/ResponsesProvider'

/**
 * P0 schema 保真回归：此前 4 个 provider 各自的 extractZodProperties 把所有参数
 * 坍缩为 { type: 'string' } 且 required 恒为空 —— 模型因此倾向发字符串参数。
 * 本文件锁定 zod 类型信息（string/integer/boolean/array/object/enum、required、
 * description、数值边界）完整到达每种协议的请求体。
 */

describe('toolToJSONSchema — zod 类型保真', () => {
  it('view_file: required 含 filePath，可选数值列为 integer 且不进 required，description 保留', () => {
    const schema = toolToJSONSchema(viewFileTool as any)
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('file_path')
    const props = schema.properties as Record<string, any>
    expect(props.file_path.type).toBe('string')
    expect(props.file_path.description).toBeTruthy()
    expect(['number', 'integer']).toContain(props.offset.type)
    expect(schema.required).not.toContain('offset')
    expect(schema.required).not.toContain('limit')
  })

  it('run_command: 带 default 的 timeoutMs 不进 required（zod parse 会补默认值）', () => {
    const schema = toolToJSONSchema(runCommandTool as any)
    expect(schema.required).toContain('command')
    expect(schema.required).not.toContain('timeout')
    const props = schema.properties as Record<string, any>
    expect(['number', 'integer']).toContain(props.timeout.type)
    expect(props.command.type).toBe('string')
  })

  it('docx_append_content: 嵌套 array<object> 与 enum 完整保真', () => {
    const schema = toolToJSONSchema(docxAppendContentTool as any)
    const props = schema.properties as Record<string, any>
    const items = props.items
    expect(items.type).toBe('array')
    expect(items.description).toBeTruthy()
    const itemProps = items.items.properties as Record<string, any>
    expect(itemProps.type.enum).toEqual(['paragraph', 'heading'])
    expect(['number', 'integer']).toContain(itemProps.level.type)
    expect(items.items.required).toContain('text')
    expect(items.items.required).not.toContain('level')
  })

  it('同一工具对象命中 WeakMap 缓存（引用相等）', () => {
    const a = toolToJSONSchema(viewFileTool as any)
    const b = toolToJSONSchema(viewFileTool as any)
    expect(a).toBe(b)
  })
})

describe('toGeminiParameters — OpenAPI 子集转换', () => {
  it('类型大写、嵌套 enum 保留、Gemini 不支持的关键字被剔除', () => {
    const base = toolToJSONSchema(docxAppendContentTool as any)
    const gemini = toGeminiParameters(base) as Record<string, any>
    expect(gemini.type).toBe('OBJECT')
    const items = gemini.properties.items
    expect(items.type).toBe('ARRAY')
    expect(items.items.type).toBe('OBJECT')
    expect(items.items.properties.type.enum).toEqual(['paragraph', 'heading'])
    // Gemini function parameters 不接受 additionalProperties / default 关键字
    expect(gemini.additionalProperties).toBeUndefined()
    expect(gemini.properties.items.additionalProperties).toBeUndefined()
  })
})

describe('resolveToolDescription — 静态与动态（P3 预留）', () => {
  it('静态字符串原样返回；函数式 description 按 ctx 解析', () => {
    expect(resolveToolDescription(viewFileTool as any)).toBe(viewFileTool.description)
    const dynamic = {
      name: 't',
      description: (ctx?: { docsEditorReady?: boolean }) =>
        ctx?.docsEditorReady ? 'live canvas mode' : 'offline disk mode',
    }
    expect(resolveToolDescription(dynamic as any, { workspaceRoot: '/w', docsEditorReady: true })).toBe('live canvas mode')
    expect(resolveToolDescription(dynamic as any, { workspaceRoot: '/w', docsEditorReady: false })).toBe('offline disk mode')
    expect(resolveToolDescription(dynamic as any)).toBe('offline disk mode')
  })
})

/**
 * 协议级请求体断言：mock fetch 捕获 body（流本身立即 EOF，仅验证请求侧序列化）。
 */
const captured: { url: string; body: any }[] = []
const emptyStreamResponse = () => ({
  ok: true,
  status: 200,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  text: async () => '',
})

describe('各 provider 请求体携带完整 JSON Schema', () => {
  const realFetch = globalThis.fetch
  const tools = [viewFileTool, docxAppendContentTool] as any[]

  beforeEach(() => {
    captured.length = 0
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) })
      return emptyStreamResponse() as any
    }
  })
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  it('Anthropic: input_schema 含 required 与真实类型（回归：曾是全 string + required:[]）', async () => {
    const provider = new AnthropicProvider({ model: 'claude-3-5-sonnet', apiKey: 'k' } as any)
    await provider.chatStream([{ role: 'user', content: 'hi' }], tools, () => {})
    const tool = captured[0].body.tools.find((t: any) => t.name === 'Read')
    expect(tool.input_schema.required).toContain('file_path')
    expect(tool.input_schema.required).not.toContain('offset')
    expect(tool.input_schema.properties.file_path.type).toBe('string')
    const append = captured[0].body.tools.find((t: any) => t.name === 'docx_append_content')
    expect(append.input_schema.properties.items.type).toBe('array')
  })

  it('OpenAICompatible & Responses: function.parameters 含 required 与 enum', async () => {
    const p1 = new OpenAICompatibleProvider({ model: 'x', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    await p1.chatStream([{ role: 'user', content: 'hi' }], tools, () => {})
    const p2 = new ResponsesProvider({ model: 'x', apiKey: 'k', baseURL: 'http://localhost:9/v1' } as any)
    await p2.chatStream([{ role: 'user', content: 'hi' }], tools, () => {})
    for (const cap of captured) {
      const view = cap.body.tools.find((t: any) => t.function?.name === 'Read')
      expect(view.function.parameters.required).toContain('file_path')
      expect(['number', 'integer']).toContain(view.function.parameters.properties.offset.type)
      const append = cap.body.tools.find((t: any) => t.function?.name === 'docx_append_content')
      expect(append.function.parameters.properties.items.items.properties.type.enum).toEqual(['paragraph', 'heading'])
    }
  })

  it('Gemini: 参数用大写类型且不携带 Gemini 不支持的关键字', async () => {
    const provider = new GeminiProvider({ model: 'gemini-2.0-flash', apiKey: 'k' } as any)
    await provider.chatStream([{ role: 'user', content: 'hi' }], tools, () => {})
    const decl = captured[0].body.tools[0].functionDeclarations.find((t: any) => t.name === 'Read')
    expect(decl.parameters.type).toBe('OBJECT')
    expect(decl.parameters.properties.file_path.type).toBe('STRING')
    expect(decl.parameters.additionalProperties).toBeUndefined()
    expect(decl.parameters.properties.offset.type).toBe('INTEGER')
  })
})
