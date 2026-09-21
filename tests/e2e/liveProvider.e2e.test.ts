import { describe, it, expect } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * R4 真实依赖 E2E — 真实 LLM × 真实工具 × 真实沙箱（非 Mock）。
 *
 * 条件执行：本机存在真实 provider apiKey 时才运行（读取 Electron userData
 * 的 agent-config.json，与生产同一配置源）。无 key 时显式 skip 并记录——
 * 依据 evidence-driven skill：跳过项必须显式记录，不能混入绿色数字。
 *
 * 验证"生产同构链路"：真实 chatStream（统一重试/缓存断点请求形状被真实
 * API 接受）→ 真实工具执行 → 真实文件副作用 → 真实回合收尾。
 */

interface ProviderFile {
  apiKey?: string
  providers?: Record<string, { apiKey?: string; anthropicApiKey?: string; baseURL?: string; model?: string }>
  providerType?: string
  baseURL?: string
  model?: string
}

function loadRealConfigFile(): { path: string; cfg: ProviderFile } | null {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'nexus-agent', 'agent-config.json'),
    path.join(os.homedir(), '.claude-agent', 'config.json'),
  ]
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) as ProviderFile
      // 与生产同一判定：任一 provider 配置了 key 即视为真实可用。
      // 注意不在此处抠字段——整份配置交给 ProviderFactory（生产同构），
      // 由 findActiveModelAndProvider 解析 active model，避免字段错位。
      const anyKey =
        cfg.apiKey ||
        Object.values(cfg.providers ?? {}).some((pv) => pv?.apiKey || pv?.anthropicApiKey)
      if (anyKey) return { path: p, cfg }
    } catch {
      // 解析失败视为无配置
    }
  }
  return null
}

const real = loadRealConfigFile()

describe('E2E — 真实 LLM × 真实工具（生产同构链路）', () => {
  it.skipIf(
    !real
  )(
    '真实模型调用 write_to_file 完成一次性写入任务（真实副作用）',
    async () => {
      const { createDefaultAgentEngine } = await import('../../src/main/agent')
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-live-e2e-'))

      const engine = createDefaultAgentEngine({
        workspaceRoot: workspace,
        permissionMode: 'bypass',
        providerConfig: real!.cfg as any,
        maxSteps: 6,
      })

      const targetName = 'nexus-live-e2e-probe.txt'
      const terminal = await engine.run(
        `Use the write_to_file tool to create a file named "${targetName}" in the workspace root with exactly this content: hello-from-live-e2e. Then reply with just OK.`
      )

      expect(terminal.reason).toBe('completed')
      const targetPath = path.join(workspace, targetName)
      expect(fs.existsSync(targetPath)).toBe(true)
      expect(fs.readFileSync(targetPath, 'utf-8')).toContain('hello-from-live-e2e')

      const okReply = terminal.messages.filter((m: any) => m.role === 'assistant').pop()
      console.log('[live-e2e] assistant reply:', String(okReply?.content || '').slice(0, 120))
      fs.rmSync(workspace, { recursive: true, force: true })
    },
    120_000
  )

  it.skipIf(real)('SKIP 记录：本机无真实 provider key，真实依赖 E2E 未执行', () => {
    console.log('[live-e2e] SKIPPED — no real provider key found')
  })
})
