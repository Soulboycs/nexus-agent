# 契约：Microsoft Word P1 对齐批次（第三轮）

> 任务族：ROUND2 差距矩阵复核后的剩余 P1 修复。基于 2026-09-19 代码级复核：
> 原 30 项中 7 项已修复但文档未更新（下划线/字符缩放/裁剪/简单标记/tblLook/题注/查找^p），
> 目录三项能力（更新整个目录 `updateTocField`、`data-toc-anchor` 书签锚点匹配、Ctrl+点击跳转 `onDocClick`）也已实现。
> 本批次处理剩余三项可闭环 P1。

## T1 STYLEREF 动态页眉（ROUND2 #8）

**用户可观察行为**：页眉含 `STYLEREF "Heading 1"` 域的文档，修改某章标题后，各页页眉显示该页所属章节的最新标题文字，不再是打开文件时的陈旧缓存。

**非目标**：正文内 STYLEREF 域；除 heading 1-9 / 标题 1-9 之外的样式名解析（显示为空并在 UI 提示）。

**契约**：
1. 引擎 `parse.ts`：header/footer 部件中的 STYLEREF 域（fldChar span 与 fldSimple 两种形态）解析为 `STYLEREF_MARK`（\uE002），**丢弃陈旧缓存结果**，样式名按出现顺序记入 `HfPartInfo.styleRefs: string[]`。
2. 引擎 `patch.ts`：保存时 paras 中第 N 个 STYLEREF_MARK 写回为完整的 `STYLEREF "styleRefs[N]"` 域 span（begin/instrText/separate/缓存文本/end）。
3. 渲染：`HeaderFooterArea` 以 Word 语义解析替换：当前页首次出现 → 之前最近 → 之后首个；无法解析为 heading 级别时显示空串。
4. 编辑回环：`hf-text.ts` 将 STYLEREF_MARK 显示为 `{STYLEREF}` 令牌并可无损改回。

**测试**：`tests/docx/styleref-dynamic-header.test.ts`
- 夹具 docx（header 含 STYLEREF 域+陈旧缓存 "Old Chapter"）→ parse → `text` 含 MARK、`styleRefs=['Heading 1']`、陈旧文字不残留；
- `headerFooterPartXml` 回写含 `STYLEREF "Heading 1"` 域 span 与 separate/end 配对；
- `stylerefText()` 三段语义（页上首个/页前最近/页后首个/未知样式→''）；
- hfEditText/applyHfText 令牌往返不丢失。

## T3 版面属性撤销（ROUND2 #3）

**用户可观察行为**：调整页边距/纸张方向/分节设置后按 Ctrl+Z，恢复先前版面且**不撤销正文文字**；Ctrl+Y 可重做版面。

**非目标**：与 PM 历史的严格全局统一栈（文档化限制：版面变更后输入文字，则 Ctrl+Z 先撤文字——与 Word 时序一致；仅"版面为最后一动作"时拦截）。插入分节符（本身经 PM 事务）不在本契约内。

**契约**：
1. 纯模块 `editor/layout-history.ts`：`LayoutHistory` 快照栈（undo/redo），`nextUndoAction(lastAction, canUndo)` 决策表（'layout' | 'pm'）。
2. App：`onSection`（对话框）与 `aiPageSetupAccess.set`（AI 改版面）在变更前推入快照（section/sections/sectionDirty/sectionsDirty/pgNumEdit/pgNumDirtySections/titlePg/titlePgDirty）。
3. 捕获阶段 keydown 拦截：lastAction==='layout' 且栈非空 → 恢复快照并吞掉事件；否则放行给 PM 历史。Redo 对称。
4. PM `docChanged` 事务将 lastAction 置回 'doc'。

**测试**：`tests/docx/layout-undo.test.ts` — 决策表全分支；快照推入/撤销/重做序列；恢复值与快照逐字段一致。

## T4 保存压缩迁出渲染进程（ROUND2 #12）

**用户可观察行为**：大文档（含大量图片）保存时 UI 不再冻结；打字不丢键。

**契约**：
1. 主进程 `docxIpc.ts` 注册 `docs:zip-save`：接收 `{parsed, finalBlocks, options}`（结构化克隆），调引擎 `saveDocx`，返回 Uint8Array。
2. preload 暴露 `zipSave`；渲染端 `file-actions.ts` 优先走 IPC，异常/缺失时回退本地 `saveDocx`（测试环境兼容）。
3. 字节等价：同一输入下 IPC 路径与本地路径产出 docx 字节一致（zip 条目级比对，排除时间戳波动条目）。

**测试**：`tests/docx/zip-save-ipc.test.ts` — handler 注册断言（沿用 export-and-ribbon 模式）；主进程处理函数对真实夹具产出与本地 saveDocx 逐条目一致；渲染端回退逻辑。

