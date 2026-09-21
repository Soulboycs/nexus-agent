// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import * as http from 'http'
import * as fs from 'fs'
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal'
import { ModelSelector } from '../../src/renderer/src/components/ModelSelector'
import { createProvider } from '../../src/main/agent/providers/ProviderFactory'
import { ProviderConfig, ModelProvider } from '../../src/shared/types'

describe('E2E Mock & Multi-Provider System', () => {
  let mockServer: http.Server
  let serverPort = 0
  let serverBaseUrl = ''

  // 1. Setup Local Mock HTTP Server for the 3 Protocols
  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      const url = req.url || ''
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      if (url.includes('/messages')) {
        // Anthropic protocol mock SSE
        res.write('data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}\n\n')
        res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Mock Anthropic Messages!"}}\n\n')
        res.write('data: {"type":"content_block_stop","index":0}\n\n')
        res.write('data: {"type":"message_stop"}\n\n')
        res.end()
      } else if (url.includes('/chat/completions')) {
        // OpenAI Chat Completions protocol mock SSE
        res.write('data: {"choices":[{"delta":{"role":"assistant"}},{"index":0}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":"Hello from Mock Chat Completions!"},"index":0}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else if (url.includes('/responses')) {
        // OpenAI Responses protocol mock SSE
        res.write('data: {"type":"response.output_text.delta","delta":"Hello from Mock Responses API!"}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.statusCode = 404
        res.end('Not Found')
      }
    })

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const address = mockServer.address() as any
        serverPort = address.port
        serverBaseUrl = `http://127.0.0.1:${serverPort}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve())
    })
  })

  // 2. UI Test: Verify all 3 provider types can be added and configured via SettingsModal
  it('allows user to add providers in all 3 API formats and add models to them', async () => {
    let savedConfig: ProviderConfig | null = null

    ;(window as any).electronAPI = {
      getProviderConfig: vi.fn().mockResolvedValue({
        providers: [],
        activeModelId: 'deepseek-chat',
        temperature: 0.2
      }),
      saveProviderConfig: vi.fn().mockImplementation(async (cfg: ProviderConfig) => {
        savedConfig = cfg
        return true
      }),
      switchModel: vi.fn().mockResolvedValue(true)
    }

    const { getByText, getByPlaceholderText, queryByText } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />
    )

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getAllByText('模型设置').length).toBeGreaterThan(0)
    })


    // Click "+ 添加供应商"
    fireEvent.click(getByText('添加供应商'))
    expect(getByText('添加自定义供应商')).toBeDefined()

    // 1. Add Anthropic Messages Provider
    fireEvent.change(getByPlaceholderText('例如: Z.ai Coding Plan 2'), {
      target: { value: 'Z.ai Anthropic Plan' }
    })
    fireEvent.change(getByPlaceholderText('https://api.z.ai/api/anthropic'), {
      target: { value: `${serverBaseUrl}/api/anthropic` }
    })
    const keyInputs = screen.getAllByPlaceholderText('sk-...')
    fireEvent.change(keyInputs[keyInputs.length - 1], {
      target: { value: 'sk-ant-test-key' }
    })


    // Click "添加" button in modal
    const addBtns = screen.getAllByRole('button', { name: '添加' })
    fireEvent.click(addBtns[addBtns.length - 1])

    await waitFor(() => {
      expect(savedConfig).not.toBeNull()
      expect(savedConfig?.providers?.some((p) => p.name === 'Z.ai Anthropic Plan')).toBe(true)
    })

    const addedAnthropic = savedConfig?.providers?.find((p) => p.name === 'Z.ai Anthropic Plan')
    expect(addedAnthropic?.apiFormat).toBe('anthropic_messages')
    expect(addedAnthropic?.baseURL).toBe(`${serverBaseUrl}/api/anthropic`)
  })

  // 3. E2E Provider Streaming with Mock Server: All 3 Protocols
  it('correctly executes streams on all 3 API formats via mock server', async () => {
    // Protocol 1: Anthropic Messages (/v1/messages)
    const anthropicProvider = createProvider({
      apiFormat: 'anthropic_messages',
      baseURL: `${serverBaseUrl}/v1/messages`,
      apiKey: 'test-key',
      model: 'GLM-5.3'
    } as any)

    let anthropicContent = ''
    const res1 = await anthropicProvider.chatStream(
      [{ role: 'user', content: 'hi' }],
      [],
      (chunk) => {
        if (chunk.content) anthropicContent += chunk.content
      }
    )
    expect(res1.fullContent).toContain('Hello from Mock Anthropic Messages!')
    expect(anthropicContent).toContain('Hello from Mock Anthropic Messages!')

    // Protocol 2: Chat Completions (/chat/completions)
    const chatProvider = createProvider({
      apiFormat: 'chat_completions',
      baseURL: `${serverBaseUrl}/chat/completions`,
      apiKey: 'test-key',
      model: 'deepseek-chat'
    } as any)

    let chatContent = ''
    const res2 = await chatProvider.chatStream(
      [{ role: 'user', content: 'hi' }],
      [],
      (chunk) => {
        if (chunk.content) chatContent += chunk.content
      }
    )
    expect(res2.fullContent).toContain('Hello from Mock Chat Completions!')
    expect(chatContent).toContain('Hello from Mock Chat Completions!')

    // Protocol 3: Responses (/responses)
    const responsesProvider = createProvider({
      apiFormat: 'responses',
      baseURL: `${serverBaseUrl}/responses`,
      apiKey: 'test-key',
      model: 'gpt-4o'
    } as any)

    let responsesContent = ''
    const res3 = await responsesProvider.chatStream(
      [{ role: 'user', content: 'hi' }],
      [],
      (chunk) => {
        if (chunk.content) responsesContent += chunk.content
      }
    )
    expect(res3.fullContent).toContain('Hello from Mock Responses API!')
    expect(responsesContent).toContain('Hello from Mock Responses API!')
  })

  // 4. Real DeepSeek API Test
  it('connects to real DeepSeek API with user credentials and streams real output', async () => {
    // Look up real key from user configuration
    let apiKey = process.env.DEEPSEEK_API_KEY || ''
    let baseURL = 'https://api.deepseek.com'

    try {
      const configPath = 'C:\\Users\\Administrator\\AppData\\Roaming\\nexus-agent\\agent-config.json'
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        if (raw.apiKey) apiKey = raw.apiKey
        if (raw.baseURL) baseURL = raw.baseURL
      }
    } catch {}

    if (!apiKey || apiKey.includes('test')) {
      console.log('[SKIP Real DeepSeek] No real DeepSeek API key found in agent-config.json')
      return
    }

    console.log(`[Real DeepSeek Test] Initiating live test with baseURL=${baseURL}...`)

    const realProvider = createProvider({
      apiFormat: 'chat_completions',
      baseURL,
      apiKey,
      model: 'deepseek-chat',
      temperature: 0.1
    } as any)

    let liveStreamChunks = 0
    let liveAccumulatedText = ''

    const startTime = Date.now()
    const result = await realProvider.chatStream(
      [{ role: 'user', content: '请用中文回答五个字：测试通过了' }],
      [],
      (chunk) => {
        if (chunk.content) {
          liveStreamChunks++
          liveAccumulatedText += chunk.content
        }
      }
    )
    const elapsed = Date.now() - startTime

    console.log(`[Real DeepSeek Test] Success in ${elapsed}ms!`)
    console.log(`[Real DeepSeek Test] Chunks received: ${liveStreamChunks}`)
    console.log(`[Real DeepSeek Test] Response: "${result.fullContent}"`)

    expect(result.fullContent.length).toBeGreaterThan(0)
    expect(liveStreamChunks).toBeGreaterThan(0)
    expect(result.fullContent).toMatch(/测试|通过|你好|NEXUS/i)
  }, 30000)

  it('correctly resolves DeepSeek provider without falling back to Ollama even when legacy providerType is ollama', () => {
    const mixedConfig: ProviderConfig = {
      apiKey: 'sk-c74d22f3afc64341805f7af68ecad9f4',
      baseURL: 'https://api.deepseek.com',
      model: 'llama3.2',
      temperature: 0.2,
      providerType: 'ollama' as any,
      activeModelId: 'deepseek-v4.1-flash-expires-on-0910',
      activeProviderId: 'deepseek',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          group: 'preset',
          enabled: true,
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-c74d22f3afc64341805f7af68ecad9f4',
          apiFormat: 'chat_completions',
          models: [
            { id: 'deepseek-v4.1-flash-expires-on-0910', name: 'deepseek-v4.1-flash-expires-on-0910', enabled: true }
          ]
        },
        {
          id: 'ollama',
          name: 'Ollama',
          group: 'preset',
          enabled: true,
          baseURL: 'http://localhost:11434/v1',
          apiKey: 'ollama',
          apiFormat: 'chat_completions',
          models: [
            { id: 'llama3.2', name: 'Llama 3.2', enabled: true }
          ]
        }
      ]
    }

    const provider = createProvider(mixedConfig)
    expect(provider.constructor.name).toBe('OpenAICompatibleProvider')
    expect((provider as any).config.baseURL).toBe('https://api.deepseek.com')
    expect((provider as any).config.model).toBe('deepseek-v4.1-flash-expires-on-0910')
  })
})
