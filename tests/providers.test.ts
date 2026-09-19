import { describe, it, expect } from 'bun:test'
import { createProvider } from '../src/main/agent/providers/ProviderFactory'
import { OpenAICompatibleProvider } from '../src/main/agent/providers/LLMProvider'
import { AnthropicProvider } from '../src/main/agent/providers/AnthropicProvider'
import { GeminiProvider } from '../src/main/agent/providers/GeminiProvider'
import { OllamaProvider } from '../src/main/agent/providers/OllamaProvider'
import { MODEL_CATALOG, getModelDef } from '../src/shared/models'

/**
 * 2026-09-18 垃圾测试清理重写：
 * 原版本仅断言 isDefined + typeof chatStream —— 工厂把 anthropic 错配成
 * gemini、deepseek 丢失 baseURL 重映射等真实故障全部无法发现（近永真）。
 * 现改为 instanceof 分发断言 + 协议级 baseURL/apiKey 重映射验证。
 */
describe('ProviderFactory — 分发正确性与协议重映射', () => {
  it('routes anthropic/gemini/ollama to their dedicated adapters (misrouting fails)', () => {
    expect(
      createProvider({ providerType: 'anthropic', model: 'claude-sonnet-4-5', anthropicApiKey: 't' } as any)
    ).toBeInstanceOf(AnthropicProvider)
    expect(
      createProvider({ providerType: 'gemini', model: 'gemini-2.0-flash', geminiApiKey: 't' } as any)
    ).toBeInstanceOf(GeminiProvider)
    expect(
      createProvider({ providerType: 'ollama', model: 'llama3.2' } as any)
    ).toBeInstanceOf(OllamaProvider)
  })

  it('forces DeepSeek onto the official endpoint regardless of caller-provided baseURL', () => {
    const p = createProvider({
      providerType: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      baseURL: 'http://attacker.example/v1' // 恶意/错误 baseURL 必须被强制覆盖
    } as any) as any
    expect(p).toBeInstanceOf(OpenAICompatibleProvider)
    expect(p.config.baseURL).toBe('https://api.deepseek.com/v1')
    expect(p.config.apiKey).toBe('sk-test')
  })

  it('applies Ollama local defaults (baseURL + apiKey fallback)', () => {
    const p = createProvider({ providerType: 'ollama', model: 'llama3.2' } as any) as any
    expect(p).toBeInstanceOf(OllamaProvider)
    expect(p.config.baseURL).toBe('http://localhost:11434/v1')
    expect(p.config.apiKey).toBe('ollama')
  })

  it('passes openai / openai-compatible / unknown types through to OpenAICompatible untouched', () => {
    const custom = createProvider({
      providerType: 'openai-compatible',
      model: 'custom-model',
      apiKey: 'k',
      baseURL: 'http://localhost:8080/v1'
    } as any) as any
    expect(custom).toBeInstanceOf(OpenAICompatibleProvider)
    expect(custom.config.baseURL).toBe('http://localhost:8080/v1')

    expect(
      createProvider({ providerType: 'openai', model: 'gpt-4o', apiKey: 'k' } as any)
    ).toBeInstanceOf(OpenAICompatibleProvider)
    expect(
      createProvider({ providerType: 'totally-unknown' } as any)
    ).toBeInstanceOf(OpenAICompatibleProvider)
  })
})

describe('ModelCatalog — unit', () => {
  it('finds deepseek-chat model', () => {
    const m = getModelDef('deepseek-chat')
    expect(m).toBeDefined()
    expect(m?.provider).toBe('deepseek')
    expect(m?.speed).toBeDefined()
    expect(m?.intelligence).toBeDefined()
  })

  it('finds claude model with thinking flag', () => {
    const m = getModelDef('claude-sonnet-4-5')
    expect(m).toBeDefined()
    expect(m?.thinking).toBe(true)
  })

  it('every model has required fields with valid enum values', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.id).toBeTruthy()
      expect(m.name).toBeTruthy()
      expect(m.provider).toBeTruthy()
      expect(['fast', 'medium', 'slow']).toContain(m.speed)
      expect(['low', 'medium', 'high']).toContain(m.intelligence)
    }
  })

  it('each provider type is covered in catalog', () => {
    const providers = new Set(MODEL_CATALOG.map(m => m.provider))
    expect(providers.has('openai')).toBe(true)
    expect(providers.has('anthropic')).toBe(true)
    expect(providers.has('gemini')).toBe(true)
    expect(providers.has('deepseek')).toBe(true)
    expect(providers.has('ollama')).toBe(true)
  })
})
