// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import {
  createDefaultProviders,
  getEnabledModelsGrouped,
  findActiveModelAndProvider
} from '../../src/shared/models'
import { createProvider } from '../../src/main/agent/providers/ProviderFactory'
import { AnthropicProvider } from '../../src/main/agent/providers/AnthropicProvider'
import { ResponsesProvider } from '../../src/main/agent/providers/ResponsesProvider'
import { OpenAICompatibleProvider } from '../../src/main/agent/providers/LLMProvider'
import { ModelSelector } from '../../src/renderer/src/components/ModelSelector'
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal'
import { ModelProvider } from '../../src/shared/types'

describe('Multi-Provider & Model Systems', () => {
  beforeEach(() => {
    ;(window as any).electronAPI = {
      getProviderConfig: vi.fn().mockResolvedValue({
        providers: [],
        activeModelId: 'deepseek-chat'
      }),
      saveProviderConfig: vi.fn().mockResolvedValue(true),
      switchModel: vi.fn().mockResolvedValue(true),
      testProviderConnectivity: vi.fn().mockResolvedValue({
        success: true,
        latencyMs: 142,
        statusCode: 200
      })
    }
  })

  it('createDefaultProviders preserves legacy DeepSeek baseURL and apiKey without loss', () => {
    const legacy = {
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test-123',
      model: 'deepseek-chat'
    }
    const providers = createDefaultProviders(legacy)
    const ds = providers.find((p) => p.id === 'deepseek')
    expect(ds).toBeDefined()
    expect(ds?.apiKey).toBe('sk-deepseek-test-123')
    expect(ds?.baseURL).toBe('https://api.deepseek.com')
    expect(ds?.apiFormat).toBe('chat_completions')
  })

  it('getEnabledModelsGrouped filters out disabled providers and disabled models', () => {
    const sample: ModelProvider[] = [
      {
        id: 'p1',
        name: 'Provider 1',
        enabled: true,
        baseURL: 'https://p1.com',
        apiKey: 'k1',
        apiFormat: 'chat_completions',
        models: [
          { id: 'm1', name: 'Model 1', enabled: true },
          { id: 'm2', name: 'Model 2', enabled: false }
        ]
      },
      {
        id: 'p2',
        name: 'Provider 2 (Disabled)',
        enabled: false,
        baseURL: 'https://p2.com',
        apiKey: 'k2',
        apiFormat: 'anthropic_messages',
        models: [{ id: 'm3', name: 'Model 3', enabled: true }]
      }
    ]

    const grouped = getEnabledModelsGrouped(sample)
    expect(grouped.length).toBe(1)
    expect(grouped[0].provider.id).toBe('p1')
    expect(grouped[0].models.map((m) => m.id)).toEqual(['m1'])
  })

  it('ProviderFactory routes the 3 API formats accurately', () => {
    // 1. Anthropic Messages (/v1/messages)
    const anthropicP = createProvider({
      apiFormat: 'anthropic_messages',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKey: 'sk-ant-test',
      model: 'GLM-5.3'
    } as any)
    expect(anthropicP).toBeInstanceOf(AnthropicProvider)

    // 2. Responses (/responses)
    const responsesP = createProvider({
      apiFormat: 'responses',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-resp-test',
      model: 'gpt-4o'
    } as any)
    expect(responsesP).toBeInstanceOf(ResponsesProvider)

    // 3. Chat Completions (/chat/completions)
    const chatP = createProvider({
      apiFormat: 'chat_completions',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-chat-test',
      model: 'deepseek-chat'
    } as any)
    expect(chatP).toBeInstanceOf(OpenAICompatibleProvider)
  })

  it('ModelSelector renders dynamically configured user providers and responds to selection', async () => {
    const mockProviders: ModelProvider[] = [
      {
        id: 'custom-zai',
        name: 'Z.ai Coding Plan 2',
        enabled: true,
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKey: 'sk-test',
        apiFormat: 'anthropic_messages',
        models: [
          { id: 'GLM-5.3', name: 'GLM-5.3', tags: ['1M', '思考'], enabled: true },
          { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', tags: ['1M', '视觉'], enabled: true }
        ]
      }
    ]

    const onModelChange = vi.fn()
    const onOpenSettings = vi.fn()

    const { getByText } = render(
      <ModelSelector
        currentModelId="GLM-5.3"
        onModelChange={onModelChange}
        providers={mockProviders}
        onOpenSettings={onOpenSettings}
      />
    )

    // Display name on trigger button
    expect(getByText('GLM-5.3')).toBeDefined()

    // Open dropdown
    fireEvent.click(getByText('GLM-5.3'))

    // Provider heading
    expect(getByText('Z.ai Coding Plan 2')).toBeDefined()
    expect(getByText('GLM-5.3-Flash')).toBeDefined()

    // Click another model
    fireEvent.click(getByText('GLM-5.3-Flash'))
    await vi.waitFor(() => {
      expect(window.electronAPI.switchModel).toHaveBeenCalledWith('GLM-5.3-Flash', 'custom-zai')
      expect(onModelChange).toHaveBeenCalledWith('GLM-5.3-Flash', 'custom-zai')
    })
  })

  it('ModelSelector disambiguates identical model IDs when currentProviderId is provided', () => {
    const multiProviders: ModelProvider[] = [
      {
        id: 'provider-a',
        name: 'Provider A',
        enabled: true,
        baseURL: 'https://a.com',
        apiKey: 'key-a',
        apiFormat: 'chat_completions',
        models: [{ id: 'gpt-4o', name: 'GPT-4o (A)', enabled: true }]
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        enabled: true,
        baseURL: 'https://b.com',
        apiKey: 'key-b',
        apiFormat: 'chat_completions',
        models: [{ id: 'gpt-4o', name: 'GPT-4o (B)', enabled: true }]
      }
    ]

    const onModelChange = vi.fn()
    const { getByText } = render(
      <ModelSelector
        currentModelId="gpt-4o"
        currentProviderId="provider-b"
        onModelChange={onModelChange}
        providers={multiProviders}
      />
    )

    // Should display Provider B's model name
    expect(getByText('GPT-4o (B)')).toBeDefined()
  })

  it('SettingsModal performs connectivity speed test and renders ms latency badge', async () => {
    const testConfig = {
      activeModelId: 'deepseek-chat',
      activeProviderId: 'deepseek',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          group: 'preset',
          enabled: true,
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          apiFormat: 'chat_completions' as const,
          models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', enabled: true }]
        }
      ]
    }

    ;(window as any).electronAPI.getProviderConfig = vi.fn().mockResolvedValue(testConfig)
    ;(window as any).electronAPI.testProviderConnectivity = vi.fn().mockResolvedValue({
      success: true,
      latencyMs: 142,
      statusCode: 200
    })

    const { findByText, findAllByText } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />
    )

    // Find "测试连接" button
    const pingBtn = await findByText('测试连接')
    expect(pingBtn).toBeDefined()

    // Trigger test
    fireEvent.click(pingBtn)

    // Verify electronAPI called with right params
    await vi.waitFor(() => {
      expect(window.electronAPI.testProviderConnectivity).toHaveBeenCalledWith({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        apiFormat: 'chat_completions',
        modelId: 'deepseek-chat'
      })
    })

    // Verify latency badge displayed
    const badges = await findAllByText(/142ms/)
    expect(badges.length).toBeGreaterThan(0)
  })

  it('SettingsModal supports fast template selection when adding provider', async () => {
    const testConfig = {
      activeModelId: 'deepseek-chat',
      activeProviderId: 'deepseek',
      providers: []
    }
    ;(window as any).electronAPI.getProviderConfig = vi.fn().mockResolvedValue(testConfig)
    ;(window as any).electronAPI.saveProviderConfig = vi.fn().mockResolvedValue(true)

    const { findByText, getByPlaceholderText } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />
    )

    // Open add provider modal
    const addBtn = await findByText('添加供应商')
    fireEvent.click(addBtn)

    // Click Moonshot (Kimi) template
    const kimiTmpl = await findByText('Moonshot')
    fireEvent.click(kimiTmpl)

    // Should auto-fill Base URL
    const urlInput = getByPlaceholderText('https://api.z.ai/api/anthropic') as HTMLInputElement
    expect(urlInput.value).toBe('https://api.moonshot.cn/v1')
  })

  it('SettingsModal supports model tag chips click-to-toggle', async () => {
    const testConfig = {
      activeModelId: 'deepseek-chat',
      activeProviderId: 'deepseek',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          group: 'preset',
          enabled: true,
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          apiFormat: 'chat_completions' as const,
          models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', enabled: true }]
        }
      ]
    }
    ;(window as any).electronAPI.getProviderConfig = vi.fn().mockResolvedValue(testConfig)

    const { findByText, getByPlaceholderText } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />
    )

    // Open add model modal
    const addModelBtn = await findByText('添加模型')
    fireEvent.click(addModelBtn)

    // Find tags input and chip
    const tagsInput = getByPlaceholderText('例如: 1M, 思考, 视觉') as HTMLInputElement
    expect(tagsInput.value).toBe('1M')

    // Click '思考' chip
    const thinkingChip = await findByText('思考')
    fireEvent.click(thinkingChip)
    expect(tagsInput.value).toContain('思考')

    // Click '思考' chip again to remove
    fireEvent.click(thinkingChip)
    expect(tagsInput.value).not.toContain('思考')
  })
})

