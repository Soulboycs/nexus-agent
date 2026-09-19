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
