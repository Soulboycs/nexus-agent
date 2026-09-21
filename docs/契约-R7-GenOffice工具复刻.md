# 契约 R7：GenOffice Word 工具体系 1:1 复刻融入主进程 Agent

- 批次：R7（承接 R4-R6 工具目录对齐系列）
- 日期：2026-09-21
- 上游参照源：`D:\genoffice`（apps/docs/src/renderer/ai 为语义基准）
- 基线证据：docs/证据链.md 证据条目 27

## 1. 用户可观察行为

1. 主进程 agent 工具注册表新增 33 个 `docx_*` 工具（GenOffice 34 工具中，web_search 映射到既有 WebSearch 不重复注册，create_document 融入既有 docx_create），参数 schema、返回文本、错误信息与 GenOffice 渲染层 `AGENT_TOOLS`（`src/renderer/src/components/word/ai/tools.ts`）语义 1:1。
2. 双执行模式，自动路由：
   - **live**：目标文件已在 Word 画布打开 → 经 `docs:mcp-command` 桥驱动渲染层 `executeTool`（用户可旁观）。
   - **headless**：未打开 → 主进程 jsdom + 无头 Tiptap editor 加载同一 `word/ai/` 模块组执行（参照 GenOffice packages/cli/src/formats/docx.ts 路线），编辑后保存回磁盘。
3. `docx_apply_ops` op 目录升级为 GenOffice 全量 23 op（含 insertField/insertBookmark/updateFields/8 个表格 op/applyStyle）。
4. 系统提示词含 GenOffice 完整协议：HTML_RULES（受限 HTML 白名单）、OPS_GUIDE（从 `ops.ts opSignatures()` 动态生成，零漂移）、评论逐条流程、模板填充、域、docnav://block/N 引用。

## 2. 非目标

- 不修改渲染层 `word/ai/` 的工具语义（与上游 diff 保持 3 文件 lint 级差异基线；如 headless 需 i18n 注入改造，改动须最小化并记录于上游 diff 基线）。
- 不实现 GenOffice 的 MCP 服务器 surface（apps/shell）、CLI surface（packages/cli）、skill 文件（skills/genoffice）——本仓库主进程 AgentTool 层即对应物。
- 不触碰并行 WIP 在途文件（src/main/index.ts、commandTool.ts、globGrepTools.ts、FindPanel.tsx、workspace/layout 系列等）的既有修改内容。
- 不做 sheets/slides/pdf 家族。

## 3. 命名映射表（GenOffice 原名 → 本仓库工具名）

| GenOffice | 本仓库 | 旧工具处置 |
|---|---|---|
| get_document_context | docx_get_context | docx_read → 别名 |
| read_blocks | docx_read_blocks | — |
| insert_content | docx_insert_content | docx_append_content → 别名 |
| write_document | docx_write_document | — |
| replace_blocks | docx_replace_blocks | docx_modify_block → 别名 |
| replace_selection | docx_replace_selection | — |
| apply_ops | docx_apply_ops（复用名） | 语义升级（op 目录 5→23） |
| read_revisions | docx_read_revisions（复用名） | 输出对齐 GenOffice |
| accept_changes | docx_accept_changes | docx_accept_revisions → 别名（升级为五维选择器） |
| reject_changes | docx_reject_changes | docx_reject_revisions → 别名 |
| read_comments | docx_read_comments | — |
| reply_comment | docx_reply_comment | — |
| resolve_comment | docx_resolve_comment | — |
| add_comment | docx_add_comment | — |
| delete_comment | docx_delete_comment | — |
| insert_footnote | docx_insert_footnote | — |
| insert_endnote | docx_insert_endnote | — |
| delete_note | docx_delete_note | — |
| read_notes | docx_read_notes | — |
| web_search | （不注册；系统提示说明用 WebSearch） | — |
| image_search | docx_image_search | — |
| insert_image | docx_insert_image | — |
| generate_image | docx_generate_image | — |
| insert_chart | docx_insert_chart | — |
| edit_chart | docx_edit_chart | — |
| set_header_footer | docx_set_header_footer | — |
| set_page_setup | docx_set_page_setup | — |
| insert_section_break | docx_insert_section_break | — |
| define_style | docx_define_style | — |
| list_styles | docx_list_styles | — |
| set_watermark | docx_set_watermark | — |
| insert_text_box | docx_insert_text_box | — |
| insert_picture | docx_insert_picture | — |
| create_document | 融入 docx_create（参数对齐 type/title/content） | 保留名 |

