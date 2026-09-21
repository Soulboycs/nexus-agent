// Types and contracts shared across Main, Preload, and Renderer

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'tool_executing'
  | 'awaiting_confirmation'
  | 'error'
  | 'completed'

export type PermissionMode =
  | 'ask'
  | 'plan'
  | 'bypass'

/** Verdict resolving a HITL approval request (1:1 Claude Code canUseTool result). */
export interface ApprovalVerdict {
  approved: boolean
  /** User-edited tool arguments from the approval dialog (1:1 Claude Code updatedInput). */
  updatedInput?: Record<string, unknown>
}

/**
 * Migrates legacy persisted mode strings to the three-mode system
 * ('default'/'acceptEdits' → 'ask', 'bypassPermissions' → 'bypass').
 * Unknown values fail closed to 'ask'.
 */
export function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === 'ask' || value === 'plan' || value === 'bypass') return value
  if (value === 'bypassPermissions') return 'bypass'
  return 'ask'
}

export interface ToolCallPayload {
  id: string
  name: string
  arguments: Record<string, unknown>
  requiresApproval?: boolean
  description?: string
}

export interface ToolResultPayload {
  toolCallId: string
  name: string
  output?: string
  error?: string
  isError: boolean
}

export interface ApprovalRequest {
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  promptMessage: string
  timestamp: number
}

export type AgentEvent =
  | { type: 'status_change'; status: AgentStatus; message?: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'message_delta'; delta: string }
  | { type: 'tool_call_start'; toolCall: ToolCallPayload }
  | { type: 'tool_call_output'; toolCallId: string; chunk: string }
  | { type: 'tool_call_complete'; result: ToolResultPayload }
  | { type: 'approval_required'; request: ApprovalRequest }
  | { type: 'token_usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'terminal_output'; chunk: string }
  | { type: 'memory_updated'; filename: string; name: string; memoryType: string }
  | { type: 'compacted'; savedTokens: number }
  | { type: 'error'; message: string; details?: string }

export type MessageBlock =
  | { type: 'text'; id: string; content: string }
  | { type: 'thinking'; id: string; content: string }
  | {
      type: 'tool'
      id: string
      toolCall: ToolCallPayload
      result?: ToolResultPayload
      status: 'running' | 'completed' | 'error'
    }

export interface ChatMessage {
  id: string
  parentId?: string | null // Pointer to parent message in DAG chain (null for root)
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  toolCalls?: ToolCallPayload[]
  toolResults?: ToolResultPayload[]
  blocks?: MessageBlock[]
  timestamp: number
  isStreaming?: boolean
}

export type ApiFormat = 'anthropic_messages' | 'chat_completions' | 'responses'

export interface ModelItem {
  id: string              // e.g. 'GLM-5.3', 'deepseek-chat', 'gpt-4o'
  name: string            // display name e.g. 'GLM-5.3', 'DeepSeek V3'
  tags?: string[]         // e.g. ['1M', '思考', '视觉', 'Fast']
  enabled: boolean        // default true
}

export interface ModelProvider {
  id: string              // unique id, e.g. 'deepseek', 'z-ai-coding-plan', 'openai'
  name: string            // display name, e.g. 'Z.ai Coding Plan 2', 'DeepSeek'
  group?: 'preset' | 'custom' // 'preset' or 'custom'
  enabled: boolean        // toggle switch in provider header
  baseURL: string         // e.g. 'https://api.deepseek.com', 'https://api.z.ai/api/anthropic'
  apiKey: string          // API Key
  apiFormat: ApiFormat    // 'anthropic_messages' | 'chat_completions' | 'responses'
  models: ModelItem[]     // list of models configured under this provider
}

export interface ProviderConfig {
  activeProviderId?: string
  activeModelId?: string
  temperature?: number
  providers?: ModelProvider[]

  // Legacy fields for backward compatibility
  providerType?: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'ollama' | 'openai-compatible'
  apiKey?: string
  baseURL?: string
  model?: string
  anthropicApiKey?: string
  geminiApiKey?: string
  ollamaBaseURL?: string
}


export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeNode[]
}

export interface SessionRecord {
  id: string
  title: string
  customTitle?: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  activeLeafId?: string | null // Active leaf node in DAG chain
  tag?: string
  agentName?: string
  agentColor?: string
  mode?: 'coordinator' | 'normal'
  lastPrompt?: string
  forkedFrom?: {
    sessionId: string
    messageUuid: string
  }
  messages: ChatMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  customTitle?: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
  activeLeafId?: string | null
  tag?: string
  agentName?: string
  agentColor?: string
  mode?: 'coordinator' | 'normal'
  lastPrompt?: string
}