## 门禁

- `bun test tests/docx` 全绿（含新增 3 个文件）；`npm run typecheck:node && npm run typecheck:web` 0 error。
- 文档收口：进度.md 新批次、证据链.md 命令与输出、测试矩阵.md 新增行、Word深度差距分析-第二轮.md 矩阵状态刷新（含本批复核发现的 8 项已修复标注）。

---

## B 轮（2026-09-20）：边界收尾与剩余 P1

### B1 STYLEREF 任意样式名（解除 heading 1-9 限制）
- 解析目标改为"样式名归一匹配"：查询与候选段落样式名做大小写/空白归一，`heading N` 与 `标题 N` 互为别名；任意样式名（如 Title、自定义样式）按同规则匹配。
- 数据源：PM 顶层节点 `styleId` → `parsed.styles` 取样式名；页码沿用分页映射。
- 验收：`stylerefText` 对非 heading 样式命中正确段落；heading 别名（中英文）等价。

### B2 版面撤销升级为真·统一栈
- 方案：版面快照镜像为 PM **doc 属性**（`layoutUndo`），布局变更 dispatch `tr.setDocAttribute` 进入 ProseMirror History；插件监听 doc 属性变化回写 React 状态。撤销/重做由 PM History 统一时序，删除 window keydown 拦截与 lastAction 路由。
- 验收：真实 Tiptap 编辑器测试——布局变更 → `editor.commands.undo()` 属性回滚并回调旧快照；redo 对称；打字与布局交替按时间序撤销。

### B3 zip-save 克隆链路验证
- Electron IPC 序列化即 structuredClone：测试对真实 `parseDocx` 产物 + SaveBlocks + options 整体 `structuredClone`，克隆体经 `saveDocx` 产出与原对象逐条目一致；含函数/不可克隆字段的探测为负例边界。
- 真机 Electron 冒烟为非目标（无既有 e2e 基建），以 structuredClone 等价 + 回退兜底作为证据边界并如实记录。

### B4 词级对比生成修订 DOCX
- `editor/compare-docx.ts`：token 化（CJK 单字 + 西文词）→ 词级 LCS → equal/del/ins 片段；段落对齐沿用 `compareParagraphs`；changed 段落词级标记、removed 整段 del、added 整段 ins，经 `generateParagraphXml`（Run.ins/del）产出 xml SaveBlock，same 段落保 `original` 字节。
- UI：ComparePanel 新增"导出对比文档"，走 `zipDocxBytes` → save-as。
- 验收：合并产物解包含 `<w:ins>`/`<w:del>`/`<w:delText>`；same 段落与原文档字节一致；Word 可逐条接受/拒绝。

### B5 打印预览虚拟化（scoped）
- 画布（contenteditable PM）全量虚拟化为**架构级非目标**：PM 依赖全量 DOM，窗口化会破坏选择/输入/测量，需引擎级重写，本轮不做、如实记录。
- Scoped 交付：PaginationPreview 页卡片为定高容器，加 `content-visibility: auto` + `contain-intrinsic-size`（页高已知），离屏页跳过渲染。

### B6 布局抖动：可度量削减
- 先建基准：对真实 100+ 页论文执行分页测量计时（happy-dom 指示性数据，如实标注不代表真机帧率）。
- 交付：消除最热路径中对同一元素的重复 `getBoundingClientRect` 读（pass 内复用），以基准前后对比为证；不做全量两阶段重写（回归风险>收益，如实记录）。

---

## C 轮（2026-09-20）：ROUND2 剩余 P2 攻坚

### C1 表格排序（ROUND2 #20，激活硬禁用按钮）
- 纯模块 `editor/table-sort.ts`：`collectSortableRows`（docTable 下 docTableRow 行集合，docTableHeader 首行默认钉住）+ `sortTableKeys`（列键提取：纯数字列数值比较——剥离千分位/货币符/百分号；否则 `localeCompare` zh 排序）+ `sortTableByColumn(editor, {col, asc, hasHeader})`（单事务重排行节点 = 单步撤销）。
- UI：Ribbon 段落组排序按钮启用（有文档可编辑即可点）；无光标表格时状态栏提示；光标在表格 → `TableSortModal`（列下拉取表头文字或"列 N"、升/降序、标题行开关自动检测）。
- 验收：键提取/比较全分支单测；真实编辑器上排序后行序正确、表头未动、单步 Ctrl+Z 可整表还原；保存管线复用既有 pmTableToModel（结构变化自动重生成 XML，无需新代码——集成测试验证）。

