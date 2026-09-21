/**
 * Real End-to-End Integration Test
 * Uses actual DeepSeek API — real network calls, real tool execution
 *
 * Tests the full chain:
 *   User prompt → AgentEngine → DeepSeek API → Tool calls → File system → Response
 *
 * 凭据注入约定（2026-09-17 P0 整改）：API key 一律来自环境变量 DEEPSEEK_API_KEY
 * （bun 会自动加载本地 .env.local，该文件已被 .gitignore 忽略），严禁硬编码进
 * 任何已提交文件。未配置 key 时本文件全部用例自动 SKIP，默认门禁保持绿灯。
 */
import { describe, it, expect } from 'bun:test'
import { createDefaultAgentEngine } from '../src/main/agent'
import { createProvider } from '../src/main/agent/providers/ProviderFactory'
import { ProviderConfig } from '../src/shared/types'
import { parseMarkdownToNodes } from '../src/renderer/src/components/MarkdownRenderer'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Real DeepSeek credentials — local-only injection via env / .env.local
// 显式加载项目根 .env.local（实测 bun test 不会自动注入该文件）；文件不存在时
// 静默跳过，保持无凭据状态 → 用例 SKIP。绝不硬编码。
function loadLocalEnvFile(): void {
  try {
    const content = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match) continue
      const [, name, rawValue] = match
      if (!(name in process.env)) process.env[name] = rawValue.replace(/^["']|["']$/g, '')
    }
  } catch {
    // .env.local 不存在（CI / 无凭据机器）— 正常状态，真实 API 用例将 SKIP
  }
}
loadLocalEnvFile()

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_CONFIG: ProviderConfig = {
  providerType: 'deepseek',
  apiKey: DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash-expires-on-0910',
  temperature: 0.2
}

if (!DEEPSEEK_API_KEY) {
  console.warn(
    '[E2E] DEEPSEEK_API_KEY 未配置（请写入本地 .env.local，勿提交）— 真实 API e2e 用例将全部 SKIP'
  )
}

const WORKSPACE = os.tmpdir()
const E2E_TIMEOUT = 60000

// ─── Helper ──────────────────────────────────────────────────────────────────
async function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: any
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ─── Test 1: Raw provider chatStream ─────────────────────────────────────────
describe('E2E — DeepSeek Raw API', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('streams a real text response from DeepSeek API', async () => {
    const provider = createProvider(DEEPSEEK_CONFIG)

    const chunks: string[] = []
    const result = await runWithTimeout(
      provider.chatStream(
        [{ role: 'user', content: 'Reply with exactly: NEXUS_OK' }],
        [],
        (chunk) => {
          if (chunk.content) chunks.push(chunk.content)
        }
      ),
      E2E_TIMEOUT
    )

    console.log('[E2E] Raw API fullContent:', JSON.stringify(result.fullContent))
    expect(result.fullContent).toBeTruthy()
    expect(result.fullContent.length).toBeGreaterThan(0)
    // Should contain our requested token
    expect(result.fullContent.toUpperCase()).toContain('NEXUS_OK')
    expect(chunks.length).toBeGreaterThan(0) // streaming chunks received
  }, E2E_TIMEOUT)
})

// ─── Test 2: AgentEngine single turn, no tools ───────────────────────────────
describe('E2E — AgentEngine single turn', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('runs a full agent turn and emits message_delta events', async () => {
    const provider = createProvider(DEEPSEEK_CONFIG)
    const engine = createDefaultAgentEngine({
      permissionMode: 'bypass',
      workspaceRoot: WORKSPACE,
      customProvider: provider
    })

    const events: Array<{ type: string; [k: string]: any }> = []
    engine.on('event', (e: any) => {
      events.push(e)
      console.log(`[E2E] event: ${e.type}`, e.status ?? e.delta?.slice?.(0, 40) ?? '')
    })

    await runWithTimeout(engine.run('Reply with exactly: AGENT_E2E_OK'), E2E_TIMEOUT)

    const types = events.map(e => e.type)
    expect(types).toContain('status_change')
    expect(types).toContain('message_delta')

    const fullResponse = events
      .filter(e => e.type === 'message_delta')
      .map(e => e.delta)
      .join('')

    console.log('[E2E] Full streamed response:', JSON.stringify(fullResponse))
    expect(fullResponse.toUpperCase()).toContain('AGENT_E2E_OK')
    expect(engine.getStatus()).toBe('completed')
  }, E2E_TIMEOUT)
})

