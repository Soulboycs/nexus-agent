import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { AgentTool, ToolRegistry } from './ToolRegistry'

/**
 * R6 MCP 客户端接入（1:1 cc MCP 工具桥，stdio 核心版）：
 * 从 <workspace>/.nexus/mcp.json 读取 stdio server 配置，经
 * @modelcontextprotocol/sdk 建立连接，把 server 的 tools 动态注册为
 * mcp__<server>__<tool>。连接失败 log 后跳过（不影响主流程）。
 *
 * 配置格式：
 * { "mcpServers": { "<name>": { "command": "...", "args": ["..."], "env": {} } } }
 */

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

function loadMcpConfig(workspaceRoot: string): McpConfig | null {
  const file = path.join(workspaceRoot, '.nexus', 'mcp.json')
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as McpConfig
  } catch {
    return null
  }
}

/** 包装一个 MCP tool 定义为 AgentTool（注入 client 引用以便测试） */
export function wrapMcpTool(
  serverName: string,
  tool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
): AgentTool {
  const qualified = `mcp__${serverName}__${tool.name}`
  return {
    name: qualified,
    description: tool.description || `MCP tool ${tool.name} from server ${serverName}`,
    // MCP 工具自带 JSON Schema；我们的 zod 层用 passthrough 放行任意对象，
    // 真正的校验交给远端 server（结构与 cc mcp__ 前缀工具一致）
    parameters: z.object({}).passthrough(),
    isMcp: true,
    mcpInfo: { serverName, toolName: tool.name },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    maxResultSizeChars: 30_000,
    execute: async (args: Record<string, unknown>) => {
      const result = (await callTool(tool.name, args)) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result?.isError) {
        const errText = (result.content ?? [])
          .map((c) => c.text ?? '')
          .join('\n')
        throw new Error(`MCP tool error: ${errText || 'unknown error'}`)
      }
      const text = (result?.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n')
      return text || '(empty MCP tool result)'
    },
  }
}

/**
 * 连接全部已配置 stdio server 并把其工具注册进 registry。
 * 返回连接摘要（成功/跳过/失败），供日志与测试断言。
 */
export async function connectMcpServers(
  workspaceRoot: string,
  registry: ToolRegistry
): Promise<{ connected: string[]; skipped: string[]; failed: Array<{ name: string; error: string }>; tools: string[] }> {
  const cfg = loadMcpConfig(workspaceRoot)
  const servers = cfg?.mcpServers ?? {}
  const result: { connected: string[]; skipped: string[]; failed: Array<{ name: string; error: string }>; tools: string[] } = {
    connected: [],
    skipped: [],
    failed: [],
    tools: [],
  }

  for (const [serverName, serverCfg] of Object.entries(servers)) {
    const qualifiedPrefix = `mcp__${serverName}__`
    if (registry.getAllTools().some((t) => t.name.startsWith(qualifiedPrefix))) {
      result.skipped.push(serverName)
      continue
    }
    if (!serverCfg?.command) {
      result.failed.push({ name: serverName, error: 'missing "command" in config' })
      continue
    }
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

      const transport = new StdioClientTransport({
        command: serverCfg.command,
        args: serverCfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(serverCfg.env ?? {}) },
      })
      const client = new Client({ name: 'nexus-agent', version: '0.1.0' })
      await client.connect(transport)

      const { tools } = await client.listTools()
      for (const t of tools) {
        const wrapped = wrapMcpTool(serverName, t as any, async (name, args) =>
          client.callTool({ name, arguments: args })
        )
        registry.registerTool(wrapped)
        result.tools.push(wrapped.name)
      }
      result.connected.push(serverName)
    } catch (err: any) {
      result.failed.push({ name: serverName, error: String(err?.message ?? err) })
    }
  }
  return result
}
