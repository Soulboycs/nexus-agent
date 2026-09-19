import { ILLMProvider, LLMMessage, LLMStreamChunk } from './LLMProvider'
import { AgentTool } from '../tools/ToolRegistry'
import { ProviderConfig } from '@shared/types'
import { resolveToolDescription, toolToJSONSchema } from '../utils/toolSchemas'
import { fetchWithStreamingRetry } from '../utils/providerHttp'

const EPHEMERAL = { type: 'ephemeral' } as const

export class AnthropicProvider implements ILLMProvider {
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
    const baseURL = (this.config.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '')
    const url = baseURL.endsWith('/v1/messages')
      ? baseURL
      : (baseURL.endsWith('/messages') ? baseURL : `${baseURL}/v1/messages`)

    // Prompt caching (1:1 with cc-haha cache policy): built-in tools form a
    // contiguous stable prefix (registry stable-sort), so the tool breakpoint
    // sits on the LAST built-in tool — MCP tools after it must NOT carry the
    // marker, or the breakpoint would include volatile tool sets.
    const formattedTools = tools.map((tool) => ({
      name: tool.name,
      description: resolveToolDescription(tool),
      input_schema: toolToJSONSchema(tool)
    }))
    const builtInCount = tools.filter((t) => !t.isMcp).length
    if (formattedTools.length > 0) {
      const markerIndex = builtInCount > 0 ? builtInCount - 1 : formattedTools.length - 1
      ;(formattedTools[markerIndex] as any).cache_control = EPHEMERAL
    }

    // Anthropic expects system messages to be passed separately.
    const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const userAndAssistantMessages = messages.filter(m => m.role !== 'system').map(m => {
      if (m.role === 'user') {
        return { role: 'user', content: m.content || '' }
      } else if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'assistant',
            content: m.tool_calls.map(tc => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}')
            }))
          }
        }
        return { role: 'assistant', content: m.content || '' }
      } else if (m.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content
            }
          ]
        }
      }
      return { role: 'user', content: m.content || '' }
    })

    const model = this.config.model || 'claude-3-5-sonnet-20241022'
    const body: Record<string, any> = {
      model,
      messages: userAndAssistantMessages,
      max_tokens: 8192,
      stream: true,
      temperature: this.config.temperature ?? 0.2
    }

    if (systemText) {
      // Cached system block (cache prefix order: tools → system → messages).
      body.system = [{ type: 'text', text: systemText, cache_control: EPHEMERAL }]
    }

    if (formattedTools.length > 0) {
      body.tools = formattedTools
    }

    // Exactly ONE message-level marker, on the last content block of the last
    // message (1:1 with cc-haha addCacheBreakpoints markerIndex = length - 1).
    // Turns grow append-only in our loop, so this caches the shared prefix and
    // re-writes only the newest turn.
    const lastMessage = body.messages[body.messages.length - 1]
    if (lastMessage) {
      if (typeof lastMessage.content === 'string') {
        lastMessage.content = [
          { type: 'text', text: lastMessage.content, cache_control: EPHEMERAL }
        ]
      } else if (Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
        ;(lastMessage.content[lastMessage.content.length - 1] as any).cache_control = EPHEMERAL
      }
    }

    const apiKey = this.config.apiKey || this.config.anthropicApiKey || ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetchWithStreamingRetry({
      url,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      },
      provider: 'AnthropicProvider',
      model,
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
    let currentToolCallIndex = -1

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const dataStr = line.slice(6).trim()
        if (dataStr === '[DONE]') continue
        if (!dataStr) continue

        try {
          const data = JSON.parse(dataStr)

          if (data.type === 'content_block_start') {
            if (data.content_block.type === 'tool_use') {
              currentToolCallIndex = data.index
              toolCallsMap.set(currentToolCallIndex, {
                id: data.content_block.id,
                name: data.content_block.name,
                argsStr: ''
              })
            }
          } else if (data.type === 'content_block_stop') {
            // Block fully received: surface it for in-stream tool execution
            const stopIndex = typeof data.index === 'number' ? data.index : currentToolCallIndex
            const done = toolCallsMap.get(stopIndex)
            if (done) {
              onChunk({
                completedToolCalls: [
                  {
                    id: done.id,
                    name: done.name,
                    arguments: done.argsStr
                  }
                ]
              })
            }
          } else if (data.type === 'content_block_delta') {
            if (data.delta.type === 'text_delta') {
              const text = data.delta.text
              fullContent += text
              onChunk({ content: text })
            } else if (data.delta.type === 'thinking_delta') {
              const thinking = data.delta.thinking
              fullThinking += thinking
              onChunk({ thinking })
            } else if (data.delta.type === 'input_json_delta') {
              if (currentToolCallIndex !== -1 && toolCallsMap.has(currentToolCallIndex)) {
                const current = toolCallsMap.get(currentToolCallIndex)!
                current.argsStr += data.delta.partial_json
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
          }
        } catch {
          // ignore parse errors
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

    return {
      fullThinking,
      fullContent,
      toolCalls: parsedToolCalls
    }
  }
}
