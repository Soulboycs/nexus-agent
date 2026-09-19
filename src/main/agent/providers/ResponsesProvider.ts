import { AgentTool } from '../tools/ToolRegistry'
import { ProviderConfig } from '@shared/types'
import { sanitizeConversationHistory } from '../utils/messageSanitizer'
import { resolveToolDescription, toolToJSONSchema } from '../utils/toolSchemas'
import { fetchWithStreamingRetry } from '../utils/providerHttp'
import { logger } from '../../utils/logger'
import { ILLMProvider, LLMMessage, LLMStreamChunk } from './LLMProvider'

export class ResponsesProvider implements ILLMProvider {
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
    const url = baseURL.endsWith('/responses') ? baseURL : `${baseURL}/responses`

    const formattedTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: resolveToolDescription(tool),
        parameters: toolToJSONSchema(tool)
      }
    }))

    const sanitized = sanitizeConversationHistory(messages)

    const body: Record<string, any> = {
      model: this.config.model,
      input: sanitized.map((m) => ({
        role: m.role,
        content: m.content || ''
      })),
      stream: true,
      temperature: this.config.temperature ?? 0.2
    }

    if (formattedTools.length > 0) {
      body.tools = formattedTools
    }

    logger.info('ResponsesProvider', `Initiating request to ${url}`, {
      model: this.config.model,
      messageCount: sanitized.length
    })

    const response = await fetchWithStreamingRetry({
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey || ''}`
        },
        body: JSON.stringify(body)
      },
      provider: 'ResponsesProvider',
      model: this.config.model,
      onStatusUpdate: (message) => onChunk({ statusUpdate: message }),
      signal
    })

    if (!response.body) {
      throw new Error('Responses API response body is empty.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    let fullThinking = ''
    let fullContent = ''
    const toolCallsMap = new Map<string, { id: string; name: string; argsStr: string }>()
    let currentCallId = ''

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

            if (data.type === 'response.output_text.delta' || data.type === 'response.text.delta') {
              const deltaText = data.delta || data.text || ''
              if (deltaText) {
                fullContent += deltaText
                onChunk({ content: deltaText })
              }
            } else if (data.type === 'response.reasoning_text.delta') {
              const reasoning = data.delta || ''
              if (reasoning) {
                fullThinking += reasoning
                onChunk({ thinking: reasoning })
              }
            } else if (data.type === 'response.output_item.added') {
              if (data.item?.type === 'function_call') {
                currentCallId = data.item.call_id || data.item.id || `call_${Date.now()}`
                toolCallsMap.set(currentCallId, {
                  id: currentCallId,
                  name: data.item.name || '',
                  argsStr: ''
                })
              }
            } else if (data.type === 'response.function_call_arguments.delta') {
              const callId = data.call_id || currentCallId
              if (callId && toolCallsMap.has(callId)) {
                const item = toolCallsMap.get(callId)!
                item.argsStr += data.delta || ''
                onChunk({
                  toolCalls: [
                    {
                      id: item.id,
                      name: item.name,
                      arguments: item.argsStr
                    }
                  ]
                })
              }
            } else if (data.type === 'response.output_item.done') {
              // Item fully received: surface function_call for in-stream execution
              if (data.item?.type === 'function_call') {
                const callId = data.item.call_id || data.item.id || `call_${Date.now()}`
                const existing = toolCallsMap.get(callId)
                const argsStr =
                  existing?.argsStr ||
                  (typeof data.item.arguments === 'string'
                    ? data.item.arguments
                    : JSON.stringify(data.item.arguments ?? {}))
                if (existing) {
                  existing.argsStr = argsStr
                  if (data.item.name) existing.name = data.item.name
                } else {
                  toolCallsMap.set(callId, {
                    id: callId,
                    name: data.item.name || '',
                    argsStr
                  })
                }
                onChunk({
                  completedToolCalls: [
                    {
                      id: callId,
                      name: data.item.name || existing?.name || '',
                      arguments: argsStr
                    }
                  ]
                })
              }
            } else if (data.delta) {
              const deltaText = typeof data.delta === 'string' ? data.delta : data.delta.content || ''
              const reasoning = data.delta.reasoning_content || data.delta.reasoning || data.delta.thinking || ''
              if (reasoning) {
                fullThinking += reasoning
                onChunk({ thinking: reasoning })
              }
              if (deltaText) {
                fullContent += deltaText
                onChunk({ content: deltaText })
              }
            } else if (data.choices?.[0]?.delta) {
              const choice = data.choices[0]
              const delta = choice.delta
              const thinkingDelta = delta.reasoning_content || delta.reasoning || delta.thinking || ''
              if (thinkingDelta) {
                fullThinking += thinkingDelta
                onChunk({ thinking: thinkingDelta })
              }
              if (delta.content) {
                fullContent += delta.content
                onChunk({ content: delta.content })
              }
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const id = tc.id || currentCallId || `call_${Date.now()}`
                  if (!toolCallsMap.has(id)) {
                    toolCallsMap.set(id, {
                      id,
                      name: tc.function?.name || '',
                      argsStr: ''
                    })
                  }
                  const item = toolCallsMap.get(id)!
                  if (tc.function?.name) item.name = tc.function.name
                  if (tc.function?.arguments) item.argsStr += tc.function.arguments
                  onChunk({
                    toolCalls: [
                      {
                        id: item.id,
                        name: item.name,
                        arguments: item.argsStr
                      }
                    ]
                  })
                }
              }
            }
          } catch {
            // Ignore JSON parse errors on partial chunks
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

    return {
      fullThinking,
      fullContent,
      toolCalls: parsedToolCalls
    }
  }
}
