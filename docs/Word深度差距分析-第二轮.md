# 第二轮深度地毯式代码审查报告：Word 编辑器与底层 DOCX 引擎对比 Microsoft Word 桌面版

> **审查说明**：本次审查排除了已攻坚解决的 Top 5 P0 缺陷（页面边框无损保留、斜线表头 tl2br/tr2bl、交叉引用面板扩充、右键拼写建议列表、脚注每页重新编号 eachPage 切片对齐）。针对剩余的未做到、存在差距、或相比正式 Word 缺失/不完善的功能，从 8 个高维场景展开了深度源码级排查与对比分析。

---

## ⚠️ 状态刷新（2026-09-19 第三轮复核，取代下文对应条目的"现状"描述）

对下文 30 项矩阵逐条做了**当前代码级复核**：11 项已在先前批次修复但本文未更新，3 项在本批次（契约-MSWord-P1批次.md）修复。原分析保留如下作为历史证据，**以本表为准**：

| 原序号 | 条目 | 当前状态 | 代码/测试证据 |
| :--- | :--- | :--- | :--- |
| #1 简单标记 | **已修复（先前批次）** | `ribbon-tabs.tsx:635` `RevisionDisplayMode` 含 `'simple'`；`tests/docx/simple-markup-mode.test.ts` |
| #2 词级对比 | **已修复（B 轮 2026-09-20）** | `editor/compare-docx.ts` 词级 LCS + Run.ins/del 修订导出 + ComparePanel 导出按钮；`tests/docx/compare-revision-export.test.ts` 4/4 |
| #3 版面撤销 | **已修复（A 轮）并升级（B 轮）** | B 轮升级为 PM doc-attr 镜像真统一栈（`layout-undo-extension.ts`），打字与版面按时间序交织撤销；`tests/docx/layout-undo.test.ts` 4/4 |
| #4 字符缩放 | **数据保真已修（先前批次）；UI 面板未闭环 → 第三轮 B1** | `convert.ts:3060` 回写；`tests/docx/char-scale-fidelity.test.ts`；字体对话框高级页（缩放/间距）无入口 |
| #5 下划线线型 | **数据保真已修（先前批次）；UI 线型下拉未闭环 → 第三轮 B2** | `types.ts` underline 多值 + generate 按值序列化；`tests/docx/rich-underline-fidelity.test.ts`；Ribbon 仅单线开关 |
| #6 题注只读 | **已修复（先前批次）** | `ribbon-references-tab.tsx` CaptionModal 插入普通文本 + `instrField` SEQ 域；`tests/docx/caption-editable.test.ts` |
| #7 目录更新 | **已修复（先前批次，三能力俱全）** | 重建：`updateTocField`（Ribbon 按钮）；书签锚点匹配：`data-toc-anchor` + `hiddenBookmarks`（App.tsx TOC 回填）；Ctrl+点击跳转：`onDocClick` 锚点→标题双路径 |
| #8 STYLEREF | **已修复（A 轮）并解除限制（B 轮）** | 引擎 `STYLEREF_MARK`(\uE002) + `styleRefs` 解析/写回；B 轮起任意样式名归一匹配（heading/标题别名）；`tests/docx/styleref-dynamic-header.test.ts` 6/6 |
| #8b 题注 SEQ 章节号 | **未闭环（F 轮拆分入册 → 第三轮 B11）** | generate 仍仅输出 SEQ label ARABIC，无章节号联动；题注位置（上/下）同样缺失 |
| #9 图片裁剪 | **已修复（先前批次）** | `PictureDialogs.tsx` 非破坏性相对坐标 `{l,t,r,b}`；`patch.ts` 仅换图（retarget）场景清 `srcRect`；`tests/docx/image-crop-non-destructive.test.ts` |
| #10 tblLook | **已修复（先前批次）** | `types.ts:1241` `TableLook` + `table-properties.ts:154` 开关切换 |
| #11 查找替换 | **已修复（先前批次）** | `^p`/`^t` 等特殊标记 + `useWildcards` 通配符（`parseWordSearchPattern`）；`tests/docx/find-replace-special-tokens.test.ts` |
| #12 保存卡顿 | **已修复（A 轮）并证实克隆链（B 轮）** | `docs:zip-save` IPC 主进程压缩；B 轮 structuredClone 等价测试证实 Electron 序列化链；`tests/docx/zip-save-ipc.test.ts` 6/6 |
| #13 布局抖动 | **部分缓解（B 轮再削减）** | `getBoundingClientRect` 约 37 处；B 轮将测量热点 `gapAbove` 从 O(G) 扫描改为 O(log G) 二分（`gapAccumulator`，20k 查询等价验证）；循环内读写交织的两阶段重写仍为后续项 |
| #14 虚拟化 | **scoped 交付（B 轮）** | 打印预览页卡片 `content-visibility:auto` 虚拟化（定高卡片 + 打印强制渲染）；画布 contenteditable 全量虚拟化为架构级非目标（PM 依赖全量 DOM） |
| #16 中西文间距 | **已修复（C 轮 2026-09-20）** | `ParaFormat.autoSpaceDE/DN` 独立开关、仅 off 序列化、DE/DN 分离边界渲染 + 段落对话框双复选框；`tests/docx/autospace-flags.test.ts` 5/5 |
| #19 表格公式 | **基础层已落地（C 轮 2026-09-20）** | `table-formula.ts` 方向/引用/范围/算术/掩码求值器 + 右键"重算公式"（手动 F9 对应）；fldSimple 导入缓存与自动重算为后续；`tests/docx/table-formula.test.ts` 7/7 |
| #20 表格排序 | **已修复（C 轮 2026-09-20）** | `table-sort.ts` 数字感知列键 + 表头钉住 + 单事务排序，Ribbon 按钮启用 + TableSortModal；`tests/docx/table-sort.test.ts` 7/7 |
| #22 分栏分隔线 | **已修复（C 轮 2026-09-20）** | `colSep` 解析/序列化 round-trip + 画布 column-rule + HTML 导出 + 分栏下拉开关；`tests/docx/column-separator.test.ts` 4/4 |
| #15 审阅者过滤 | **已修复（D 轮 2026-09-20）** | 接受/拒绝下拉作者多选清单 + 集合过滤 `revisionsOfAuthors` + 显示过滤 CSS（仅 all 模式）；`tests/docx/reviewer-filter.test.ts` 3/3 |
| #18 九宫格 | **已修复（D 轮 2026-09-20）** | `cell-nine-align.ts` vAlign+段落 align 单事务原子设置 + 3×3 弹出；`tests/docx/cell-nine-align.test.ts` 3/3 |
| #23 标尺 | **已修复（D 轮 2026-09-20）** | inch/cm 单位切换（记忆）+ 刻度/制表位提示按单位 + 新增垂直标尺（边距拖拽走统一撤销栈）；`tests/docx/ruler-units.test.ts` 5/5 |
| #17 首字下沉 | **复核证伪 + 导出缺口已修（E 轮 2026-09-20）** | 分页截断断言不成立（`::first-letter` 浮动参与布局、画布为 DOM 实测）；真实缺口为 HTML 导出丢伪元素样式，已附 `DROP_CAP_EXPORT_CSS` + 保留 `data-drop-cap`；`tests/docx/e-batch-contracts.test.ts` |
| #26 小彩虹 | **已修复（E 轮）；选项集边界（F 轮入册）** | ImageWrapPopover 复用同一 WRAP_OPTIONS 与写入路径；边界：缺紧密型/穿越型（渲染无文字轮廓避让），四周型拆左右两变体 |
| #28 格式查找替换 | **已修复（E 轮 2026-09-20）** | `format-find.ts` 格式真值表/范围收集/批量重样式 + FindPanel 格式弹层（查找/替换为两行）；`tests/docx/format-find.test.ts` 5/5 |
| #21 浮动表格 / #24 样式窗格 / #25 导航窗格 / #27 形状组合 / #29 文字效果（倒影/3D）/ #30 SmartArt | **仍开放** | 另有第三轮入册的 A 组 19 项 + B 组 24 项残缺，见 docs/Word深度差距分析-第三轮.md |