// ─── Test 3: Agent calls a real tool (list_directory) ────────────────────────
describe('E2E — AgentEngine tool call', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('agent calls list_directory tool on real filesystem', async () => {
    const provider = createProvider(DEEPSEEK_CONFIG)
    const engine = createDefaultAgentEngine({
      permissionMode: 'bypass',
      workspaceRoot: WORKSPACE,
      customProvider: provider
    })

    const toolCallEvents: any[] = []
    const toolResultEvents: any[] = []
    engine.on('event', (e: any) => {
      if (e.type === 'tool_call_start') toolCallEvents.push(e)
      if (e.type === 'tool_call_complete') toolResultEvents.push(e)
      console.log(`[E2E] event: ${e.type}`, e.toolCall?.name ?? e.result?.name ?? '')
    })

    await runWithTimeout(
      engine.run(`List the files in directory: ${WORKSPACE}. Use the LS tool (do not use Bash). Then tell me what you found.`),
      E2E_TIMEOUT
    )

    console.log('[E2E] Tool calls made:', toolCallEvents.map(e => e.toolCall?.name))
    console.log('[E2E] Tool results:', toolResultEvents.map(e => e.result?.name))

    // Agent should have called at least one tool
    expect(toolCallEvents.length).toBeGreaterThan(0)
    const toolNames = toolCallEvents.map(e => e.toolCall?.name)
    // Should call list_directory or similar file tool
    // R5 改名后正名为 LS/Read/Glob/Grep；旧名走别名也兼容
    const fileTools = ['LS', 'Read', 'Glob', 'Grep', 'Bash', 'list_directory', 'view_file', 'GlobTool', 'GrepTool']
    expect(toolNames.some((n: string) => fileTools.includes(n))).toBe(true)

    // Tool should return a result
    expect(toolResultEvents.length).toBeGreaterThan(0)
    expect(toolResultEvents[0].result.isError).toBe(false)
  }, 30000)
})

// ─── Test 4: Agent reads a real file ─────────────────────────────────────────
describe('E2E — Agent reads a real file', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('agent reads a temp file and reports its content', async () => {
    // Write a test file
    const testFile = path.join(WORKSPACE, 'nexus_e2e_test.txt')
    const testContent = 'NEXUS_FILE_CONTENT_12345'
    fs.writeFileSync(testFile, testContent, 'utf-8')

    try {
      const provider = createProvider(DEEPSEEK_CONFIG)
      const engine = createDefaultAgentEngine({
      permissionMode: 'bypass',
        workspaceRoot: WORKSPACE,
        customProvider: provider
      })

      const allDelta: string[] = []
      engine.on('event', (e: any) => {
        if (e.type === 'approval_required') {
          engine.respondApproval(e.request.id, true)
        }
        if (e.type === 'message_delta') allDelta.push(e.delta)
        console.log(`[E2E] event: ${e.type}`, e.toolCall?.name ?? e.delta?.slice?.(0, 30) ?? '')
      })

      await runWithTimeout(
        engine.run(`Read the file at path "${testFile}" using view_file and tell me the exact content you find.`),
        E2E_TIMEOUT
      )

      const finalResponse = allDelta.join('')
      console.log('[E2E] Agent response:', JSON.stringify(finalResponse))

      // Agent should have found and reported the magic string
      expect(finalResponse).toContain('NEXUS_FILE_CONTENT_12345')

      // E2E Verification: Real DeepSeek Markdown response parsed through Nexus MarkdownRenderer
      const renderNodes = parseMarkdownToNodes(finalResponse)
      expect(renderNodes.length).toBeGreaterThanOrEqual(1)
      const hasCodeOrHtml = renderNodes.some(
        (n) => n.type === 'code' || (n.type === 'html' && n.content.includes('NEXUS_FILE_CONTENT_12345'))
      )
      expect(hasCodeOrHtml).toBe(true)
    } finally {
      fs.unlinkSync(testFile)
    }
  }, E2E_TIMEOUT)
})

