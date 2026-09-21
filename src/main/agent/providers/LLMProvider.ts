import { AgentTool } from '../tools/ToolRegistry'
import { ProviderConfig } from '@shared/types'
import { sanitizeConversationHistory } from '../utils/messageSanitizer'
import { resolveToolDescription, toolToJSONSchema } from '../utils/toolSchemas'
import { fetchWithStreamingRetry } from '../utils/providerHttp'
import { logger } from '../../utils/logger'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

export interface LLMStreamChunk {
  thinking?: string
  content?: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
  }>
  /**
   * Tool-use blocks that are fully received mid-stream (1:1 with Claude Code's
   * block-level streaming execution). Emitted on content_block_stop /
   * response.output_item.done — lets the query loop start executing tools
   * while the model is still generating. Final toolCalls on the return value
   * remains the source of truth; consumers dedupe by id.
   */
  completedToolCalls?: Array<{
    id: string
    name: string
    arguments: string
  }>
  finishReason?: string
  statusUpdate?: string
}

export interface ILLMProvider {
  chatStream(
    messages: LLMMessage[],
    tools: AgentTool[],
    onChunk: (chunk: LLMStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<{
    fullThinking: string
    fullContent: string
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  }>
}

export class OpenAICompatibleProvider implements ILLMProvider {
  constructor(private config: ProviderConfig) {}

  async chatStream(
    messages: LLMMessage[],
    tools: AgentTool[],
    onChunk: (chunk: LLMStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<{
    fullThinking: string
    fullContent: string
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  }> {
    const baseURL = (this.config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const url = baseURL.endsWith('/chat/completions') ? baseURL : `${baseURL}/chat/completions`


    const formattedTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: resolveToolDescription(tool),
        parameters: toolToJSONSchema(tool)
      }
    }))

    const sanitizedMessages = sanitizeConversationHistory(messages)

    const body: Record<string, any> = {
      model: this.config.model,
      messages: sanitizedMessages,
      stream: true,
      temperature: this.config.temperature ?? 0.2
    }

    if (formattedTools.length > 0) {
      body.tools = formattedTools
      body.tool_choice = 'auto'
    }

    logger.info('OpenAICompatibleProvider', `Initiating request to ${url}`, {
      model: this.config.model,
      messageCount: sanitizedMessages.length
    })

    const response = await fetchWithStreamingRetry({
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body)
      },
      provider: 'OpenAICompatibleProvider',
      model: this.config.model,
      onStatusUpdate: (message) => onChunk({ statusUpdate: message }),
      signal
    })

    if (!response.body) {
      throw new Error('LLM response body is empty.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    let fullThinking = ''
    let fullContent = ''
    const toolCallsMap = new Map<number, { id: string; name: string; argsStr: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') continue

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6))
            const choice = data.choices?.[0]
            const delta = choice?.delta

            if (!delta) continue

            // 1. Thinking content (e.g. DeepSeek R1 / Claude thinking / o3-mini reasoning)
            const thinkingDelta = delta.reasoning_content || delta.reasoning || delta.thinking || ''
            if (thinkingDelta) {
              fullThinking += thinkingDelta
              onChunk({ thinking: thinkingDelta })
            }

            // 2. Normal text content
            const contentDelta = delta.content || ''
            if (contentDelta) {
              fullContent += contentDelta
              onChunk({ content: contentDelta })
            }

            // 3. Tool Calls streaming
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0
                if (!toolCallsMap.has(index)) {
                  toolCallsMap.set(index, {
                    id: tc.id || `call_${Date.now()}_${index}`,
                    name: tc.function?.name || '',
                    argsStr: ''
                  })
                } else if (tc.function?.name && !toolCallsMap.get(index)!.name) {
                  toolCallsMap.get(index)!.name = tc.function.name
                }

                const current = toolCallsMap.get(index)!
                if (tc.id) current.id = tc.id
                if (tc.function?.arguments) current.argsStr += tc.function.arguments

                onChunk({
                  toolCalls: [
                    {
                      id: current.id,
                      name: current.name,
                      arguments: current.argsStr
                    }
                  ]
                })
              }
            }
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }

    const parsedToolCalls = Array.from(toolCallsMap.values()).map((tc) => {
      let argsObj = {}
      try {
        argsObj = JSON.parse(tc.argsStr || '{}')
      } catch {
        argsObj = { raw: tc.argsStr }
      }
      return {
        id: tc.id,
        name: tc.name,
        arguments: argsObj
      }
    })

    logger.info('OpenAICompatibleProvider', `Stream completed (thinking: ${fullThinking.length} chars, content: ${fullContent.length} chars, tools: ${parsedToolCalls.length})`)

    return {
      fullThinking,
      fullContent,
      toolCalls: parsedToolCalls
    }
  }
}

// Mock Provider for Unit & Integration Testing (evidence-driven)
export class MockLLMProvider implements ILLMProvider {
  private responses: Array<{
    thinking?: string
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  }> = []

  queueResponse(response: {
    thinking?: string
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  }) {
    this.responses.push(response)
  }

  async chatStream(
    _messages: LLMMessage[],
    _tools: AgentTool[],
    onChunk: (chunk: LLMStreamChunk) => void
  ) {
    const resp = this.responses.shift() || {
      thinking: 'Thinking about the request...',
      content: 'Default mock response.'
    }

    if (resp.thinking) {
      onChunk({ thinking: resp.thinking })
    }
    if (resp.content) {
      onChunk({ content: resp.content })
    }
    if (resp.toolCalls) {
      onChunk({
        toolCalls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        })),
        completedToolCalls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        }))
      })
    }

    return {
      fullThinking: resp.thinking || '',
      fullContent: resp.content || '',
      toolCalls: resp.toolCalls || []
    }
  }
}
