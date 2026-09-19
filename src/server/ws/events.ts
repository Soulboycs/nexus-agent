// Exact 1:1 WebSocket events protocol from Claude Code cc-haha (src/server/ws/events.ts)

export type ChatState =
  | 'idle'
  | 'thinking'
  | 'compacting'
  | 'tool_executing'
  | 'streaming'
  | 'permission_pending'

export type PermissionMode =
  | 'ask'
  | 'plan'
  | 'bypass'

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export type ClientMessage =
  | { type: 'prewarm_session' }
  | { type: 'sync_state' }
  | { type: 'user_message'; content: string; attachments?: Array<{ path: string; name?: string }> }
  | {
      type: 'permission_response'
      requestId: string
      allowed: boolean
      denyMessage?: string
      updatedInput?: Record<string, unknown>
    }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'stop_generation' }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | {
      type: 'session_state'
      turnState: 'running' | 'idle'
      activeTasks?: string[]
    }
  | {
      type: 'content_start'
      blockType: 'text' | 'tool_use'
      toolName?: string
      toolUseId?: string
    }
  | {
      type: 'content_delta'
      text?: string
      toolInput?: string
    }
  | {
      type: 'tool_use_complete'
      toolName: string
      toolUseId: string
      input: unknown
    }
  | {
      type: 'tool_result'
      toolUseId: string
      content: unknown
      isError: boolean
    }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      toolUseId?: string
      input: unknown
      description?: string
    }
  | {
      type: 'permission_resolved'
      requestId: string
      allowed: boolean
    }
  | { type: 'message_complete'; usage?: TokenUsage }
  | { type: 'thinking'; text: string; complete?: boolean }
  | { type: 'status'; state: ChatState; message?: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong' }