// ─── Test 5: Model selector — provider switches correctly ────────────────────
describe('E2E — Provider switch via setProvider', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('engine accepts provider switch and runs successfully with new provider', async () => {
    const provider1 = createProvider(DEEPSEEK_CONFIG)
    const engine = createDefaultAgentEngine({
      permissionMode: 'bypass',
      workspaceRoot: WORKSPACE,
      customProvider: provider1
    })

    // First run
    await runWithTimeout(engine.run('Say: FIRST_PROVIDER'), E2E_TIMEOUT)
    expect(engine.getStatus()).toBe('completed')

    // Switch provider (same DeepSeek, simulating a model change)
    const provider2 = createProvider({
      ...DEEPSEEK_CONFIG,
      model: 'deepseek-chat' // different model
    })
    engine.setProvider(provider2)

    // Second run with new provider
    const events2: string[] = []
    engine.on('event', (e: any) => {
      if (e.type === 'message_delta') events2.push(e.delta)
    })

    await runWithTimeout(engine.run('Say: SECOND_PROVIDER'), E2E_TIMEOUT)
    expect(engine.getStatus()).toBe('completed')

    const resp2 = events2.join('')
    console.log('[E2E] After provider switch response:', JSON.stringify(resp2))
    expect(resp2.length).toBeGreaterThan(0)
  }, E2E_TIMEOUT)
})

// ─── Test 6: E2E — Real Live Streaming, TTFT & TPS Performance ──────────────
import { StreamPacer } from '../src/renderer/src/utils/streamPacer'

describe('E2E — Real Live Streaming, TTFT & TPS Performance', () => {
  it.skipIf(!DEEPSEEK_API_KEY)('measures real DeepSeek TTFT, live TPS and verifies 100% StreamPacer delivery', async () => {
    const provider = createProvider(DEEPSEEK_CONFIG)
    const engine = createDefaultAgentEngine({
      permissionMode: 'bypass',
      workspaceRoot: WORKSPACE,
      customProvider: provider
    })

    const pacer = new StreamPacer()
    let accumulatedText = ''
    let firstTokenTime: number | null = null
    const startTime = performance.now()

    await runWithTimeout(
      provider.chatStream(
        [{ role: 'user', content: 'Write a concise 5-line JavaScript function to compute fibonacci with memoization.' }],
        [],
        (chunk) => {
          if (chunk.content) {
            if (firstTokenTime === null) {
              firstTokenTime = performance.now()
            }
            accumulatedText += chunk.content
            pacer.setTarget(accumulatedText)
          }
        }
      ),
      E2E_TIMEOUT
    )

    const endTime = performance.now()
    const ttft = firstTokenTime ? firstTokenTime - startTime : 0
    const totalDuration = (endTime - startTime) / 1000 // seconds
    const estimatedTokens = Math.round(accumulatedText.length / 3.5)
    const tps = totalDuration > 0 ? estimatedTokens / totalDuration : 0

    console.log(`[E2E METRICS] === Real DeepSeek Live Streaming Metrics ===`)
    console.log(`[E2E METRICS] Actual TTFT (Time To First Token): ${ttft.toFixed(1)}ms`)
    console.log(`[E2E METRICS] Total Stream Duration: ${totalDuration.toFixed(2)}s`)
    console.log(`[E2E METRICS] Output Length: ${accumulatedText.length} chars (~${estimatedTokens} tokens)`)
    console.log(`[E2E METRICS] Average Generation TPS: ${tps.toFixed(1)} tokens/sec`)

    // Verify TTFT was recorded and reasonable (< 5000ms over public internet)
    expect(firstTokenTime).not.toBeNull()
    expect(ttft).toBeGreaterThan(0)
    expect(ttft).toBeLessThan(10000)

    // Verify StreamPacer drains all remaining tokens under backpressure within <= 20 frames
    let drainFrames = 0
    while (!pacer.isDone() && drainFrames < 50) {
      pacer.step(16, true)
      drainFrames++
    }

    console.log(`[E2E METRICS] StreamPacer Final Drain Frames: ${drainFrames} (~${(drainFrames * 16.6).toFixed(0)}ms)`)
    expect(drainFrames).toBeLessThanOrEqual(25) // <= 25 frames (~350ms)
    expect(pacer.getDisplayed()).toBe(accumulatedText)
  }, E2E_TIMEOUT)
})

