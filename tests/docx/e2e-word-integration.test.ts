import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import JSZip from 'jszip'
import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  generateParagraphXml,
  generateTableXml,
  patchTableCellTexts,
  latexToOmml,
  mathParagraphXml,
  type SaveBlock,
  type GenerateContext,
} from '../../src/packages/docx-engine/index'
import {
  encryptDocx,
  decryptDocx,
  isEncryptedDocx,
  isCfbFile,
  DocxDecryptError,
} from '../../src/main/docx/docx-encryption'
import {
  docxReadTool,
  docxCreateTool,
  docxAppendContentTool,
  docxModifyBlockTool,
  docxInsertTableTool,
} from '../../src/main/agent/tools/docxTools'

describe('Word (.docx) E2E Integration & Anti-Brittle Quality Verification', () => {
  const CTX: GenerateContext = {
    headingStyleIds: new Map([
      [1, 'Heading1'],
      [2, 'Heading2'],
      [3, 'Heading3'],
    ]),
    allocateHyperlinkRel: () => 'rId' + Math.floor(Math.random() * 10000),
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 1: 全生命周期富文档生成、序列化与 AST 保真度回读 (Round-Trip Fidelity)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 1: Document Construction, Round-trip Serialization & AST Fidelity', () => {
    it('builds rich document from blank template, saves as docx, and reparses with exact format fidelity', async () => {
      // 1. 从空白模板构建基底
      const blankBytes = await buildBlankDocx()
      expect(blankBytes.length).toBeGreaterThan(1000)
      const baseDoc = await parseDocx(blankBytes)

      // 2. 构造复杂业务内容块
      const saveBlocks: SaveBlock[] = []

      // 2.1 标题1 (Heading 1)
      const titleXml = generateParagraphXml(
        {
          type: 'heading',
          level: 1,
          runs: [{ text: 'Nexus 智能文档架构白皮书', bold: true }],
        },
        CTX,
      )
      saveBlocks.push({ kind: 'xml', xml: titleXml })

      // 2.2 标题2 (Heading 2)
      const subtitleXml = generateParagraphXml(
        {
          type: 'heading',
          level: 2,
          runs: [{ text: '1. 系统核心特性与规范', bold: true }],
        },
        CTX,
      )
      saveBlocks.push({ kind: 'xml', xml: subtitleXml })

      // 2.3 富文本段落 (混合样式: 加粗、斜体、下划线、字号与颜色)
      const richParagraphXml = generateParagraphXml(
        {
          type: 'paragraph',
          format: { align: 'left', shadingFill: 'F2F4F8' },
          runs: [
            { text: '本文档由 ', bold: false },
            { text: 'Nexus Word Engine', bold: true, color: '1A56DB' },
            { text: ' 自动化集成生成，支持 ', bold: false },
            { text: '高保真排版', italic: true, underline: true },
            { text: ' 与多维表格。', bold: false },
          ],
        },
        CTX,
      )
      saveBlocks.push({ kind: 'xml', xml: richParagraphXml })

      // 2.4 数据表格 (2 行 3 列，包含表头、底纹与数据单元格)
      const baseTableXml = generateTableXml(2, 3, { headerRow: true })
      const tableWithContent = patchTableCellTexts(baseTableXml, [
        [['模块名称'], ['对齐状态'], ['测试覆盖率']],
        [['OOXML AST 引擎'], ['1:1 绝对对齐'], ['100% 通过']],
      ])
      saveBlocks.push({ kind: 'xml', xml: tableWithContent })

      // 2.5 LaTeX / OMML 数学公式段落 (二次方程求根公式)
      const latexFormula = 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'
      const omml = latexToOmml(latexFormula)
      expect(omml).toContain('<m:f>') // 强断言：必须生成合法的分式结构
      expect(omml).toContain('<m:rad>') // 强断言：必须生成合法的根号结构
      const mathParaXml = mathParagraphXml(omml)
      saveBlocks.push({ kind: 'xml', xml: mathParaXml })

      // 3. 执行真实二进制保存并注入页眉与水印
      const savedBytes = await saveDocx(baseDoc, saveBlocks, {
        header: { text: '机密 - Nexus Core 自动化测试' },
        watermark: { text: 'INTERNAL ONLY' },
      })

      // 4. 物理 Zip 结构强断言 (验证真实的 OOXML 物理规范，绝非假 mock)
      const zip = await JSZip.loadAsync(savedBytes)
      const docXml = await zip.file('word/document.xml')?.async('string')
      expect(docXml).toBeDefined()
      expect(docXml).toContain('<w:tbl')
      expect(docXml).toContain('<w:tc')
      expect(docXml).toContain('<m:oMath')
      expect(docXml).toContain('Nexus 智能文档架构白皮书')

      const headerXml = await zip.file('word/header1.xml')?.async('string')
      expect(headerXml).toBeDefined()
      expect(headerXml).toContain('机密 - Nexus Core 自动化测试')

      // 5. 重新反解析并校验 AST 树的完整性与强格式保真度
      const reparsedDoc = await parseDocx(savedBytes)
      const visibleBlocks = reparsedDoc.blocks.filter((b) => !b.hidden)

      // 严格断言块数量: H1 + H2 + Paragraph + Table + TableTrailingParagraph + MathPara = 6 个可见块
      expect(visibleBlocks.length).toBe(6)

      // 强断言块类型分布 (按 OOXML 规范，表格后紧跟段落，独立展示公式解析为 passthrough 保护公式块)
      expect(visibleBlocks.map((b) => b.type)).toEqual([
        'heading',
        'heading',
        'paragraph',
        'table',
        'paragraph',
        'passthrough',
      ])

      // 强断言标题级别与文本
      expect(visibleBlocks[0].level).toBe(1)
      expect(visibleBlocks[0].runs?.map((r) => r.text).join('')).toBe('Nexus 智能文档架构白皮书')

      expect(visibleBlocks[1].level).toBe(2)
      expect(visibleBlocks[1].runs?.map((r) => r.text).join('')).toBe('1. 系统核心特性与规范')

      // 强断言富文本段落 run 级别样式与属性
      const richBlock = visibleBlocks[2]
      expect(richBlock.runs?.some((r) => r.bold && r.color === '1A56DB' && r.text === 'Nexus Word Engine')).toBe(true)
      expect(richBlock.runs?.some((r) => r.italic && r.underline && r.text === '高保真排版')).toBe(true)

      // 强断言表格结构与单元格文本 (底层 AST 中 table.rows 为包含 Cell 对象的二维数组)
      const tableBlock = visibleBlocks[3]
      expect(tableBlock.type).toBe('table')
      expect(tableBlock.table?.rows?.length).toBe(2)
      const firstRow = tableBlock.table?.rows[0]
      expect(firstRow?.map((c: any) => c.paras[0])).toEqual([
        '模块名称',
        '对齐状态',
        '测试覆盖率',
      ])
      const secondRow = tableBlock.table?.rows[1]
      expect(secondRow?.map((c: any) => c.paras[0])).toEqual([
        'OOXML AST 引擎',
        '1:1 绝对对齐',
        '100% 通过',
      ])

      // 强断言数学公式被正确识别与解析为受保护公式块并提取 MathML
      const formulaBlock = visibleBlocks[5]
      expect(formulaBlock.type).toBe('passthrough')
      expect(formulaBlock.formulaDisplay?.mathml).toContain('<mfrac>')
      expect(formulaBlock.formulaDisplay?.mathml).toContain('<msqrt>')

      // 强断言页眉文本
      expect(reparsedDoc.headerText).toBe('机密 - Nexus Core 自动化测试')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 2: ECMA-376 (Agile/Standard) 真实加解密与 Fail-Closed 边界安全防护测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 2: ECMA-376 Agile Document Encryption & Fail-Closed Security', () => {
    it('encrypts docx into OLE2/CFB format, fails closed on wrong/corrupt passwords, and restores perfectly on valid key', async () => {
      // 1. 构建一个有效的明文 docx
      const plainDocx = await buildBlankDocx()
      const doc = await parseDocx(plainDocx)
      const saveBlocks: SaveBlock[] = [
        {
          kind: 'xml',
          xml: generateParagraphXml(
            {
              type: 'paragraph',
              runs: [{ text: '机密加密测试数据：TOP_SECRET_PAYLOAD_2026', bold: true }],
            },
            CTX,
          ),
        },
      ]
      const originalPlainBytes = await saveDocx(doc, saveBlocks)
      expect(isCfbFile(originalPlainBytes)).toBe(false)
      expect(isEncryptedDocx(originalPlainBytes)).toBe(false)

      const CORRECT_PASSWORD = 'NexusSecretKey#9981!'
      const WRONG_PASSWORD = 'InvalidPassword@1234'

      // 2. 执行真实 ECMA-376 加密
      const encryptedBytes = encryptDocx(originalPlainBytes, CORRECT_PASSWORD)

      // 强断言物理容器特征：加密后的文档应封装为 CFB (OLE2) 容器，包含 EncryptedPackage
      expect(isCfbFile(encryptedBytes)).toBe(true)
      expect(isEncryptedDocx(encryptedBytes)).toBe(true)

      // 强断言：普通 zip 解析器必须拒绝解析加密容器 (Fail-Closed)
      await expect(JSZip.loadAsync(encryptedBytes)).rejects.toThrow()

      // 3. 负向测试 (Negative Test 1): 错误密码必须坚决拒绝并抛出 DocxDecryptError('wrong-password')
      let caughtWrongPwdError: any = null
      try {
        await decryptDocx(encryptedBytes, WRONG_PASSWORD)
      } catch (err) {
        caughtWrongPwdError = err
      }
      expect(caughtWrongPwdError).toBeInstanceOf(DocxDecryptError)
      expect(caughtWrongPwdError.reason).toBe('wrong-password')

      // 4. 负向测试 (Negative Test 2): 空密码必须拒绝
      let caughtEmptyPwdError: any = null
      try {
        await decryptDocx(encryptedBytes, '')
      } catch (err) {
        caughtEmptyPwdError = err
      }
      expect(caughtEmptyPwdError).toBeInstanceOf(DocxDecryptError)

      // 5. 负向测试 (Negative Test 3): 损坏的密文字节流必须拒绝 (防篡改)
      const corruptedBytes = Buffer.from(encryptedBytes)
      // 破坏密文中间 64 字节
      corruptedBytes.fill(0xee, 500, 564)
      await expect(decryptDocx(corruptedBytes, CORRECT_PASSWORD)).rejects.toThrow()

      // 6. 正向测试 (Positive Test): 使用正确密码解密
      const decryptedBytes = await decryptDocx(encryptedBytes, CORRECT_PASSWORD)
      expect(decryptedBytes.length).toBe(originalPlainBytes.length)
      expect(isCfbFile(decryptedBytes)).toBe(false)
      expect(isEncryptedDocx(decryptedBytes)).toBe(false)

      // 7. 强断言解密后的数据被成功还原为标准 docx 并能无损解析
      const decryptedDoc = await parseDocx(decryptedBytes)
      const decryptedVisible = decryptedDoc.blocks.filter((b) => !b.hidden)
      expect(decryptedVisible.length).toBe(1)
      const text = decryptedVisible[0].runs?.map((r) => r.text).join('')
      expect(text).toBe('机密加密测试数据：TOP_SECRET_PAYLOAD_2026')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 3: Preload 与 DesktopApi / DocsApi 契约完整性与隔离性测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 3: Preload DesktopApi & DocsApi Contract Integrity', () => {
    it('verifies all docsApi methods match main IPC declarations without hanging/undefined endpoints', async () => {
      // 读取 preload/index.ts 源码以验证 contextBridge 暴露的 docsApi 接口契约
      const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts')
      const preloadCode = await fs.readFile(preloadPath, 'utf-8')

      // 强断言：preload 必须同时在 mainWorld 暴露 docsApi 与 desktop，确保前端双重兼容
      expect(preloadCode).toContain("contextBridge.exposeInMainWorld('docsApi', docsApi)")
      expect(preloadCode).toContain("contextBridge.exposeInMainWorld('desktop', docsApi)")

      // 验证前端 Ribbon 与组件核心依赖的 18 个关键方法均在 docsApi 中有明确定义
      const requiredMethods = [
        'openDocx',
        'openDocxPath',
        'openDocxDecrypt',
        'createBlankDoc',
        'saveDocx',
        'saveDocxAs',
        'saveDocxNew',
        'saveDocxTo',
        'pickImage',
        'consumePendingOpenDocx',
        'consumeNewBlankDoc',
        'onOpenDocx',
        'onRenamedDocx',
        'getLanguage',
        'getTheme',
        'getAutoSavePref',
        'setAutoSavePref',
        'setDocPassword',
      ]

      for (const m of requiredMethods) {
        expect(preloadCode).toContain(`${m}:`)
      }

      // 强断言：验证主进程注册的 IPC channel 字符串在 preload 中完全对称调用
      const ipcChannels = [
        'docs:open',
        'docs:open-path',
        'docs:open-decrypt',
        'docs:create-blank',
        'docs:save',
        'docs:save-as',
        'docs:pick-image',
      ]

      for (const ch of ipcChannels) {
        expect(preloadCode).toContain(`'${ch}'`)
      }
    })

    it('verifies createBlankDoc produces a valid, immediately parseable Word buffer', async () => {
      const buffer = await buildBlankDocx()
      const doc = await parseDocx(buffer)
      expect(doc.blocks).toBeDefined()
      expect(doc.styles.has('Normal')).toBe(true)
      expect(doc.styles.has('Heading1')).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Suite 4: Agent Word 工具链端到端全链路自动化与物理落盘验证
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Suite 4: Autonomous Agent Docx Toolchain (Create -> Read -> Append -> Verify)', () => {
    it('executes full autonomous lifecycle of creating, inspecting, and appending to docx with physical file verification', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-word-test-'))
      const targetDocx = 'Architecture-Review.docx'
      const absoluteTargetDocx = path.join(tempDir, targetDocx)

      const context = { workspaceRoot: tempDir }

      try {
        // Step 1: docx_create 创建新文档
        const createResult = await docxCreateTool.execute(
          {
            filePath: targetDocx,
            title: 'Nexus Autonomous Agent 白皮书',
            paragraphs: [
              '第一章：系统架构与核心价值。',
              '第二章：基于 Evidence-Driven Engineering 的自动化交付。',
            ],
          },
          context,
        )

        expect(createResult).toContain('Successfully created docx document')
        expect(createResult).toContain('with 3 blocks')

        // 强断言物理文件已经落盘
        const fileStat1 = await fs.stat(absoluteTargetDocx)
        expect(fileStat1.size).toBeGreaterThan(2000)

        // Step 2: docx_read 结构化审查已落盘文档
        const readResult1 = await docxReadTool.execute(
          {
            filePath: targetDocx,
            fullText: true,
          },
          context,
        )

        expect(readResult1).toContain('Total Blocks: 3')
        expect(readResult1).toContain('[Block 0] [H1] Nexus Autonomous Agent 白皮书')
        expect(readResult1).toContain('[Block 1] [Paragraph] 第一章：系统架构与核心价值。')
        expect(readResult1).toContain('[Block 2] [Paragraph] 第二章：基于 Evidence-Driven Engineering 的自动化交付。')

        // Step 3: docx_append_content 追加新章节与内容
        const appendResult = await docxAppendContentTool.execute(
          {
            filePath: targetDocx,
            items: [
              {
                type: 'heading',
                level: 2,
                text: '2.1 零假绿与反脆弱测试原则',
              },
              {
                type: 'paragraph',
                text: '所有断言必须具有直接的数据副作用检查，杜绝仅验证 not.toThrow 的敷衍测试。',
              },
            ],
          },
          context,
        )

        expect(appendResult).toContain('Successfully appended 2 block(s)')

        // Step 4: 再次使用 docx_read 验证追加后的数据流转
        const readResult2 = await docxReadTool.execute(
          {
            filePath: targetDocx,
            fullText: true,
          },
          context,
        )

        expect(readResult2).toContain('Total Blocks: 5')
        expect(readResult2).toContain('[Block 3] [H2] 2.1 零假绿与反脆弱测试原则')
        expect(readResult2).toContain('[Block 4] [Paragraph] 所有断言必须具有直接的数据副作用检查')

        // Step 5: docx_modify_block 精确局部修改已有文档中的指定段落
        const modifyResult = await docxModifyBlockTool.execute(
          {
            filePath: targetDocx,
            blockIndex: 1,
            text: '第一章（已由 Agent 深度重构）：系统架构与核心价值体系。',
          },
          context,
        )

        expect(modifyResult).toContain('Successfully modified block 1')

        // 验证局部修改后，Block 1 更新，但其他 Block (0, 2, 3, 4) 毫发无损
        const readResult3 = await docxReadTool.execute(
          {
            filePath: targetDocx,
            fullText: true,
          },
          context,
        )
        expect(readResult3).toContain('[Block 1] [Paragraph] 第一章（已由 Agent 深度重构）：系统架构与核心价值体系。')
        expect(readResult3).toContain('[Block 0] [H1] Nexus Autonomous Agent 白皮书')
        expect(readResult3).toContain('[Block 2] [Paragraph] 第二章：基于 Evidence-Driven Engineering 的自动化交付。')

        // Step 6: docx_insert_table 向已有文档插入结构化表格
        const insertTableResult = await docxInsertTableTool.execute(
          {
            filePath: targetDocx,
            headers: ['模块名称', '状态', '测试覆盖'],
            rows: [
              ['Docx AST 引擎', '生产就绪', '100%'],
              ['Agent 修改工具', '生产就绪', '100%'],
            ],
          },
          context,
        )

        expect(insertTableResult).toContain('Successfully inserted a 3x3 table')

        // Step 7: 再次读取并验证表格已持久化落盘
        const readResult4 = await docxReadTool.execute(
          {
            filePath: targetDocx,
            fullText: true,
          },
          context,
        )
        expect(readResult4).toContain('[Table] (3 rows)')

        // Step 8: 底层引擎直接进行二进制物理校验 (Dual-Verification)
        const finalBuffer = await fs.readFile(absoluteTargetDocx)
        const parsedDoc = await parseDocx(finalBuffer)
        const visible = parsedDoc.blocks.filter((b) => !b.hidden)

        expect(visible.length).toBe(7) // 5 blocks + 1 table + 1 trailing paragraph
        expect(visible[5].type).toBe('table')

        // Step 9: 负向测试 (Fail-Closed Robustness)
        // 9.1 读取不存在的文件必须直接抛出异常
        await expect(
          docxReadTool.execute({ filePath: 'non-existent-doc.docx' }, context),
        ).rejects.toThrow('Failed to read docx file')

        // 9.2 向不存在的文件追加内容必须直接抛出异常
        await expect(
          docxAppendContentTool.execute(
            { filePath: 'non-existent-doc.docx', items: [{ type: 'paragraph', text: 'test' }] },
            context,
          ),
        ).rejects.toThrow()

        // 9.3 修改越界的 blockIndex 必须直接抛出越界异常
        await expect(
          docxModifyBlockTool.execute(
            { filePath: targetDocx, blockIndex: 9999, text: '越界修改' },
            context,
          ),
        ).rejects.toThrow('Block index 9999 is out of bounds')
      } finally {
        // 清理临时文件沙箱
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