旧工具别名化后独立实现删除（docx_insert_table → docx_insert_content 带 table HTML；docx_delete_block → docx_apply_ops deleteBlocks）。别名走 ToolRegistry 既有 alias 机制，零破坏。

## 4. 有意偏差（与 GenOffice 的唯一结构性差异）

- **filePath 首参**：GenOffice 工具绑定"当前文档"（无路径参数）；本仓库 agent 面向磁盘文件，每个新工具 schema 增加 `filePath`（必填，相对/绝对）首参，执行前经 resolvePath 归一化。headless 模式下 `insert_content`/`insert_chart` 无 afterBlockIndex 时语义为"追加文档末尾"（GenOffice CLI 同款 headless 缺省，见 formats/docx.ts:540-563），而非 live 模式的"光标块之后"。
- **图片源放宽**：docx_insert_image / docx_insert_picture / docx_set_watermark(image) 的 url 参数 headless 模式额外接受本地路径（GenOffice CLI 同款）。

## 5. 正常与负面路径（测试边界）

正常路径（每工具至少 1 例）：
- 读类返回 GenOffice 同构文本（块列表 index|type|preview、HTML 分页、修订/批注/脚注清单格式）。
- 写类 live 与 headless 各至少 1 例真实往返（fixture .docx 打开→改→存→parseDocx 重读断言）。
- headless insert_content 缺省 afterBlockIndex = 追加末尾。
- 别名解析：docx_read → docx_get_context 同一工具对象。

负面路径（每工具至少 1 例）：
- 越界块索引 → GenOffice 原文错误信息（"block index invalid or out of range… call get_document_context"）。
- 坏 HTML（裸 JSON / `</tool_response>` 回声 / `<sel>` 标记）→ toolEchoError 拒绝。
- 未知 id（comment/note/revision/styleId/bookmark）→ 报错并提示 read_* 获取现行 id。
- accept/reject_changes 非法选择器组合。
- dryRun=true 不落盘。

## 6. 测试命令与门禁

- `bun test tests/` → 0 fail（基线 755 pass / 1 skip）。
- `npx vitest run` → 0 fail（基线 63 pass）。
- `npm run typecheck` → 零新增可归因 R7 文件的错误（基线 6 错固定于并行 WIP 文件，见证据条目 27）。
- 新增测试文件：`tests/r7WordTools.test.ts`（工具注册/schema 契约/别名/负面参数）、`tests/docx/headless-roundtrip.test.ts`（无头全链路真实 fixture 往返）、mcp-bridge 命令面快照测试（vitest DOM 或 bun，按依赖环境定）。
- 硬性失败阈值：任何新增测试 0 fail；headless 往返中 parseDocx 重读断言必须验证落盘字节真实变化（防假写）。

## 7. 已知限制

- live 桥 write_document 流式长任务：第一期 live 超时按 docsBridge 现有 60s/命令，超长写作建议 headless；如实际失败记录为已知限制。
- generate_image 依赖图像 provider 配置，未配置时工具描述动态降级（参照渲染层 docs-skill.ts:58-62）。
- jsdom 打包体积：仅主进程动态 import，不进 renderer bundle。

## 8. 回滚与补偿

- 全部新增代码集中于：`src/main/agent/tools/wordTools.ts`（新）、`src/main/docx/headless/`（新目录）、`src/main/docx/docsBridge.ts`（命令白名单扩展）、`src/renderer/src/components/word/mcp-bridge.ts`（命令分支扩展）、`src/renderer/src/components/word/shared/ipc.ts`（类型扩展）、`src/main/agent/index.ts`（注册行）、`src/main/agent/permissions/PermissionEngine.ts`（名单）。
- 回滚 = revert 上述文件 + 移除测试。旧 docx_* 工具经别名机制保持可用，别名化不破坏现有调用方。

## 9. 切片顺序与依赖

R7-A 桥接层命令面（先行，独立可测）→ R7-B Spike 0 探针 → R7-B headless 引擎 → R7-C 主进程注册 → R7-D 云/异步 → R7-E 系统提示词 → R7-F 收口。R7-C 依赖 R7-A+R7-B；R7-E 依赖 R7-C（OPS_GUIDE 动态生成需 headless docsModules）。
