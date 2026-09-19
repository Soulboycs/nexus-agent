import { ILLMProvider, OpenAICompatibleProvider } from './LLMProvider'
import { AnthropicProvider } from './AnthropicProvider'
import { GeminiProvider } from './GeminiProvider'
import { OllamaProvider } from './OllamaProvider'
import { ResponsesProvider } from './ResponsesProvider'
import { ProviderConfig, ApiFormat } from '@shared/types'
import { findActiveModelAndProvider } from '../../../../src/shared/models'

export function createProvider(config: ProviderConfig): ILLMProvider {
  let activeFormat: ApiFormat | undefined = (config as any).apiFormat
  let effectiveConfig = { ...config }

  // 1. If multi-provider configuration is present, resolve active provider
  if (config.providers && config.providers.length > 0) {
    const resolved = findActiveModelAndProvider(
      config.providers,
      config.activeModelId || config.model,
      config.activeProviderId
    )
    if (resolved) {
      const { provider, model } = resolved
      activeFormat = provider.apiFormat
      effectiveConfig = {
        ...config,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        model: model.id,
        activeModelId: model.id,
        activeProviderId: provider.id,
        providerType: provider.id as any
      }
    }
  }

  // 2. Dispatch based on explicit apiFormat
  if (activeFormat === 'anthropic_messages') {
    return new AnthropicProvider(effectiveConfig)
  }
  if (activeFormat === 'responses') {
    return new ResponsesProvider(effectiveConfig)
  }
  if (activeFormat === 'chat_completions') {
    if (effectiveConfig.activeProviderId === 'ollama' || (!effectiveConfig.activeProviderId && effectiveConfig.providerType === 'ollama')) {
      return new OllamaProvider({
        ...effectiveConfig,
        baseURL: effectiveConfig.baseURL || 'http://localhost:11434/v1',
        apiKey: effectiveConfig.apiKey || 'ollama'
      })
    }
    return new OpenAICompatibleProvider(effectiveConfig)
  }

  // 3. Fallback to legacy providerType
  switch (effectiveConfig.providerType) {
    case 'anthropic':
      return new AnthropicProvider(effectiveConfig)
    case 'gemini':
      return new GeminiProvider(effectiveConfig)
    case 'ollama':
      return new OllamaProvider(effectiveConfig)
    case 'deepseek':
      return new OpenAICompatibleProvider({
        ...effectiveConfig,
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: effectiveConfig.apiKey
      })
    case 'openai':
    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider(effectiveConfig)
  }
}

