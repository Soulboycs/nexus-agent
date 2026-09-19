import { describe, it, expect } from 'bun:test'
import { tocLevelOf, fieldDisplayOf } from '../../src/packages/docx-engine/parse-fields'
import { parseDocx } from '../../src/packages/docx-engine/parse'
import { buildDocx } from './helpers/build-docx'
import { AgentEngine } from '../../src/main/agent/core/AgentEngine'
import { AgentTool } from '../../src/main/agent/tools/ToolRegistry'
import { z } from 'zod'

describe('Chinese Word TOC Recognition & Layout Test Suite', () => {
  it('1. accurately detects Chinese TOC styles and figure styles via tocLevelOf', () => {
    expect(tocLevelOf('TOC1')).toBe(1)
    expect(tocLevelOf('TOC 2')).toBe(2)
    expect(tocLevelOf('toc 3')).toBe(3)

    // Chinese Word & WPS styles
    expect(tocLevelOf('目录 1')).toBe(1)
    expect(tocLevelOf('目录 2')).toBe(2)
    expect(tocLevelOf('目录3')).toBe(3)
    expect(tocLevelOf('目录１')).toBe(1)
    expect(tocLevelOf('目录一')).toBe(1)
    expect(tocLevelOf('目次 2')).toBe(2)

    // Figure/Table TOC
    expect(tocLevelOf('TableofFigures')).toBe(1)
    expect(tocLevelOf('图表目录')).toBe(1)
    expect(tocLevelOf('表目录')).toBe(1)
  })

  it('2. parses Chinese Word TOC paragraph with tabs into tocLine FieldDisplay', () => {
    const xml = `
      <w:p>
        <w:pPr>
          <w:pStyle w:val="目录 1"/>
          <w:tabs>
            <w:tab w:val="right" w:leader="dot" w:pos="9350"/>
          </w:tabs>
        </w:pPr>
        <w:hyperlink w:anchor="_Toc123456">
          <w:r><w:t>1 前言</w:t></w:r>
          <w:r><w:tab/></w:r>
          <w:r><w:t>1</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `
    const fd = fieldDisplayOf(xml)
    expect(fd).toBeDefined()
    expect(fd?.kind).toBe('tocLine')
    expect(fd?.left).toBe('1 前言')
    expect(fd?.right).toBe('1')
    expect(fd?.leader).toBe('dot')
    expect(fd?.anchor).toBe('_Toc123456')
  })

  it('3. gracefully splits title, manual dots, and page numbers when tab is missing', () => {
    // Some templates use trailing dots directly, e.g. "4.1 PTPA治疗有效性分析....50"
    const xml = `
      <w:p>
        <w:hyperlink w:anchor="_Toc789">
          <w:r><w:t>4.1 PTPA治疗有效性分析....50</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `
    const fd = fieldDisplayOf(xml)
    expect(fd).toBeDefined()
    expect(fd?.kind).toBe('tocLine')
    expect(fd?.left).toBe('4.1 PTPA治疗有效性分析')
    expect(fd?.right).toBe('50')
    expect(fd?.leader).toBe('dot')
  })

  it('4. end-to-end docx parsing identifies Chinese TOC entries as passthrough TOC blocks', async () => {
    const sampleXml = `
      <w:p>
        <w:pPr>
          <w:pStyle w:val="目录 1"/>
          <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs>
        </w:pPr>
        <w:hyperlink w:anchor="_Toc100">
          <w:r><w:t>附录1 答辩委员会组成及答辩决议</w:t></w:r>
          <w:r><w:tab/></w:r>
          <w:r><w:t>99</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `
    const doc = await buildDocx({ bodyXml: sampleXml })
    const parsed = await parseDocx(doc)
    expect(parsed.blocks.length).toBeGreaterThan(0)
    const tocBlock = parsed.blocks[0]
    expect(tocBlock.type).toBe('passthrough')
    expect(tocBlock.label).toBe('TOC entry')
    expect(tocBlock.fieldDisplay?.kind).toBe('tocLine')
    expect(tocBlock.fieldDisplay?.left).toBe('附录1 答辩委员会组成及答辩决议')
    expect(tocBlock.fieldDisplay?.right).toBe('99')
  })
})

describe('Agent Bypass Permissions Mode Test Suite', () => {
  it('1. executes sensitive tools without approval when permissionMode is bypassPermissions', async () => {
    const testTool: AgentTool = {
      name: 'sensitive_tool',
      description: 'A tool that normally requires user confirmation',
      parameters: z.object({ value: z.string() }),
      requiresApproval: () => true, // default requires approval
      execute: async ({ value }) => `Executed: ${value}`
    }

    let callCount = 0
    class MockProvider {
      async chatStream(
        _messages: any,
        _tools: any,
        onChunk: (chunk: any) => void
      ) {
        callCount++
        if (callCount === 1) {
          onChunk({ content: 'Executing test...' })
          return {
            fullThinking: '',
            fullContent: 'Executing test...',
            toolCalls: [{ id: 'call-1', name: 'sensitive_tool', arguments: { value: 'test-run' } }]
          }
        }
        return {
          fullThinking: '',
          fullContent: 'Finished test successfully.',
          toolCalls: []
        }
      }
    }

    const engine = new AgentEngine({
      workspaceRoot: process.cwd(),
      customProvider: new MockProvider() as any,
      permissionMode: 'bypass' // Set to Bypass!
    })

    // Register sensitive tool
    ;(engine as any).toolRegistry.registerTool(testTool)

    const events: any[] = []
    engine.on('event', (e) => events.push(e))

    await engine.run('run test')

    // Verify tool was called
    const toolCallStart = events.find((e) => e.type === 'tool_call_start')
    expect(toolCallStart).toBeDefined()
    // In bypass mode, requiresApproval is overridden to false
    expect(toolCallStart.toolCall.requiresApproval).toBe(false)

    // Verify approval_required was NEVER emitted!
    const approvalReq = events.find((e) => e.type === 'approval_required')
    expect(approvalReq).toBeUndefined()

    // Verify tool executed successfully
    const toolComplete = events.find((e) => e.type === 'tool_call_complete')
    expect(toolComplete).toBeDefined()
    expect(toolComplete.result.output).toBe('Executed: test-run')
  })

  it('2. supports runtime switching between bypassPermissions and default modes', () => {
    const engine = new AgentEngine({
      workspaceRoot: process.cwd(),
      permissionMode: 'ask'
    })

    expect(engine.getPermissionMode()).toBe('ask')
    engine.setPermissionMode('bypass')
    expect(engine.getPermissionMode()).toBe('bypass')
    engine.setPermissionMode('ask')
    expect(engine.getPermissionMode()).toBe('ask')
  })
})
