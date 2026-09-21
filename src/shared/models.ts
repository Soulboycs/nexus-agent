export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'ollama' | 'openai-compatible'
export type SpeedTier = 'fast' | 'medium' | 'slow'
export type IntelligenceTier = 'low' | 'medium' | 'high'

export interface ModelDef {
  id: string           // model id 传给 API
  name: string         // 显示名称
  provider: ProviderType
  speed: SpeedTier
  intelligence: IntelligenceTier
  thinking?: boolean   // 是否有 thinking/reasoning
  description?: string
}

export const MODEL_CATALOG: ModelDef[] = [
  // DeepSeek
  { id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek', speed: 'fast', intelligence: 'high' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek', speed: 'medium', intelligence: 'high', thinking: true },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', speed: 'fast', intelligence: 'high' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', speed: 'fast', intelligence: 'medium' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', speed: 'fast', intelligence: 'high' },
  // Anthropic
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', speed: 'fast', intelligence: 'high', thinking: true },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic', speed: 'slow', intelligence: 'high', thinking: true },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', provider: 'anthropic', speed: 'fast', intelligence: 'medium' },
  // Gemini
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash Medium', provider: 'gemini', speed: 'fast', intelligence: 'medium' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', speed: 'fast', intelligence: 'medium' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', speed: 'medium', intelligence: 'high' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', speed: 'medium', intelligence: 'high', thinking: true },
  // Ollama (local)
  { id: 'llama3.2', name: 'Llama 3.2 (Local)', provider: 'ollama', speed: 'fast', intelligence: 'medium' },
  { id: 'qwen2.5-coder', name: 'Qwen2.5 Coder (Local)', provider: 'ollama', speed: 'fast', intelligence: 'medium' },
]

export function getModelDef(modelId: string): ModelDef | undefined {
  return MODEL_CATALOG.find(m => m.id === modelId)
}

import { ModelProvider, ProviderConfig, ModelItem } from './types'

export const API_FORMAT_OPTIONS = [
  { value: 'anthropic_messages' as const, label: 'Anthropic Messages (/v1/messages)' },
  { value: 'chat_completions' as const, label: 'Chat Completions (/chat/completions)' },
  { value: 'responses' as const, label: 'Responses (/responses)' }
]

export const COMMON_MODEL_TAGS = ['1M', '思考', 'Fast', 'Coding', '视觉', 'Local', 'High', 'Medium']

export interface ProviderTemplate {
  key: string
  name: string
  baseURL: string
  apiFormat: 'anthropic_messages' | 'chat_completions' | 'responses'
  placeholderKey?: string
  models: Array<{ id: string; name: string; tags: string[]; enabled: boolean }>
}

export const PRESET_PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    key: 'z-ai',
    name: '智谱 AI (Z.ai / BigModel)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'chat_completions',
    placeholderKey: 'api_key_here',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', tags: ['128K', 'High'], enabled: true },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', tags: ['128K', 'Fast'], enabled: true },
      { id: 'glm-4-air', name: 'GLM-4 Air', tags: ['128K'], enabled: true }
    ]
  },
  {
    key: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    baseURL: 'https://api.siliconflow.cn/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3 (SiliconFlow)', tags: ['Fast', 'High'], enabled: true },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (SiliconFlow)', tags: ['Thinking', 'High'], enabled: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', tags: ['Coding', 'High'], enabled: true }
    ]
  },
  {
    key: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.cn/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'kimi-latest', name: 'Kimi Latest', tags: ['1M', 'High'], enabled: true },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k', tags: ['8K', 'Fast'], enabled: true }
    ]
  },
  {
    key: 'qwen-dashscope',
    name: '阿里云百炼 (Qwen DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', tags: ['128K', 'Fast'], enabled: true },
      { id: 'qwen-max', name: 'Qwen Max', tags: ['High', 'Coding'], enabled: true },
      { id: 'qwen-turbo', name: 'Qwen Turbo', tags: ['Fast'], enabled: true }
    ]
  },
  {
    key: 'deepseek-official',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', tags: ['1M', 'Fast'], enabled: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', tags: ['Thinking', 'High'], enabled: true }
    ]
  },
  {
    key: 'openai-official',
    name: 'OpenAI 官方',
    baseURL: 'https://api.openai.com/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tags: ['High', 'Fast'], enabled: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tags: ['Medium', 'Fast'], enabled: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', tags: ['High', 'Fast'], enabled: true }
    ]
  },
  {
    key: 'anthropic-official',
    name: 'Anthropic 官方',
    baseURL: 'https://api.anthropic.com',
    apiFormat: 'anthropic_messages',
    placeholderKey: 'sk-ant-...',
    models: [
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude Sonnet 3.7', tags: ['Thinking', 'Fast'], enabled: true },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 3.5', tags: ['High', 'Fast'], enabled: true },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', tags: ['Medium', 'Fast'], enabled: true }
    ]
  },
  {
    key: 'groq',
    name: 'Groq (Ultra-Fast)',
    baseURL: 'https://api.groq.com/openai/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'gsk_...',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tags: ['Fast', 'High'], enabled: true },
      { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill 70B', tags: ['Thinking', 'Fast'], enabled: true }
    ]
  },
  {
    key: 'custom',
    name: '自定义中转代理 (OneAPI/NewAPI)',
    baseURL: 'https://api.openai.com/v1',
    apiFormat: 'chat_completions',
    placeholderKey: 'sk-...',
    models: [
      { id: 'default-model', name: 'Default Model', tags: ['1M'], enabled: true }
    ]
  }
]