### C2 分栏中缝分隔线（ROUND2 #22）
- 引擎：`SectionSettings.colSep?: boolean`；`readSectionSettings` 解析 `w:cols w:sep`（w:val="0" 为关）；`applySectionSettings` 仅在提供且与现值不同时增删 `w:sep="1"`（round-trip 安全）。
- 渲染：App 内联分栏 CSS 追加 `column-rule`；html-export 同步导出；布局选项卡分栏下拉新增"分隔线"开关（columns>1 时显示）。
- 验收：解析/序列化 round-trip 单测（含 0 值与缺省）；CSS 契约测试；导出包含 column-rule。

### C3 中西文间距双开关 autoSpaceDE/DN（ROUND2 #16）
- 引擎：`ParaFormat.autoSpaceDE/autoSpaceDN?: boolean`（undefined = 默认开）；`autoSpaceOf` 返回分离两值；`generate` 在显式 false 时序列化 `w:autoSpaceDE/DN w:val="0"`（开状态省略，round-trip 安全）。
- 渲染：PM 段落属性拆为 `autoSpaceDE/autoSpaceDN: boolean|null`（convert 双向映射，兼容旧 `autoSpace`）；`needsAutospacePad` 拆分字母（DE）与数字（DN）边界；Ribbon 继承列表、inherit-formatting、caret-marks 同步更新。
- UI：段落对话框"中文版式"两个复选框（默认勾选）。
- 验收：引擎 round-trip（仅关 DN 的文档不再被压平）；边界函数真值表（de 关/dn 关/双开）；convert 映射测试。

### C4 表格公式求值器（ROUND2 #19 基础层）
- 引擎纯模块 `table-formula.ts`：`evaluateTableFormula(instr, grid)` 支持 `=SUM/AVERAGE/COUNT/MAX/MIN(ABOVE|BELOW|LEFT|RIGHT)`、单元格引用（A1）、范围（A1:A3）、四则与括号、数字格式掩码（#,##0.00 / 0.00 / 0%）。
- 编辑器：表格右键菜单"重算公式"——遍历表格单元格，文本以 `=` 开头的公式取当前网格求值并写回结果（用户输入 =SUM(ABOVE) → 右键重算 → 数值）。
- 明确边界：导入文档中 Word 已缓存的 fldSimple 公式保持缓存显示（不重解析原始域 XML）；不自动随编辑重算（Word F9 语义的手动对应）。
- 验收：求值器全分支单测（方向语义含跳过非数字、范围引用、算术优先级、格式掩码、除零/空集错误）；真实表格节点重算集成测试。

### C5（弹性，视进度）审阅者过滤：跳过，留待下轮（UI 面积大，四项先行）。

---

## D 轮（2026-09-20）：剩余 P2 第三批

### D1 审阅者过滤（ROUND2 #15）
- 纯函数 `distinctRevisionAuthors(doc)`（collectRevisions 去重保序）。
- UI：审阅选项卡"接受/拒绝"下拉内新增作者多选列表（默认全选）；应用时仅作用于勾选作者（复用 `applyRevisionsBy` 的过滤语义，扩展为集合）。
- 显示过滤：勾选集合非全量时 App 生成 CSS 隐藏未勾选作者的 `.doc-ins/.doc-del` 标记视觉（正文内容不动，Word"特定人员"显示语义）。
- 验收：作者去重、按集合接受/拒绝（真实编辑器 + ins/del 标记）、显示过滤 CSS 契约。

### D2 单元格九宫格对齐（ROUND2 #18）
- 纯模块 `editor/cell-nine-align.ts`：`setCellNineAlign(editor, {v, h})` 单事务：选中单元格 vAlign 属性 + 单元格内全部段落 align 属性（多格选择全应用；v='top' 写 null 保 round-trip）。
- UI：表格工具对齐组新增 3×3 九宫格弹出（Word 布局工具卡样式），保留原两排按钮。
- 验收：单格/多格真实编辑器测试（vAlign 与段落 align 同步、null round-trip、单撤销步）。

### D3 标尺公制切换 + 垂直标尺（ROUND2 #23）
- 纯函数 `rulerTicks(pageWidthTwips, unit)`（inch=1440 步进整英寸；cm=567 步进整厘米，标签换算）+ `twipsToUnitText(twips, unit)`。
- 水平标尺：左端单位切换按钮（inch/cm，localStorage 记忆 `nexus.ruler.unit`），刻度与制表位提示按单位换算。
- 垂直标尺：`VRuler` 组件贴编辑区左侧：上下边距区 + 拖拽手柄（marginTop/marginBottom，走既有版面镜像撤销路径），页高按 section 计算。
- 验收：刻度/换算纯函数真值表、DOM 结构契约、垂直拖拽纯增量计算。

### D4（弹性）：审阅者过滤的显示过滤若与修订视图模式（simple/all/none）冲突，以显示模式优先，过滤仅作用于 'all' 模式。
