import { describe, it, expect } from 'bun:test'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import JSZip from 'jszip'
import { createDefaultAgentEngine } from '../../src/main/agent'
import { createProvider } from '../../src/main/agent/providers/ProviderFactory'
import { parseDocx } from '../../src/packages/docx-engine'
import type { ProviderConfig } from '../../src/shared/types'

function loadLocalEnvFile(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env.local')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (!match) continue
        const [, name, rawValue] = match
        if (!(name in process.env)) process.env[name] = rawValue.replace(/^["']|["']$/g, '')
      }
    }
  } catch {}
}
loadLocalEnvFile()

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_CONFIG: ProviderConfig = {
  providerType: 'deepseek',
  apiKey: DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash-expires-on-0910',
  temperature: 0.1
}

describe('Autonomous Nexus Agent Live Word Toolchain & Performance E2E', () => {
  it.skipIf(!DEEPSEEK_API_KEY)(
    'executes full live agent turn lifecycle across docx_create, docx_read, docx_modify_block, docx_insert_table, docx_append_content',
    async () => {
      const tempWorkspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-agent-word-test-'))
      const targetDocx = 'benchmark-agent.docx'
      const absoluteDocxPath = path.join(tempWorkspace, targetDocx)

      const provider = createProvider(DEEPSEEK_CONFIG)
      const engine = createDefaultAgentEngine({
        workspaceRoot: tempWorkspace,
        customProvider: provider
      })

      const toolDurations: Record<string, number> = {}

      engine.on('event', (e: any) => {
        if (e.type === 'approval_required') {
          engine.respondApproval(e.request.id, true)
        }
        if (e.type === 'tool_call_start') {
          toolDurations[e.toolCall?.id] = performance.now()
        }
        if (e.type === 'tool_call_complete') {
          const start = toolDurations[e.result?.toolCallId]
          if (start) {
            const ms = performance.now() - start
            toolDurations[e.result?.name] = ms
          }
        }
      })

      try {
        // Step 1: docx_create
        await engine.run(
          `请使用 docx_create 工具为我创建一个 Word 文档 "${targetDocx}"，标题为 "Nexus 智能办公平台性能评测白皮书"，包含段落："第一章：系统架构与全双工实时引擎。" 和 "第二章：选中文本浮动气泡与智能体协同调度机制。"`
        )
        expect(engine.getStatus()).toBe('completed')

        // Step 2: docx_read
        await engine.run(`请使用 docx_read 工具读取 "${targetDocx}" 的内容，列出块索引。`)
        expect(engine.getStatus()).toBe('completed')

        // Step 3: docx_modify_block
        await engine.run(
          `请使用 docx_modify_block 工具将 "${targetDocx}" 中第 2 个块润色修改为："第二章（深度润色）：基于全双工事件驱动的选区浮动气泡与自愈式智能体毫秒级并发协同架构。"`
        )
        expect(engine.getStatus()).toBe('completed')

        // Step 4: docx_insert_table
        await engine.run(
          `请使用 docx_insert_table 工具在 "${targetDocx}" 的第 2 个块后面插入一个 3 行 3 列的技术延迟实测对比表格。表头：["评测环节", "基准门禁标准", "Nexus实测延迟"]，数据行：["选区感知与芯片匹配", "< 5.00ms", "0.054ms"]，["外科手术局部补丁落盘", "< 150.00ms", "2.57ms"]，afterBlockIndex 参数设为 2。`
        )
        expect(engine.getStatus()).toBe('completed')

        // Step 5: docx_append_content
        await engine.run(
          `请使用 docx_append_content 工具在 "${targetDocx}" 文档末尾追加一个总结章节：标题 "三、评测结论与架构展望"（level 1），正文段落 "全链路真实端到端测试表明系统各项操作达到毫秒级响应并严格保证物理文件 100% 保真。"`
        )
        expect(engine.getStatus()).toBe('completed')

        // Step 6: Physical File Verification
        const fileBuffer = await fsPromises.readFile(absoluteDocxPath)
        const parsedDoc = await parseDocx(fileBuffer)
        const visibleBlocks = parsedDoc.blocks.filter((b: any) => !b.hidden)

        expect(visibleBlocks.length).toBeGreaterThanOrEqual(6)
        expect(visibleBlocks[0].runs?.[0]?.text).toContain('Nexus 智能办公平台性能评测白皮书')
        expect(visibleBlocks[2].runs?.[0]?.text).toContain('第二章（深度润色）')

        // Verify table exists
        const tableBlock = visibleBlocks.find((b: any) => b.type === 'table')
        expect(tableBlock).toBeDefined()
        const rowCount = tableBlock.table?.rows?.length || tableBlock.tableModel?.rows?.length || 0
        expect(rowCount).toBe(3)

        // Latency assertions
        for (const [toolName, duration] of Object.entries(toolDurations)) {
          if (toolName.startsWith('docx_')) {
            console.log(`[E2E AGENT METRICS] Tool ${toolName} execution duration: ${duration.toFixed(2)}ms`)
            expect(duration).toBeLessThan(150) // All Word tools must execute under 150ms
          }
        }
      } finally {
        await fsPromises.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {})
      }
    },
    60000
  )

  it.skipIf(!DEEPSEEK_API_KEY)(
    'executes full live agent Track Changes workflow: records revisions, unzips raw OOXML, reads and accepts via Agent',
    async () => {
      const tempWorkspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-agent-track-live-'))
      const targetDocx = 'live-track-agent.docx'
      const absoluteDocxPath = path.join(tempWorkspace, targetDocx)

      const provider = createProvider(DEEPSEEK_CONFIG)
      const engine = createDefaultAgentEngine({
        workspaceRoot: tempWorkspace,
        customProvider: provider
      })

      engine.on('event', (e: any) => {
        if (e.type === 'approval_required') {
          engine.respondApproval(e.request.id, true)
        }
      })

      try {
        // 1. Create document
        await engine.run(
          `请使用 docx_create 工具创建 Word 文档 "${targetDocx}"，标题为 "前沿人工智能技术报告"，段落包含："待审阅的第一稿结论：模型能力一般，需要进一步调优。"`
        )
        expect(engine.getStatus()).toBe('completed')

        // 2. Modify with Track Changes enabled
        await engine.run(
          `请使用 docx_modify_block 工具将 "${targetDocx}" 中第 1 个块的内容修改为："审阅后终稿结论：该模型在复杂逻辑推理与代码生成基准上取得前沿最优突破。"，要求必须开启修订痕迹记录模式（trackChanges: true），审阅者 author 设置为 "Nexus Senior Reviewer"。`
        )
        expect(engine.getStatus()).toBe('completed')

        // 3. PHYSICAL DISK & RAW OOXML VERIFICATION (Zero-mock via JSZip)
        const fileBuffer = await fsPromises.readFile(absoluteDocxPath)
        const zip = await JSZip.loadAsync(fileBuffer)
        const docXml = await zip.file('word/document.xml')?.async('text')
        expect(docXml).toBeDefined()

        // Assert literal ECMA-376 OOXML Track Changes tags
        expect(docXml).toContain('<w:del')
        expect(docXml).toContain('w:author="Nexus Senior Reviewer"')
        expect(docXml).toContain('<w:delText')
        expect(docXml).toContain('模型能力一般')
        expect(docXml).toContain('<w:ins')
        expect(docXml).toContain('审阅后终稿结论')

        // 4. Agent reads revisions
        await engine.run(`请使用 docx_read_revisions 工具读取 "${targetDocx}" 中所有待审阅的修订痕迹，并简要汇报。`)
        expect(engine.getStatus()).toBe('completed')

        // 5. Agent accepts all revisions
        await engine.run(`请使用 docx_accept_revisions 工具将 "${targetDocx}" 中的所有待审阅修订全部接受。`)
        expect(engine.getStatus()).toBe('completed')

        // 6. PHYSICAL DISK & RAW OOXML POST-ACCEPT VERIFICATION
        const acceptedBuffer = await fsPromises.readFile(absoluteDocxPath)
        const acceptedZip = await JSZip.loadAsync(acceptedBuffer)
        const acceptedDocXml = await acceptedZip.file('word/document.xml')?.async('text')
        expect(acceptedDocXml).toBeDefined()

        // Assert that <w:del> is completely purged from disk
        expect(acceptedDocXml).not.toContain('<w:del')
        expect(acceptedDocXml).not.toContain('<w:delText')
        // Assert that <w:ins> tag is removed, leaving clean final text
        expect(acceptedDocXml).not.toContain('<w:ins')
        expect(acceptedDocXml).toContain('审阅后终稿结论：该模型在复杂逻辑推理与代码生成基准上取得前沿最优突破。')
      } finally {
        await fsPromises.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {})
      }
    },
    60000
  )
})
