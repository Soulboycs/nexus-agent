import { ILLMProvider, LLMMessage, LLMStreamChunk } from './LLMProvider'
import { AgentTool } from '../tools/ToolRegistry'
import { ProviderConfig } from '@shared/types'
import { resolveToolDescription, toGeminiParameters, toolToJSONSchema } from '../utils/toolSchemas'
import { fetchWithStreamingRetry } from '../utils/providerHttp'

export class GeminiProvider implements ILLMProvider {
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
    const apiKey = this.config.geminiApiKey || this.config.apiKey || ''
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:streamGenerateContent?key=${apiKey}&alt=sse`

    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: resolveToolDescription(tool),
      parameters: toGeminiParameters(toolToJSONSchema(tool))
    }))

    const systemInstruction = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
    
    const contents = messages.filter(m => m.role !== 'system').map(m => {
      if (m.role === 'user') {
        return { role: 'user', parts: [{ text: m.content || '' }] }
      } else if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'model',
            parts: m.tool_calls.map(tc => ({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}')
              }
            }))
          }
        }
        return { role: 'model', parts: [{ text: m.content || '' }] }
      } else if (m.role === 'tool') {
        return {
          role: 'function',
          parts: [{
            functionResponse: {
              name: messages.find(msg => msg.tool_calls?.some(tc => tc.id === m.tool_call_id))?.tool_calls?.find(tc => tc.id === m.tool_call_id)?.function.name || 'tool',
              response: { result: m.content }
            }
          }]
        }
      }
      return { role: 'user', parts: [{ text: m.content || '' }] }
    })

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: this.config.temperature ?? 0.2
      }
    }

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }

    if (functionDeclarations.length > 0) {
      body.tools = [{ functionDeclarations }]
    }

    const response = await fetchWithStreamingRetry({
      url,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      provider: 'GeminiProvider',
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
      
      // Gemini streams as SSE or chunked JSON depending on exact endpoint?
      // Wait, streamGenerateContent sends chunks like `data: {...}` ?
      // Wait, no, Gemini uses server-sent events for streamGenerateContent with `alt=sse` or standard chunked json stream. 
      // The endpoint url does not have `alt=sse`, so it returns a JSON array streamed:
      // `[\n{\n "candidates": ...\n},\n{\n ...\n}\n]`
      // It's safer to use `alt=sse`. Let's append it to the URL.
      
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        let dataStr = line.trim()
        if (dataStr.startsWith('data: ')) {
          dataStr = dataStr.slice(6).trim()
        }
        if (!dataStr || dataStr === '[DONE]') continue
        // Some gemini streams start with [ and end with ] or use comma separation.
        if (dataStr.startsWith(',') || dataStr.startsWith('[')) dataStr = dataStr.replace(/^[,\[]\s*/, '')
        if (dataStr.endsWith(']')) dataStr = dataStr.slice(0, -1)

        try {
          const data = JSON.parse(dataStr)
          const parts = data.candidates?.[0]?.content?.parts || []
          
          for (const part of parts) {
            if (part.text) {
              fullContent += part.text
              onChunk({ content: part.text })
            } else if (part.functionCall) {
              // Gemini doesn't stream function args piece by piece typically, it sends it whole in one chunk
              const tcIndex = toolCallsMap.size
              const callId = `call_${Date.now()}_${tcIndex}`
              const argsStr = JSON.stringify(part.functionCall.args)
              toolCallsMap.set(tcIndex, {
                id: callId,
                name: part.functionCall.name,
                argsStr
              })
              onChunk({
                completedToolCalls: [
                  {
                    id: callId,
                    name: part.functionCall.name,
                    arguments: argsStr
                  }
                ]
              })
            }
          }
        } catch {
          // ignore parse errors for partial chunks
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