---

## 目录
1. [场景 1：字体与西文/中文精细排版 (Typography & Micro-Typography)](#1-字体与西文中文字体精细排版)
2. [场景 2：表格高级排版与样式 (Advanced Table System)](#2-表格高级排版与样式)
3. [场景 3：学术与长文档自动化体系 (Long Document Automation)](#3-学术与长文档自动化体系)
4. [场景 4：图形、图片与多媒体交互 (Graphics & Media)](#4-图形图片与多媒体交互)
5. [场景 5：审阅、修订与法务对比 (Review, Revisions & Legal Tools)](#5-审阅修订与法务对比)
6. [场景 6：排版工具与版面交互 (Layout Ergonomics)](#6-排版工具与版面交互)
7. [场景 7：查找、替换与批量排版 (Find, Replace & Batch Format)](#7-查找替换与批量排版)
8. [场景 8：大文档性能与架构瓶颈 (Large Document Architecture)](#8-大文档性能与架构瓶颈)
9. [全量缺陷优先级汇总矩阵 (P1 / P2 / P3)](#全量缺陷优先级汇总矩阵)
10. [下一阶段攻坚路线图推荐 (Phased Roadmap)](#下一阶段攻坚路线图推荐)

---

### 1. 字体与西文/中文精细排版

#### 1.1 中西文自动微间隙 (`w:autoSpaceDE` / `w:autoSpaceDN`)
* **代码证据**：
  - `src/packages/docx-engine/parse-props.ts:278-284` (`autoSpaceOf`)
  - `src/packages/docx-engine/generate.ts:1119-1120` (`PPR_CHILD_ORDER`)
  - `src/renderer/src/components/word/line-metrics.ts:1519-1580` (`needsAutospacePad`, `autospaceBoundaries`)
  - `src/renderer/src/components/word/editor/extensions.ts:1655-1778` (`autospaceRanges`)
* **Word 原生表现**：
  Word 段落设置 -> 中文版式中，提供两个独立开关：
  1. “中文与西文之间自动调整间距” (`w:autoSpaceDE`)
  2. “中文与数字之间自动调整间距” (`w:autoSpaceDN`)
  两者默认均为开启，间距量约为 1/4em，且用户可针对特定公文规程单独关闭其中一项（例如部分政府公文要求中文与数字之间不留间隙）。
* **当前实现差距**：
  1. **解析数据降维丢失**：在 `parse-props.ts` 中，`autoSpaceOf` 将两者强行压平为单个布尔值 `autoSpace`：`if (de === false && dn === false) return false; if (de === true || dn === true) return true;`。若文档只关闭了 `autoSpaceDN` 而保留了 `autoSpaceDE`，状态直接被覆盖为 `true`。
  2. **序列化彻底遗漏**：`generate.ts` 虽然在 `PPR_CHILD_ORDER` 中列出了标签名，但在写回 XML 的生成逻辑中，根本没有序列化 `w:autoSpaceDE`/`w:autoSpaceDN` 的分支，段落保存时该属性完全丢弃！
  3. **UI 配置缺失**：段落右键设置或功能区均无“中文版式”独立设置对话框。
* **优先级**：**P2**

#### 1.2 字符间距扩展/紧缩 (`w:spacing`) 与字符缩放 (`w:w`)
* **代码证据**：
  - `src/renderer/src/components/word/editor/convert.ts:1516-1531, 3026`
  - `src/packages/docx-engine/generate.ts:2699-2700`
  - `src/renderer/src/components/word/editor/text-effects.ts:68-94` (`charScaleXDecls`)
  - `src/renderer/src/components/word/components/Ribbon.tsx:1686`
* **Word 原生表现**：
  Word “字体 -> 高级”对话框提供：
  1. 字符间距：标准、加宽、紧缩（精确到 0.05 磅）
  2. 字符缩放：200%、150%、100%、90%、80%、66%、50% 或自定义百分比（通过横向压缩/拉伸字形轮廓，而非单纯调字符间距）。
* **当前实现差距**：
  1. **保存严重断链（数据丢失）**：在 `convert.ts:3026` 中，从 ProseMirror Mark 回写到底层 `Run` 时，读取了 `mark.attrs.charSpacingTwips`，**但根本没有回写 `run.charScalePct`**！导致用户在编辑器中设置或包含 `w:w` 缩放的文档，保存后再打开比例彻底重置为 100%！
  2. **渲染降级变形**：`convert.ts:1516` 规定若文本包含空格、下划线、中划线，则放弃 CSS `transform: scaleX(...)`，直接退化为 `letter-spacing`，导致字形并未被横向拉伸，排版与 Word 严重不符。
  3. **交互面板缺失**：Ribbon 仅在计算格式时浅读 `charSpacingTwips`，无任何 UI 弹窗供用户手动调整字符缩放与微调间距磅值。
* **优先级**：**P1**

#### 1.3 下划线丰富线型（双线、虚线、点线、波浪线、字下加点）
* **代码证据**：
  - `src/packages/docx-engine/types.ts:50` (`underline?: boolean`)
  - `src/packages/docx-engine/xml-utils.ts:90-94` (`underlineProp`)
  - `src/packages/docx-engine/generate.ts:2706, 2741` (`<w:u w:val="single"/>`)
  - `src/renderer/src/components/word/editor/marks.ts:74-88`
* **Word 原生表现**：
  Word 下划线下拉框提供 16+ 种线型（双下划线 `double`、粗线 `thick`、点线 `dotted`、虚线 `dash`、波浪线 `wave`、双波浪线 `wavyDouble` 等），支持独立下划线颜色（`w:u w:color="FF0000"`），并支持东亚着重号（`w:em w:val="dot"` 字下加点）。
* **当前实现差距**：
  1. **类型强行抹平为布尔值**：`docx-engine` 底层将 `underline` 字段硬性定义为 `boolean`！解析时只要不是 `none`，一律变成 `true`。
  2. **保存破坏性覆盖**：在 `generate.ts:2706, 2741` 中，凡是带下划线的 Run，一律硬编码写回 `<w:u w:val="single"/>`！正式公文或法务合同中的双下划线、波浪线文档只要被该编辑器打开并保存一次，所有高级线型全部被降级破坏为普通单线！
  3. **下划线颜色丢失**：Word 中红字配黑下划线或黑字配红下划线的属性全部被丢弃。
* **优先级**：**P1**

#### 1.4 首字下沉（Drop Cap / `w:framePr w:dropCap="drop"`）
* **代码证据**：
  - `src/renderer/src/components/word/editor/decoration-extensions.ts:876-920`
  - `src/renderer/src/components/word/styles.css:2549-2566`
  - `src/renderer/src/components/word/pagination-lines.ts`, `pagination-slices.ts`
* **Word 原生表现**：
  Word 首字下沉通过图文框（Frame）实现，首字作为独立的文本载体，可独立设置字体（如花体/衬线体）、下沉行数（默认 3 行，可调 2~10 行）、距正文距离。
* **当前实现差距**：
  1. **前端使用 CSS 伪元素 `::first-letter` 渲染**：`has-drop-cap::first-letter { float: left; font-size: 3em; }`。用户在富文本编辑器内无法直接高亮选中首字以单独换颜色、换字体，且首字符如果为引号（如““）时排版崩溃。
  2. **分页引擎完全脱节**：`pagination-lines.ts` 和 `pagination-slices.ts` 在测量切片高度时，从未考虑 `dropCap` 占用的行高下沉与浮动空间，若首字下沉段落临近页尾，会发生灾难性的分页截断重叠。
* **优先级**：**P2**

#### 1.5 文字效果（阴影、发光、倒影、3D）
* **代码证据**：
  - `src/renderer/src/components/word/editor/text-effects.ts:1-95`
* **Word 原生表现**：
  Word 桌面版（Word 2010+ 至今）具有完备的 DrawingML 文字艺术效果体系：
  - 外部/内部/透视阴影（模糊度、角度、距离、透明度）
  - 倒影（紧密/半倒影/全倒影，带渐变羽化）
  - 发光（发光半径、颜色、透明度）
  - 3D 旋转与棱台效果
* **当前实现差距**：
  1. 倒影（Reflection）与 3D（Bevel, 3D Rotation）：底层 OOXML 标签（`w14:reflection`, `w14:scene3d`）完全未解析、无 CSS 渲染实现、无生成能力。
  2. 阴影停留在 20 年前的 Word 2003 静态阴影：`text-effects.ts:23` 写死为 `text-shadow: 1px 1px 0 var(--docs-paper-ink-soft)`。
  3. Ribbon 界面完全缺少 Word 字体功能区的“A（文字效果）”下拉选择面板。
* **优先级**：**P3**

---

### 2. 表格高级排版与样式

#### 2.1 内置专业表格样式库与 `w:tblLook`
* **代码证据**：
  - `src/renderer/src/components/word/components/Ribbon.tsx:347-400, 2606-2634`
  - `src/renderer/src/components/word/editor/table-properties.ts:216-241`
  - `src/packages/docx-engine/types.ts:1915-1949`
* **Word 原生表现**：
  1. Word 内置 40+ 款基于 OOXML 的标准表格样式（网格型、列表型、浅色/深色底纹交替行）。
  2. 具有 6 个关键复选框（`w:tblLook`）：标题行（Header Row）、汇总行（Total Row）、带状行（Banded Rows）、第一列（First Column）、最后一列（Last Column）、带状列（Banded Columns），实时控制表格条件格式渲染。
* **当前实现差距**：
  1. **样式预设非标准且内联破坏**：`TABLE_PRESETS` 仅定义了 6 个前端本地硬编码视觉预设；应用预设时，`table-properties.ts:240` 强行将 `tblStyleId: null`，直接给单元格涂抹内联 `fill`/`border`，彻底破坏了 DOCX 规范的表格样式继承链！
  2. **缺失 `w:tblLook` 交互**：Ribbon 表格设计标签页中，完全没有 6 大条件格式开关勾选区。
* **优先级**：**P1**

#### 2.2 单元格 9 宫格对齐 (Nine-cell Alignment)
* **代码证据**：
  - `src/renderer/src/components/word/components/Ribbon.tsx:2875-2915`
  - `src/renderer/src/components/word/editor/extensions.ts:2461`
* **Word 原生表现**：
  在“表格工具 -> 布局”中，Word 提供了 3x3 矩阵式九宫格对齐控件（左上、中上、右上、居中靠左、绝对正中、居中靠右、左下、中下、右下）。点击任一格子，会同时原子化地设置单元格垂直对齐（`w:tcPr/w:vAlign`）与段落水平对齐（`w:pPr/w:jc`）。
* **当前实现差距**：
  Ribbon 中被割裂成垂直（顶/中/底 3 态）和水平（左/中/右 3 态）两排独立按钮。用户需多次点击，且对选中区域内包含多个段落的单元格应用时，水平段落对齐往往无法批量同步生效。
* **优先级**：**P2**

#### 2.3 表格公式计算 (`=SUM(ABOVE)`, `=AVERAGE(LEFT)` 等)
* **代码证据**：
  - 全局代码库检索：`docx-engine` 及 `word/` 中仅有数学公式 OMML，无任何表格公式求值逻辑。
* **Word 原生表现**：
  Word 表格布局选项卡中内置“公式 (`fx`)”功能，支持 `=SUM(ABOVE)`、`=AVERAGE(LEFT)`、`=COUNT(...)`、`=A1+B1` 坐标引用及数字格式掩码（如 `#,##0.00`），在单元格插入 `<w:fldSimple w:instr="=SUM(ABOVE)"/>`，按 F9 即可重新计算。
* **当前实现差距**：
  代码库完全未实现表格公式引擎，无公式解析求值器，无插入公式对话框，遇到外部带公式表格在修改数据后无法重新求值。
* **优先级**：**P2**

#### 2.4 表格按列排序 (Table Column Sorting)
* **代码证据**：
  - `src/renderer/src/components/word/components/Ribbon.tsx:3759-3765`
  - `src/renderer/src/components/word/components/icons.tsx:1678`
* **Word 原生表现**：
  Word 支持对表格（或所选文本）按某一列或多列（主关键字/次关键字）按笔画/拼音/数字/字母升降序排序，并可指定是否有标题行。
* **当前实现差距**：
  **代码直接硬编码为禁用与不支持**：
  ```tsx
  <button className="rb-icon" disabled data-tip={t('ribbonNotSupportedSuffix', { label: t('ribbonSort') })}>
    <IconSort />
  </button>
  ```
  该核心表格数据整理功能处于完全空白状态。
* **优先级**：**P2**

#### 2.5 浮动表格（`w:tblpPr`）可视化鼠标拖拽与文字环绕编辑
* **代码证据**：
  - `src/renderer/src/components/word/editor/table-handle.ts:141-215`
  - `src/renderer/src/components/word/editor/table-properties.ts:1-120`
* **Word 原生表现**：
  Word 右键表格属性提供“文字环绕：无 / 环绕”，点击“定位”可精细调整表格相对于页面、页边距的水平/垂直绝对位置，并在画布上通过表格左上角控制十字手柄自由拖拽，文字在其四周自适应环绕。
* **当前实现差距**：
  1. 无法将嵌入表格切换为环绕型浮动表格：`table-properties.ts` 没有任何接口生成或移除 `w:tblpPr`。
  2. 仅支持对导入时已有 `tblFloat` 的表格进行有限的 transform 位移，缺乏完整的文字围绕算法（目前仅依赖简陋的 CSS 浮动）。
* **优先级**：**P2**

---

### 3. 学术与长文档自动化体系

#### 3.1 动态域代码求值（`STYLEREF` 章节页眉、`SEQ \s`、`PAGE`/`NUMPAGES` 开关）
* **代码证据**：
  - `src/packages/docx-engine/parse.ts:5816-5825`
  - `src/packages/docx-engine/generate.ts:2252`
* **Word 原生表现**：
  1. 学术论文与正规出版物必须在页眉中使用 `STYLEREF "Heading 1"` 动态抓取当前页所在的章节主标题文本。
  2. 题注章节号联动：使用 `SEQ Figure \s 1` 使得每进入新的一章，图表序号自动重新从 1 开始计次（例如“图 2-1”）。
  3. `PAGE` 域支持数字格式开关（`\* Roman`、`\* alphabetic`、`\* CHINESENUM2`）。
* **当前实现差距**：
  1. **`STYLEREF` 处于冰冻死锁状态**：`parse.ts:5819` 明确注释：`other fields (DATE, STYLEREF, ...) keep their cached result runs`。如果用户在编辑器中修改了第一章的标题，页眉中的 `STYLEREF` 绝对不会联动更新，仍旧保持打开文件时的陈旧静态文字！
  2. **题注章节重置 `SEQ \s` 缺失**：`generate.ts:2252` 仅硬编码输出 `SEQ ${label} \* ARABIC`，无法关联大纲标题级别。
* **优先级**：**P1**

#### 3.2 题注系统（Captions 插入与自由编辑）
* **代码证据**：
  - `src/renderer/src/components/word/components/ribbon-references-tab.tsx:178-195`
  - `src/packages/docx-engine/generate.ts:2240-2252`
* **Word 原生表现**：
  Word 插入题注时，是在图表上方/下方插入一个普通段落（应用“题注”段落样式），内含 `SEQ` 域和普通可编辑文本。用户可以直接在正文中光标选词、换行、补充说明、修改格式；当在前面插入新图时，全局 F9 即可自动更新后续所有图表编号。
* **当前实现差距**：
  1. **将题注强行作为只读节点（`docProtected`）插入**：
     ```tsx
     editor.chain().insertContent({
       type: 'docProtected',
       attrs: { blockType: 'passthrough', label: t('ribbonCaption'), genXml: xml, fieldDisplay: { kind: 'text', left: display } }
     })
     ```
     导致用户在插入题注后，**无法在画布正文中自由编辑修改题注描述文字**！
  2. 编号为静态固化：增删前面图表后，已插入题注的编号无法动态级联刷新。
* **优先级**：**P1**

#### 3.3 目录（TOC）更新脆弱性与跳转
* **代码证据**：
  - `src/renderer/src/components/word/editor/toc-refresh.ts:26-58` (`applyTocPageDisplays`)
  - `src/renderer/src/components/word/App.tsx:3955-3979`
* **Word 原生表现**：
  Word 目录项与正文标题通过隐藏的书签（如 `_Toc12345678`）精准绑定。支持两种更新模式：
  1. “只更新页码”：通过书签 ID 反查最新排版页码。
  2. “更新整个目录”：重新遍历正文 Heading 1~9 级别段落，拉取最新修改的标题内容并重新构建目录树。
  按住 `Ctrl` 点击任意目录项，直接精准跳转到对应章节。
* **当前实现差距**：
  1. **纯字符串弱相等匹配断链**：`toc-refresh.ts:28` 采用 `const key = h.text.trim()` 与目录项的 `field.left` 字符串比对！如果用户把正文的“一、背景概述”改成“一、研究背景”，目录里的旧文本与新标题无法匹配，该目录项的页码永远停止更新！
  2. **缺失“更新整个目录”机制**：正文新增或删除了标题，无法一键重建目录项。
  3. **缺失点击跳转交互**：目录项在画布上仅是一个受保护的文本块，点击没有任何跳转定位到正文对应标题的行为。
* **优先级**：**P1**

#### 3.4 导航窗格（Navigation Pane）
* **代码证据**：
  - `src/renderer/src/components/word/components/NavPane.tsx:1-52`
* **Word 原生表现**：
  Word 经典左侧导航窗格包含 3 个选项卡：
  1. 标题（Headings）：树状大纲展示，支持节点折叠/展开；**核心杀手级功能：支持鼠标拖拽标题节点，其下辖的正文与全部子标题在文档中同步移动重排！**
  2. 页面（Pages）：多页微缩缩略图列表，点击快速翻页。
  3. 结果（Results）：搜索关键字在正文中的上下文预览列表。
* **当前实现差距**：
  `NavPane.tsx` 全文仅 52 行代码，只是一个静态平铺按钮列表，无大纲折叠，无缩略图视图，无搜索结果视图，**完全不支持拖拽重排文档章节结构**。
* **优先级**：**P2**

---

### 4. 图形、图片与多媒体交互

#### 4.1 图片非破坏性 OOXML 坐标裁剪（`a:srcRect`）
* **代码证据**：
  - `src/renderer/src/components/word/components/PictureDialogs.tsx:328-335`
  - `src/packages/docx-engine/patch.ts:1974, 1990`
  - `src/renderer/src/components/word/components/Ribbon.tsx:1000`
* **Word 原生表现**：
  Word 桌面版的图片裁剪是**绝对非破坏性的**（Non-Destructive）。无论用户怎么裁剪，底层原始图片文件保持 100% 原始分辨率和未裁切像素不变，Word 仅在 DrawingML 中标记 `<a:srcRect l="20000" t="15000" r="10000" b="5000"/>`。用户在 3 年后再次打开文档点击“裁剪”，仍然可以拖出手柄将原本裁掉的部分完整找回。
* **当前实现差距**：
  1. **前端 Canvas 破坏性重采样并重编码**：
     ```tsx
     const c = document.createElement('canvas')
     c.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
     onApply(isJpeg ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png'))
     ```
     强行将裁剪区域外的像素彻底抹杀，造成图片质量不可逆下降与 EXIF 信息丢失。
  2. **保存时主动剥离 OOXML 坐标**：`patch.ts:1990` 竟然写了 `.replace(/<a:srcRect\b[^>]*\/>/, '')`，主动抹去了标准裁剪标记！
* **优先级**：**P1**

#### 4.2 浮动对象环绕模式便捷切换（图片布局小彩虹图标）
* **代码证据**：
  - `src/renderer/src/components/word/editor/extensions.ts:927-990`
  - `src/renderer/src/components/word/components/Ribbon.tsx:2467`
* **Word 原生表现**：
  在 Word 中点击任意图片或形状，右上角立即浮现“布局选项”图标（悬浮小彩虹）。点击直接弹出浮层，2 步之内切换：嵌入型、四周型、紧密型、穿越型、上下型、衬于文字下方、浮于文字上方。
* **当前实现差距**：
  画布内部没有任何悬浮交互挂件，用户必须在顶部 Ribbon 或右键菜单中层层寻找，阻断编辑心流。
* **优先级**：**P2**

#### 4.3 形状多选组合/解组（`wpg:wgp`）与黄色控制手柄调节
* **代码证据**：
  - `src/packages/docx-engine/parse.ts:2592`
  - `src/renderer/src/components/word/editor/shape-draw.ts`
* **Word 原生表现**：
  1. 支持 Shift / Ctrl 点击多个形状，右键一键“组合”（生成 `<wpg:wgp>` / `<wpg:grpSp>`）与“取消组合”。
  2. 预设几何形状（圆角矩形、折角形、各式箭头、标注框气泡）具有一个或多个黄色菱形控制手柄（Adjustment Handles），可拖动调整圆角半径、箭杆粗细、尖端弧度（底层映射到 `a:avLst` 的 guide formula）。
* **当前实现差距**：
  1. 组合与解组功能为 0，无法将多个图形作为一个组进行整体移动缩放。
  2. 所有形状仅有 8 个外框缩放控制点，没有任何黄色参数调节手柄。
* **优先级**：**P2**

#### 4.4 SmartArt 智能图形交互化
* **代码证据**：
  - `src/packages/docx-engine/types.ts:1123` (`SmartArt display-only degrade`)
  - `src/packages/docx-engine/parse.ts:7159`
* **Word 原生表现**：
  SmartArt 是包含数据模型（`dgm:dataModel`）、布局定义（`dgm:layoutDef`）、样式（`dgm:styleDef`）的动态矢量图示系统。具有侧边“文本窗格”，按 Enter 自动增加子节点，按 Tab 改变层级，并支持随时无损切换版式（如从流程图切换到循环图）。
* **当前实现差距**：
  当前代码库明确将其实现为“静态降级只读渲染”，完全无法编辑文字、增删节点、切换版式，也无法在插入菜单中新建 SmartArt。
* **优先级**：**P3**

---

### 5. 审阅、修订与法务对比

#### 5.1 修订“简单标记”（Simple Markup）模式
* **代码证据**：
  - `src/renderer/src/components/word/components/ribbon-tabs.tsx:635` (`export type RevisionDisplayMode = 'all' | 'none' | 'original'`)
  - `src/renderer/src/components/word/App.tsx:895`
* **Word 原生表现**：
  Word 审阅选项卡的“修订显示标记”中，**默认且最常用的模式是“简单标记”（Simple Markup）**：正文以干净整洁的最终排版显示（隐藏删除线，插入文字以正常样式显示），但左侧页边距会出现一条整齐的红色修订垂直指示线（Margin Revision Bar）。点击该红线即可在“简单标记”与“所有标记”之间瞬时切换。
* **当前实现差距**：
  类型定义直接遗漏：`'all' | 'none' | 'original'`，唯独没有 `'simple'`！用户要么忍受“所有标记”下一堆红字删除线的视觉污染，要么切换到“无标记”完全不知道哪一行被改动过，缺乏法务级优雅审阅体验。
* **优先级**：**P1**

#### 5.2 审阅者过滤（Filter by Author）
* **代码证据**：
  - `src/renderer/src/components/word/editor/revisions.ts:24-43, 270`
  - `src/renderer/src/components/word/review-actions.ts`
* **Word 原生表现**：
  Word“显示标记 -> 特定人员”提供所有协作者的名字多选列表（例如 [x] 张三, [ ] 李四）。取消勾选他人后，画布上只显示张三的批注与修改，且点击“接受显示的全部修订”时，仅接受张三的改动，李四的改动完好保留。
* **当前实现差距**：
  底层虽然记录了 `author` 字符串，但没有提供审阅者筛选状态与 UI 界面，接受/拒绝只能全盘或逐个单步，无法按人员过滤。
* **优先级**：**P2**

#### 5.3 文档深度比较（Compare Documents）
* **代码证据**：
  - `src/renderer/src/components/word/editor/compare.ts:1-83`
  - `src/renderer/src/components/word/components/ComparePanel.tsx:1-83`
* **Word 原生表现**：
  Word 的“比较文档”（常用于合同、法规、标书版本审查）会读取文档 A 和文档 B，进行字级别精细比对，并**自动生成一份带有标准 OOXML `<w:ins>` 和 `<w:del>` 修订标记的正式新文档**，直接可在 Word 中进行逐条修订审阅和下发。
* **当前实现差距**：
  1. 当前只在前端侧边栏弹出一个极为简陋的段落级对比面板（`ComparePanel.tsx`），展示“第 N 段被删除/被新增”。
  2. 无法在段落内进行词级/字符级细粒度标红，更无法导出或生成带有标准 Word 修订标记的对比 DOCX 文档。
* **优先级**：**P1**

---

### 6. 排版工具与版面交互

#### 6.1 分栏中缝垂直分隔线（`w:cols w:sep="1"`）
* **代码证据**：
  - `src/packages/docx-engine/section.ts:182, 416-469`
  - `src/packages/docx-engine/types.ts:615-622`
* **Word 原生表现**：
  Word 分栏设置（Columns -> More Columns）中有一个极为核心的选项：“分隔线”（Line between，对应 OOXML `w:cols w:sep="1"`）。在学术期刊、双栏报刊排版中属于标配元素。
* **当前实现差距**：
  1. `SectionSettings` 中根本没有 `colSep?: boolean` 定义。
  2. `section.ts` 不解析也不回写 `w:sep`。
  3. 画布排版引擎未在分栏间隙绘制竖向线，UI 分栏对话框无此开关。
* **优先级**：**P2**

#### 6.2 独立常驻“样式窗格”（Styles Pane）
* **代码证据**：
  - `src/renderer/src/components/word/components/Ribbon.tsx`
* **Word 原生表现**：
  Word 桌面版通过快捷键 `Ctrl+Alt+Shift+S` 或样式区右下角小箭头唤起右侧常驻“样式窗格”：
  1. 显示所有内置和自定义样式的层叠列表（带字体预览）。
  2. 核心功能：“选择所有 N 个实例”（Select All Instances），能一键跨页选中正文中所有使用该样式的段落。
  3. “修改样式”（Modify Style）弹窗，可配置样式的基准样式、后续段落样式、快捷键绑定。
* **当前实现差距**：
  当前只有顶部 Ribbon 横向跑马灯卡片，无法常驻侧边，无法管理深层的 Heading 4~9 标题，不支持“全选所有实例”，不支持修改样式继承关系。
* **优先级**：**P2**

#### 6.3 垂直标尺与标尺公制单位（cm/mm）切换
* **代码证据**：
  - `src/renderer/src/components/word/components/Ruler.tsx:28-44`
* **Word 原生表现**：
  1. 中文版 Word 标尺默认单位为“厘米 (cm)”或“字符”，按公制毫米划分刻度。
  2. 页面左侧提供垂直标尺（Vertical Ruler），不仅直观展示上下页边距，而且支持鼠标直接拖拽上下边距红线调整版面。
* **当前实现差距**：
  1. `Ruler.tsx:41` 硬编码使用英寸（`Math.floor(section.pageWidth / 1440)`），完全不提供公制厘米/毫米单位切换。
  2. 垂直标尺完全缺失。
* **优先级**：**P2**

#### 6.4 版面属性调整（页边距、方向、分节）纳入撤销/重做栈（Undo/Redo）
* **代码证据**：
  - `src/renderer/src/components/word/App.tsx:643-650, 5620-5635`
* **Word 原生表现**：
  在 Word 中调整了页边距（如由普通改为狭窄）、改变了纸张方向（横向/纵向）或修改了分节符，立即按 `Ctrl+Z` 可以无缝撤销该版面操作，恢复原先的页边距和方向。
* **当前实现差距**：
  `section` 与 `sections` 使用独立的 React `useState` 存储在顶层状态中，根本没有接入 ProseMirror 的 Transaction / History 栈！用户误操作调整了页边距后按 `Ctrl+Z`，无法撤销版面修改，反而会撤销上一拍在正文中输入的文字，造成严重的用户困惑与误删文字风险！
* **优先级**：**P1**

---

### 7. 查找、替换与批量排版

#### 7.1 特殊标记查找替换（`^p`, `^t`, `^m`）与通配符支持
* **代码证据**：
  - `src/renderer/src/components/word/components/FindPanel.tsx:28-61` (`findMatches`)
* **Word 原生表现**：
  Word 查找替换支持特殊排版标记转义：
  - `^p`：段落标记（回车符），常用于将网页复制下来的多个空行批量替换为一个空行（查找 `^p^p` 替换为 `^p`）。
  - `^t`：制表符。
  - `^m`：人工分页符。
  - `^l`：软回车（换行符）。
  - `^b`：分节符。
  - 通配符模式（使用正则表达式/通配符批量提取或重构文字）。
* **当前实现差距**：
  `findMatches` 内部是纯粹的 `text.indexOf(needle)` 字符串比对，完全不支持任何 `^p`/`^t`/`^m` 特殊标记转义，不支持通配符。
* **优先级**：**P1**

#### 7.2 格式查找与替换 (Format Find & Replace)
* **代码证据**：
  - `src/renderer/src/components/word/components/FindPanel.tsx`
* **Word 原生表现**：
  在 Word 替换面板中点击“更多 -> 格式”，可以设定：查找格式为“斜体 + 红色 + 楷体”的文本，批量替换为“加粗 + 黑色 + 宋体”；或者查找应用了“样式 A”的段落批量替换为“样式 B”。
* **当前实现差距**：
  当前面板仅支持纯字符串替换，没有任何按字体、颜色、字号、段落样式的筛选和替换能力。
* **优先级**：**P2**

---

### 8. 大文档性能与架构瓶颈

#### 8.1 编辑画布缺少 DOM 视口虚拟化
* **代码证据**：
  - `src/renderer/src/components/word/App.tsx:1-6632`
  - `src/renderer/src/components/word/editor/extensions.ts`
* **Word 原生表现**：
  Word 桌面版具备超强 C++ 渲染流水线，数千页长篇巨著依然瞬间加载、丝滑滚动。
* **当前实现差距**：
  当前前端架构采用单一 ProseMirror contenteditable DOM 挂载。在面对 100+ 页、数万段落的大型学位论文、招标文件或年报时，几万个 DOM 节点全量挂载在页面中，极易引起浏览器垃圾回收（GC）停顿和滚动掉帧。
* **优先级**：**P1**

#### 8.2 排版全量 `getBoundingClientRect()` 同步布局抖动 (Layout Thrashing)
* **代码证据**：
  - `src/renderer/src/components/word/App.tsx:3760-3830`
  - `src/renderer/src/components/word/pagination-lines.ts:560-910`
* **Word 原生表现**：
  Word 排版引擎在排版计算与分页切片时使用内存纯几何运算，绝不会出现阻塞渲染管道的布局回流。
* **当前实现差距**：
  在 `App.tsx` 的分页切片与缝隙对齐主循环中，充斥着超过 110 处同步 `getBoundingClientRect()` 调用，且在循环体内部边插入 DOM 节点装饰（`repeatHeaderEls`, `.page-gap-inline`）边反复测量。这会触发 Chromium 的 **Forced Synchronous Layout（强制同步重排抖动）**，随着文档页数增加呈非线性性能劣化。
* **优先级**：**P1**

#### 8.3 大文档保存时主线程 JSZip 压缩卡顿
* **代码证据**：
  - `src/packages/docx-engine/patch.ts:1407-1411`
  - `src/renderer/src/components/word/file-actions.ts:671`
* **Word 原生表现**：
  Word 保存为后台异步 I/O 流式写入，前台打字绝无卡顿或掉帧。
* **当前实现差距**：
  保存 DOCX 时，在渲染进程主线程直接调用 `out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })`。虽然有 Promise 包装，但 JSZip 的 DEFLATE 压缩是高度 CPU 密集的同步算法。遇到包含大量插图的 50MB+ 大文档或数百页文档，前端主线程会直接冻结 1~5 秒，导致正在输入的按键丢失、界面未响应。
* **优先级**：**P1**

---

## 全量缺陷优先级汇总矩阵

| 序号 | 模块领域 | 缺陷条目 | 核心原因与影响 | 优先级 |
| :--- | :--- | :--- | :--- | :---: |
| **1** | 审阅/修订 | **“简单标记”（Simple Markup）模式缺失** | 仅有 all/none/original，缺少 Word 最默认核心的边栏红线指示模式 | **P1** |
| **2** | 审阅/对比 | **文档深度比较仅为侧栏段落 LCS，无法生成带标准修订标记的 DOCX** | 无法生成正式对比文档，无法提供字级精准对比，法务合同比对受阻 | **P1** |
| **3** | 排版/撤销 | **版面属性（边距、方向、分节）未纳入撤销栈** | 使用独立 useState，Ctrl+Z 无法撤销版面调整，反误删正文文字 | **P1** |
| **4** | 字体/缩放 | **字符缩放 `charScalePct` 保存彻底丢失，字符拉伸变单纯间距** | 回写 Run 遗漏字段，造成文档重要样式属性开箱即丢 | **P1** |
| **5** | 字体/下划线 | **下划线丰富线型与颜色在底层被压平硬编码为 `single` 单线** | 保存时强行写死 `<w:u w:val="single"/>`，破坏性降级外部文档 | **P1** |
| **6** | 长文档/题注 | **题注被包装为 `docProtected` 只读节点，正文无法自由编辑** | 违背 Word 题注本质（题注段落应为普通段落+可编辑文本+SEQ域） | **P1** |
| **7** | 长文档/目录 | **目录更新采用字符串弱匹配脆弱易断，且无法重构目录与点击跳转** | 正文修改标题错别字即导致目录页码断链；无更新整个目录与跳转能力 | **P1** |
| **8** | 长文档/动态域 | **`STYLEREF` 处于冰冻死锁状态，标题修改后页眉无法动态联动** | 学术论文与正式公文必备的页眉章节抓取功能彻底失效 | **P1** |
| **9** | 多媒体/裁剪 | **图片裁剪使用 Canvas 破坏性重采样并主动丢弃 `a:srcRect` 坐标** | 彻底背离 Word 无损裁剪规范，破坏原图质量且无法二次复原 | **P1** |
| **10**| 表格/样式 | **表格样式为前端内联硬编码涂抹，破坏 OOXML Table Style 继承体系** | 抹除 `tblStyleId`，且缺失 6 大 `w:tblLook` 勾选控制 | **P1** |
| **11**| 搜索/替换 | **查找替换不支持 `^p`, `^t`, `^m` 等特殊标记与通配符正则** | 纯 indexOf 比对，无法处理排版中最核心的段落符与制表符批量处理 | **P1** |
| **12**| 架构/性能 | **主线程 JSZip DEFLATE 压缩大文档导致 UI 线程卡死数秒** | 严重影响大文档保存与自动保存体验 | **P1** |
| **13**| 架构/性能 | **排版切片循环内大量 `getBoundingClientRect()` 造成强制同步回流抖动** | 超过 110 处测量穿插 DOM 变更，多表格大文档排版卡顿 | **P1** |
| **14**| 架构/性能 | **编辑画布缺少 DOM 视口虚拟化** | 百页大文档全量挂载，内存与重绘压力随页数线性暴增 | **P1** |
| **15**| 审阅/过滤 | **审阅者过滤（Filter by Author）缺失** | 无法选择只查看或接受特定协作者的修改与批注 | **P2** |
| **16**| 字体/排版 | **中西文自动微间隙 `w:autoSpaceDE`/`DN` 混淆合并且保存未回写** | 无法精细区分西文字母与数字间距，且保存丢失 | **P2** |
| **17**| 字体/首字下沉| **首字下沉采用 CSS `::first-letter` 伪元素且未入分页测算** | 无法独立选词修改首字，临近页底容易发生排版截断重叠 | **P2** |
| **18**| 表格/对齐 | **单元格 9 宫格对齐控件割裂，无法原子化设置垂直与水平对齐** | 操作繁琐，多选单元格无法批量同步段落对齐 | **P2** |
| **19**| 表格/公式 | **表格公式计算（`=SUM(ABOVE)` 等）完全缺失** | 无法进行表格自动核算 | **P2** |
| **20**| 表格/排序 | **表格按列排序处于硬编码 disabled 不可用状态** | 核心表格整理功能缺失 | **P2** |
| **21**| 表格/浮动 | **浮动表格（`w:tblpPr`）无法通过属性对话框在嵌入与环绕间自由切换**| 缺乏可视化环绕与定位选项 | **P2** |
| **22**| 版面/分栏 | **分栏中缝分隔线（`w:cols w:sep="1"`）缺失** | 属性定义、XML解析写回及前端渲染全面缺失 | **P2** |
| **23**| 版面/标尺 | **标尺硬编码英寸，无公制厘米/字符切换，且缺失垂直标尺** | 不符合公制与中文排版习惯 | **P2** |
| **24**| 版面/样式 | **缺少常驻右侧的独立“样式窗格”（Styles Pane）** | 无法快速管理 1~9 级标题与“选择所有 N 个实例” | **P2** |
| **25**| 长文档/大纲 | **导航窗格过于简易，缺少大纲树折叠、拖拽调序与页面缩略图** | 长文档章节结构调整效率低下 | **P2** |
| **26**| 多媒体/交互 | **浮动对象缺少悬浮“小彩虹”布局选项快捷按钮** | 切换环绕方式链路过长 | **P2** |
| **27**| 多媒体/形状 | **形状多选组合/解组（`wpg:wgp`）与黄色控制手柄缺失** | 复杂图形绘制能力薄弱 | **P2** |
| **28**| 搜索/格式 | **查找替换不支持按格式/样式批量筛选替换** | 无法进行批量排版刷洗 | **P2** |
| **29**| 字体/效果 | **文字效果（倒影、发光、3D棱台、高级阴影）未实现** | 艺术字与排版视觉效果单一 | **P3** |
| **30**| 多媒体/智能图| **SmartArt 智能图示仅为只读降级展示，无法动态增删节点与切换版式** | 复杂图示系统缺失交互编辑能力 | **P3** |

---

## 下一阶段攻坚路线图推荐

为确保底层 DOCX 引擎与前端编辑器的健壮性、专业性与 Microsoft Word 桌面版的真正对齐，建议分为以下三个冲刺阶段推进：

### 第一阶段：核心数据保真、法务审阅与关键交互攻坚（解决 P1 阻断项）
1. **数据无损保存与格式回写修复**：
   - 修复 `convert.ts:3026`，补全 `charScalePct` 向底层 Run 的回写。
   - 重构 `underline` 类型支持枚举（`single`, `double`, `dotted`, `dash`, `wave` 等）及下划线颜色，彻底摒弃 `generate.ts` 中写死 `w:val="single"` 的破坏性逻辑。
   - 重构图片裁剪：停止使用 Canvas 破坏性重采样，改为更新图片节点上的 `crop: { l, t, r, b }` 属性，并在 `patch.ts` 中保存标准 `<a:srcRect>`。
2. **法务级审阅与对比对齐**：
   - 补充 `RevisionDisplayMode = 'simple'`（简单标记模式）：正文呈现干净阅读态，左侧 Margin 渲染红色标记线，点击切换展开。
   - 升级 Document Compare：从轻量侧栏升级为能够输出带标准 `<w:ins>`/`<w:del>` 的合并 DOCX 文档。
3. **学术自动化核心修复**：
   - 重构题注插入：解绑 `docProtected`，改为普通 Caption 样式段落 + `SEQ` 域，赋予正文自由编辑能力。
   - 解决目录更新脆弱性：改为隐藏书签 ID 索引，并增加“更新整个目录”大纲遍历逻辑。
   - 实现 `STYLEREF` 动态页眉计算。
4. **排版撤销栈与查找替换**：
   - 将 `section` / `sections` 版面属性包装为 ProseMirror Custom Step，纳入全局 Undo/Redo 历史栈。
   - 扩展 `FindPanel`：支持 `^p`、`^t`、`^m`、`^l` 特殊标记与通配符替换。
5. **大文档保存优化**：
   - 将 `JSZip.generateAsync` 迁移至 Web Worker 中执行，彻底解放主渲染线程，消除大文档保存掉帧卡死。

### 第二阶段：排版工具人体工学与表格高级体系（攻坚 P2 体验项）
1. **高级表格系统升级**：
   - 表格 9 宫格对齐面板（原子化垂直居中 + 段落水平居中）。
   - 表格内置标准样式库与 6 大 `w:tblLook` 复选框支持。
   - 激活 `IconSort`（表格指定列多关键字排序）。
   - 表格公式计算引擎（`=SUM(ABOVE)` 等）。
2. **排版工具易用性增强**：
   - 分栏中缝分隔线 `w:cols w:sep="1"` 全链路打通。
   - 标尺重构：支持公制厘米/字符切换，增加垂直标尺。
   - 常驻“样式窗格”（Styles Pane）与“选择所有 N 个实例”。
   - 导航窗格大纲树化，支持拖拽章节节点同步移动文档内容，增加页面缩略图 Tab。
3. **审阅者特定人员过滤（Filter by Author）**。

### 第三阶段：图形进阶与高级视觉美化（攻坚 P3 视觉项）
1. 图片/图形右上角悬浮“小彩虹”布局选项便捷浮层。
2. 形状多选组合/解组（`wpg:wgp`）与黄色控制手柄调整 `avLst`。
3. 文本艺术效果（渐变发光、倒影、高级外部阴影）。
4. SmartArt 智能图形尝试从只读展示逐步拓展文本窗格简单编辑。
