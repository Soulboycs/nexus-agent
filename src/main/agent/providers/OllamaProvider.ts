import { OpenAICompatibleProvider, LLMMessage, LLMStreamChunk } from './LLMProvider'
import { AgentTool } from '../tools/ToolRegistry'
import { ProviderConfig } from '@shared/types'

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseURL: config.baseURL || config.ollamaBaseURL || 'http://localhost:11434/v1',
      apiKey: config.apiKey || 'ollama'
    })
  }
}