export function createDefaultProviders(legacyConfig?: Partial<ProviderConfig>): ModelProvider[] {
  const isDeepSeek = legacyConfig?.baseURL?.includes('deepseek') || legacyConfig?.providerType === 'deepseek'

  const deepseekKey = isDeepSeek ? (legacyConfig?.apiKey || '') : ''
  const openaiKey = !isDeepSeek ? (legacyConfig?.apiKey || '') : ''
  const anthropicKey = legacyConfig?.anthropicApiKey || ''
  const ollamaBaseURL = legacyConfig?.ollamaBaseURL || 'http://localhost:11434/v1'

  return [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      group: 'preset',
      enabled: true,
      baseURL: isDeepSeek && legacyConfig?.baseURL ? legacyConfig.baseURL : 'https://api.deepseek.com',
      apiKey: deepseekKey,
      apiFormat: 'chat_completions',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek V3', tags: ['1M', 'Fast'], enabled: true },
        { id: 'deepseek-reasoner', name: 'DeepSeek R1', tags: ['Thinking', 'High'], enabled: true }
      ]
    },
    {
      id: 'openai',
      name: 'OpenAI',
      group: 'preset',
      enabled: true,
      baseURL: !isDeepSeek && legacyConfig?.baseURL ? legacyConfig.baseURL : 'https://api.openai.com/v1',
      apiKey: openaiKey,
      apiFormat: 'chat_completions',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', tags: ['High', 'Fast'], enabled: true },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tags: ['Medium', 'Fast'], enabled: true },
        { id: 'gpt-4.1', name: 'GPT-4.1', tags: ['High', 'Fast'], enabled: true }
      ]
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      group: 'preset',
      enabled: true,
      baseURL: 'https://api.anthropic.com',
      apiKey: anthropicKey,
      apiFormat: 'anthropic_messages',
      models: [
        { id: 'claude-3-7-sonnet-20250219', name: 'Claude Sonnet 3.7', tags: ['Thinking', 'Fast'], enabled: true },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 3.5', tags: ['High', 'Fast'], enabled: true },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', tags: ['Medium', 'Fast'], enabled: true }
      ]
    },
    {
      id: 'ollama',
      name: 'Ollama (Local)',
      group: 'preset',
      enabled: true,
      baseURL: ollamaBaseURL,
      apiKey: 'ollama',
      apiFormat: 'chat_completions',
      models: [
        { id: 'llama3.2', name: 'Llama 3.2', tags: ['Local', 'Fast'], enabled: true },
        { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', tags: ['Local', 'Coding'], enabled: true }
      ]
    }
  ]
}

export function getEnabledModelsGrouped(providers?: ModelProvider[]): { provider: ModelProvider; models: ModelItem[] }[] {
  if (!providers || !Array.isArray(providers)) return []
  return providers
    .filter(p => p.enabled)
    .map(p => ({
      provider: p,
      models: (p.models || []).filter(m => m.enabled)
    }))
    .filter(group => group.models.length > 0)
}

export function findActiveModelAndProvider(
  providers?: ModelProvider[],
  modelId?: string,
  providerId?: string
): { provider: ModelProvider; model: ModelItem } | undefined {
  if (!providers || !Array.isArray(providers)) return undefined

  if (providerId) {
    const targetProvider = providers.find(p => p.id === providerId && p.enabled)
    if (targetProvider) {
      if (modelId) {
        const targetModel = targetProvider.models.find(m => m.id === modelId && m.enabled)
        if (targetModel) return { provider: targetProvider, model: targetModel }
      }
      const firstEnabled = targetProvider.models.find(m => m.enabled)
      if (firstEnabled) return { provider: targetProvider, model: firstEnabled }
    }
  }

  if (modelId) {
    for (const p of providers) {
      if (!p.enabled) continue
      const m = p.models.find(item => item.id === modelId && item.enabled)
      if (m) return { provider: p, model: m }
    }
  }

  // Fallback to first available enabled model
  for (const p of providers) {
    if (!p.enabled) continue
    const m = p.models.find(item => item.enabled)
    if (m) return { provider: p, model: m }
  }

  return undefined
}