export interface ConnectivityResult {
  success: boolean
  latencyMs: number
  statusCode?: number
  error?: string
}

export interface IElectronAPI {
  // Agent Control
  sendMessage: (prompt: string, workspacePath?: string, sessionId?: string) => Promise<void>
  abortAgent: () => Promise<void>
  abort?: (sessionId?: string) => Promise<void>
  respondApproval: (
    requestId: string,
    approved: boolean,
    reason?: string,
    updatedInput?: Record<string, unknown>
  ) => Promise<void>
  switchModel: (modelId: string, providerId?: string) => Promise<boolean | void>

  // Configuration
  getProviderConfig: () => Promise<ProviderConfig>
  saveProviderConfig: (config: ProviderConfig) => Promise<boolean>
  testProviderConnectivity?: (params: {
    baseURL: string
    apiKey?: string
    apiFormat: ApiFormat
    modelId?: string
  }) => Promise<ConnectivityResult>

  // Workspace
  getCurrentWorkspace: () => Promise<string>
  selectWorkspaceFolder: () => Promise<string | null>
  readWorkspaceFiles: (dirPath: string) => Promise<FileTreeNode[]>

  // Sessions Management (JSONL Append-Only Storage & Message DAG)
  listSessions?: (workspacePath?: string) => Promise<SessionSummary[]>
  getSession?: (id: string) => Promise<SessionRecord | null>
  createSession?: (title?: string, workspacePath?: string) => Promise<SessionRecord>
  deleteSession?: (id: string) => Promise<boolean>
  saveSession?: (session: SessionRecord) => Promise<boolean>
  appendMessage?: (sessionId: string, message: ChatMessage) => Promise<boolean>
  forkSession?: (sessionId: string, fromMessageId: string, newTitle?: string) => Promise<SessionRecord | null>
  /** 声明"该会话转录由 renderer pane 落盘"(pane 存续期间 main 跳过 onTurnEnd 落盘) */
  claimPersistOwner?: (sessionId: string) => Promise<boolean>
  releasePersistOwner?: (sessionId: string) => Promise<boolean>
  setActiveBranch?: (sessionId: string, leafMessageId: string) => Promise<SessionRecord | null>
  renameSession?: (sessionId: string, newTitle: string) => Promise<boolean>
  setSessionTag?: (sessionId: string, tag: string) => Promise<boolean>

  // Event Listeners
  /** 批量事件通道:{sessionId, seq, event}[](S6 事件总线消费;seq 按会话单调) */
  onAgentEventBatch: (
    callback: (batch: Array<{ sessionId: string; seq: number; event: AgentEvent }>) => void
  ) => () => void
  /** 兼容签名:由批量通道派生(过渡期 App.tsx 零改动) */
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void
  onTerminalData: (callback: (data: string) => void) => () => void
  sendTerminalInput: (data: string) => Promise<void>
  onWordFocus?: (callback: (detail: { filePath: string }) => void) => () => void

  // Permission Mode
  setPermissionMode?: (mode: PermissionMode) => Promise<void>
  getPermissionMode?: () => Promise<PermissionMode>
}

export interface IDocsAPI {
  openDocx: () => Promise<any>
  /** 仅弹文件选择框返回路径(word pane 工具条;实际打开由 tab retarget 驱动) */
  pickDocxPath?: () => Promise<string | null>
  openDocxPath: (path: string) => Promise<any>
  openDocxDecrypt: (path: string, password: string) => Promise<any>
  createBlankDoc: () => Promise<ArrayBuffer>
  saveDocx: (path: string, data: ArrayBuffer, auto?: boolean) => Promise<{ ok: boolean; error?: string }>
  saveDocxAs: (defaultName: string, data: ArrayBuffer) => Promise<{ ok: boolean; path?: string; error?: string }>
  pickImage: () => Promise<{ base64: string; mime: string; name: string } | null>
  onMcpCommand?: (callback: (message: any) => void) => () => void
  reportMcpResult?: (result: any) => void
  signalMcpReady?: (info?: { path?: string | null }) => void
  onWordFileChanged?: (callback: (detail: { filePath: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: IElectronAPI
    docsApi?: IDocsAPI
  }
}
