import { AgentEngine, AgentEngineOptions } from './core/AgentEngine'
import {
  viewFileTool,
  writeToFileTool,
  replaceFileContentTool,
  listDirectoryTool
} from './tools/fileTools'
import { runCommandTool } from './tools/commandTool'
import { globTool, grepTool } from './tools/globGrepTools'
import {
  docxReadTool,
  docxCreateTool,
  docxAppendContentTool,
  docxModifyBlockTool,
  docxApplyOpsTool,
  docxInsertTableTool,
  docxDeleteBlockTool,
  docxReadRevisionsTool,
  docxAcceptRevisionsTool,
  docxRejectRevisionsTool
} from './tools/docxTools'
import { createAgentTool } from './tools/agentTool'
import { createToolSearchTool, ToolSearchManager } from './tools/ToolSearchTool'
import { notebookEditTool } from './tools/notebookTool'
import { askUserQuestionTool } from './tools/askUserQuestionTool'
import { enterPlanModeTool, exitPlanModeTool } from './tools/planModeTools'
import { skillTool } from './tools/skillTool'
import { taskCreateTool, taskListTool, taskOutputTool, taskStopTool } from './tools/taskTools'
import { connectMcpServers } from './tools/mcpTools'
import { todoWriteTool, webFetchTool, webSearchTool } from './tools/coreTools'


export * from './core/AgentEngine'
export * from './tools/ToolRegistry'
export * from './tools/ToolResultStorage'
export * from './tools/ToolHooks'
export * from './tools/ToolSearchTool'
export * from './tools/fileTools'
export * from './tools/commandTool'
export * from './tools/globGrepTools'
export * from './tools/docxTools'
export * from './tools/agentTool'
export * from './providers/LLMProvider'
export * from './commands'
export * from './subagents'
export * from './permissions'
export * from './sandbox'
export * from './memory'


export function createDefaultAgentEngine(options: AgentEngineOptions): AgentEngine {
  // Production engines use LLM-based memory extraction (1:1 Claude Code);
  // direct construction (tests, CLI) keeps the zero-cost regex default.
  const engine = new AgentEngine({ ...options, memoryExtraction: options.memoryExtraction ?? 'llm' })
  const registry = engine.getToolRegistry()

  // Register standard ACI tools
  registry.registerTool(viewFileTool)
  registry.registerTool(writeToFileTool)
  registry.registerTool(replaceFileContentTool)
  registry.registerTool(listDirectoryTool)
  registry.registerTool(runCommandTool)
  registry.registerTool(globTool)
  registry.registerTool(grepTool)

  // R5 core tool parity (1:1 cc): TodoWrite / WebFetch / WebSearch
  registry.registerTool(todoWriteTool)
  registry.registerTool(webFetchTool)
  registry.registerTool(webSearchTool)

  // R6 tool parity: NotebookEdit / AskUserQuestion / PlanMode / Skill / Task 系列
  registry.registerTool(notebookEditTool)
  registry.registerTool(askUserQuestionTool)
  registry.registerTool(enterPlanModeTool)
  registry.registerTool(exitPlanModeTool)
  registry.registerTool(skillTool)
  registry.registerTool(taskCreateTool)
  registry.registerTool(taskListTool)
  registry.registerTool(taskOutputTool)
  registry.registerTool(taskStopTool)

  // R6 MCP 客户端：.nexus/mcp.json 的 stdio server 工具动态注册（后台，不阻塞启动）
  void connectMcpServers(process.cwd(), registry).then((summary) => {
    if (summary.connected.length || summary.failed.length) {
      console.log(
        `[MCP] connected: ${summary.connected.join(', ') || 'none'} | tools: ${summary.tools.length} | failed: ${summary.failed.map((f) => `${f.name}(${f.error})`).join(', ') || 'none'}`
      )
    }
  })

  // Register Word (.docx) tools
  registry.registerTool(docxReadTool)
  registry.registerTool(docxCreateTool)
  registry.registerTool(docxAppendContentTool)
  registry.registerTool(docxModifyBlockTool)
  registry.registerTool(docxApplyOpsTool)
  registry.registerTool(docxInsertTableTool)
  registry.registerTool(docxDeleteBlockTool)
  registry.registerTool(docxReadRevisionsTool)
  registry.registerTool(docxAcceptRevisionsTool)
  registry.registerTool(docxRejectRevisionsTool)

  // Register Subagent delegation tool
  registry.registerTool(
    createAgentTool({
      workspaceRoot: options.workspaceRoot,
      getProvider: () => engine.getProvider(),
      toolRegistry: registry
    })
  )

  // Register Tool Search Tool (dynamic deferred loading)
  const searchManager = new ToolSearchManager()
  registry.registerTool(createToolSearchTool(registry, searchManager))

  return engine
}
