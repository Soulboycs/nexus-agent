# Nexus Agent 与 GenOffice 深度技术对比与全景对齐规范

> **执行基准**：深入调研 `D:\genoffice` 与 `d:\Agent` 源码，从**整体产品形态**、**功能维度**、**显示与视觉维度**、**Agent 使用与协同流维度**四大核心层面进行全景剖析，建立清晰的 1:1 对齐差距矩阵与改造演进方案。

---

## 目录
1. [产品定位与系统架构对比](#1-产品定位与系统架构对比)
2. [功能维度深度对比 (Features)](#2-功能维度深度对比-features)
3. [显示与视觉维度对比 (Display & UI)](#3-显示与视觉维度对比-display--ui)
4. [Agent 使用与协同工作流对比 (Agent & AI Workflow)](#4-agent-使用与协同工作流对比-agent--ai-workflow)
5. [综合差距分析矩阵 (Gap Analysis Matrix)](#5-综合差距分析矩阵-gap-analysis-matrix)
6. [1:1 体验对齐演进路线与实施方案](#6-11-体验对齐演进路线与实施方案)

---

## 1. 产品定位与系统架构对比

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             GenOffice (D:\genoffice)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  定位：AI 原生办公套件 (AI-Native Office Suite) - 对标 M365 / WPS / Google Docs │
│  架构：多 App 矩阵 (Docs, Sheets, Slides, PDF, Markdown, HTML)              │
│  拓扑：Electron Shell 管理多 Tab 窗口，AI 面板 (AiPanel) 嵌入在文档左侧      │
│  运行环境：AI Agent 在前端渲染进程直接运行 (In-Renderer AgentLoop)           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              Nexus Agent (d:\Agent)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  定位：下一代 AI 编程与智能文档协同工作台 (Coding & Document Workstation)     │
│  架构：Claude Code 状态机 + Antigravity 界面 + GenOffice 物理排版级 Word 引擎   │
│  拓扑：左侧主会话流 (ChatTimeline) + 底部终端 + 右侧抽屉式 Word 工作台        │
│  运行环境：宿主级 Agent 编排 (Node.js 主进程 AgentEngine + IPC / MCP Bridge)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

| 维度 | GenOffice (`D:\genoffice`) | Nexus Agent (`d:\Agent`) | 优劣与差异分析 |
| :--- | :--- | :--- | :--- |
| **产品核心定位** | 纯办公套件（重在排版、格式兼容与文档创作） | 跨域工程 Agent（代码开发 + 终端执行 + 办公文档全自动生产） | Nexus Agent 具备系统级执行能力，GenOffice 聚焦文档编辑体验。 |
| **套件矩阵范围** | Docs (Word), Sheets (Excel), Slides (PPT), PDF, Markdown, HTML 6 大套件 | Word (.docx) 物理排版工作台 + 全套 Coding Agent 工具 | GenOffice 套件更全；Nexus Agent 优先深化 Word 极致生产力。 |
| **AI 宿主位置** | 嵌入在 Word 画布左侧可折叠抽屉 (`AiPanel.tsx`) | 统一在主窗口左侧/中央的 Antigravity 聊天流 (`ChatTimeline`) | Nexus Agent 保持全局上下文统一，右侧抽屉式 Word 专注画布呈现。 |
| **Agent 执行层** | 前端浏览器主线程通过 `@genoffice/agent-core` 直接调用 LLM 并操作内存 DOM | Electron 主进程运行强类型状态机 `AgentEngine`，通过 IPC / MCP 远程驱动画布 | Nexus Agent 具备离线直接修改磁盘 DOCX 的能力，更稳健、更利于大模型长任务编排。 |

---

## 2. 功能维度深度对比 (Features)

### 2.1 底层 DOCX 引擎能力（100% 已对齐）
经过上一阶段移植，`d:\Agent\src\packages\docx-engine` 完整吸纳了 `D:\genoffice\packages\docx-engine` 的 43 个核心 OOXML 模块：
- **XML 解析与局部补丁**：`parseDocx`、`saveDocx`、`zip-splice` 毫秒级流式原子写入；
- **高阶排版特性**：复杂表格（合并单元格、三线表）、LaTeX / OMML 数学公式、多节横竖排版、页眉页脚、水印渲染；
- **协同与修订**：批注系统（Comments）、Track Changes 修订痕迹（插入 `<w:ins>` / 删除 `<w:del>`、一键接受/拒绝）；
- **文档安全与加密**：ECMA-376 保护密码哈希校验与加密防篡改。
> **测试证据**：全量 155 项自动化集成与单元测试在 `d:\Agent` 中 100% 通过（0 失败）。

### 2.2 编辑器功能对比
| 功能点 | GenOffice Docs | Nexus Agent Word 现状 | 差距与对齐建议 |
| :--- | :--- | :--- | :--- |
| **Ribbon 选项卡** | 包含 开始、插入、布局、引用、审阅、视图、设计 7 大完整选项卡 | 结构完全一致，保留 7 大选项卡及所有原生按钮 | 差异在于 开始 选项卡首位的 **Genspark AI 快捷组** 被剔除。 |
| **Ribbon AI 快捷操作** | 包含 总结 (Summarize)、润色 (Polish)、整理 (Tidy) 3 个一键 Prompt 按钮 | 缺失 | **建议补充**：在开始选项卡保留快捷操作按钮，点击直接激活右侧/左侧 Agent 发送对应指令。 |
| **物理分页与标尺** | A4 物理分页仿真排版、横纵双向物理标尺（拖拽边距） | 完全一致，直接继承 | 已 1:1 对齐。 |
| **查找与替换** | `FindPanel` 支持纯文本与正则替换、区分大小写、全词匹配 | 完全一致，直接继承 | 已 1:1 对齐。 |
| **Zotero 文献协同** | 内置 Zotero Document Controller，支持引用文献插入与元数据读取 | 代码已迁移，尚未绑定本地 Zotero 客户端 | 暂不作为当前 P0 阻塞。 |
| **导出能力** | 导出为 PDF（无头打印流）、导出为清洁 HTML、另存为 DOCX | 完全一致，直接继承 | 已 1:1 对齐。 |

---

## 3. 显示与视觉维度对比 (Display & UI)

这是用户提出体验差距最明显的关键领域（*“并没有像 GenOffice 那样知道到底改的是哪里，莫名其妙的”*、*“发生页面偏移与跳顶”*）：

### 3.1 改动高亮视觉呈现 (`.ai-changed`)
- **GenOffice 的视觉规范**：
  - 改动段落带有 `.ai-changed` 类名；
  - **浅色模式**：浅黄色温暖柔和背景（`--ai-highlight: #fff3c4`），左侧带有 4px 亮金色粗槽线（`--ai-highlight-border: #f2b900`）；
  - **暗色模式**：深金棕色背景（`--ai-highlight: #483d1e`），左侧金色边框（`--ai-highlight-border: #d9a71e`）；
  - **深蓝选区自动脱敏**：用户点击发送或 AI 介入时，立即调用 `setTextSelection(to)` 折叠清除浏览器的深蓝色文本遮罩，黄色高亮立刻裸露呈现。
- **Nexus Agent 现状缺陷**：
  - 样式定义存在，但浅色模式下 `:root` 变量继承链路不完整，导致背景透明；
  - 发送后浏览器的深蓝文字选区依然死死盖在文字上，遮挡了底层的所有高亮；
  - 仅首个块被打上标记，多选块其余部分无任何标记。

### 3.2 页面视口稳定性与防跳顶 (Viewport Drift Prevention)
- **GenOffice 的视口保证**：
  - AI 边写边替换使用的是 ProseMirror 就地原子变更（`replace_blocks`），DOM 节点保持稳定；
  - 滚动容器 `scrollContainer.scrollTop` 保持不动；
  - 只有在修改完成后，才执行针对目标段落的微小平滑滚动（`scrollIntoView()`），绝不摧毁 DOM，绝不发生白屏与跳回文档顶部的现象。
- **Nexus Agent 现状缺陷**：
  - 在 Agent 开始执行工具调用时，`App.tsx` 派发了 `nexus-word-open-file`，触发了 `openRecent()` -> `loadFile()`；
  - `loadFile()` 彻底卸载画布重新加载，导致 `scrollContainer.scrollTop` 瞬间被重置为 0，造成严重的“页面偏移跳顶”。

### 3.3 选区失焦态视觉保持 (`inactive-selection`)
- **GenOffice**：当焦点从 Word 编辑器移到左侧 AI 输入框时，通过 ProseMirror 插件保持灰色半透明虚选区（`.inactive-selection`），让用户在输入提示词时清晰看见当前针对的文档片段。
- **Nexus Agent 现状**：焦点切换后，选区可能直接消失。

### 3.4 文档内点击定位跳转与脉冲发光 (`docnav://` & `.ai-nav-target`)
- **GenOffice**：
  - AI 回复中附带超链接 `[👉 查看改动位置 (第 168-171 块)](docnav://block/168)`；
  - 点击链接调用 `navigateToBlock(editor, 168)`，画布平滑居中滚动，且目标段落呈现呼吸发光动画（`ai-nav-target`）。
- **Nexus Agent 现状**：
  - Agent 没有输出 `docnav://` 链接，MarkdownRenderer 也没有拦截和派发该协议。

---

## 4. Agent 使用与协同工作流对比 (Agent & AI Workflow)

这是用户提出“选中多个块为什么只有一个可以用”的核心根因所在：

```mermaid
graph TD
    subgraph GenOffice 模式 (嵌入式内存操作)
        G1[划选 168-171 块] --> G2[getSelectionScope 提取起止范围: 168-171]
        G2 --> G3[折叠清除深蓝选区]
        G3 --> G4[AiPanel 发起 Prompt]
        G4 --> G5[Agent 直接调用 replace_blocks 168-171]
        G5 --> G6[4 个块全部就地替换并打上 aiChanged]
        G6 --> G7[生成 docnav://block/168 链接]
    end

    subgraph Nexus Agent 现状 (跨进程链路断层)
        N1[划选 168-171 块] --> N2[askSendNow 仅读取 context.from]
        N2 --> N3[单点解析: 仅保留块 168, 丢弃 169-171]
        N3 --> N4[发送给 Agent: '请对第 168 块进行修改']
        N4 --> N5[Agent 调用 docx_modify_block blockIndex:168]
        N5 --> N6[仅第 168 块被翻译, 剩余 3 块保持中文未改动]
        N6 --> N7[触发 openRecent 导致视口跳顶到第 0 行]
    end
```

### 4.1 详细协同机制对比

| 协同环节 | GenOffice 实现 | Nexus Agent 现状 | 1:1 对齐改造目标 |
| :--- | :--- | :--- | :--- |
| **选区捕获范围** | `blockRangeOfPositions` 遍历节点，精准获取 `startIndex: 168, endIndex: 171` | `askSendNow` 仅根据 `from` 解析单个 `blockIndex = 168` | 实现 `getBlockRange`，完整向主会话输出 `startBlockIndex, endBlockIndex, blockCount` |
| **选区提交清理** | 发送瞬间调用 `editor.commands.setTextSelection(to)` 清除深蓝背景 | 未清除选区，深蓝背景死死覆盖文字 | 发送时强制清除深蓝选区，露出底层高亮 |
| **Agent 工具契约** | `replace_blocks(startBlockIndex, endBlockIndex, html)` | `docx_modify_block(filePath, blockIndex, text)` 仅支持单块 | 扩展 `docx_modify_block` 支持 `startBlockIndex, endBlockIndex, html` 批量区间 |
| **过程重载机制** | 零重载。通过内存 ProseMirror Transaction 局部替换，DOM 树不重建 | 工具执行期间派发 `openRecent`，导致全量磁盘重新解析并跳顶 | 增加文档活动状态守卫：活动文档在执行期间**坚决禁重载** |
| **对话区选区卡片** | 聊天气泡上方展示结构化 `AiScopeQuote` 卡片，包含范围与摘录 | 拼接入 Prompt 字符串中，缺少结构化卡片 | 在对话气泡中增加选区范围标签组件 |
| **编辑任务队列** | 支持多选区批量加入队列（`EditQueueCard`），一键合并执行 | 前端已有队列状态但无批量入口面板 | 下一阶段接入完整的任务批处理面板 |
| **一键回滚能力** | 修改前记录 `snapshot`，气泡下方提供“回滚本轮改动”按钮 | 仅依赖编辑器 Ctrl+Z 或 Git 恢复 | 在工具调用结果中记录快照并提供一键回滚 |

---

## 5. 综合差距分析矩阵 (Gap Analysis Matrix)

| 序号 | 模块 | 缺陷现象 / 差距 | 根因分类 | 解决状态 |
| :---: | :--- | :--- | :--- | :---: |
| **1** | **交互/范围** | 划选 168-171 块，只有 168 块被翻译，其余被吞 | 选区解析单点坍缩，工具契约仅声明单块 | **TDD 已建立，待写生产代码** |
| **2** | **显示/感知** | 无法感知到底改了哪里，没有高亮，深蓝遮挡 | 未折叠选区；CSS 变量浅色未激活；未标记多块 | **方案已锁定，待写生产代码** |
| **3** | **视口/体验** | 修改和插入过程中页面不断刷新，视口跳回顶部 (0px) | `tool_call_start` 误发 `openRecent` 重新加载文件 | **TDD 已验证，待写生产代码** |
| **4** | **导航/引用** | 对话回复无法一键点击定位到 Word 对应段落 | 缺少 `docnav://` 自定义协议与脉冲发光样式 | **方案已锁定，待写生产代码** |
| **5** | **功能/入口** | Ribbon 开始选项卡缺少 AI 总结、润色、整理快捷按钮 | 代码迁移时被精简 | **下一阶段演进** |
| **6** | **队列/批量** | 无法跨段落多次加入编辑队列并一键批量执行 | `EditQueueCard` 尚未挂载至工作台抽屉 | **下一阶段演进** |

---

## 6. 1:1 体验对齐演进路线与实施方案

### 第一阶段：解决 P0 级三大体验阻断（本轮执行）
1. **彻底消除过程刷新与视口跳顶**：
   - 在 `word/App.tsx` 中拦截 `nexus-word-open-file`，当活动文档路径匹配时严禁执行 `openRecent`；
   - 保持视口 `scrollTop` 稳定，更新操作采用内存就地局部变更高亮。
2. **多选块 1:1 批量替换闭环**：
   - `word/App.tsx` 的 `askSendNow` 计算并传递 `startBlockIndex, endBlockIndex, blockCount`；
   - 提交时立即执行 `editor.commands.setTextSelection(to)` 清除深蓝遮罩；
   - 升级 `docx_modify_block` 支持 `(startBlockIndex, endBlockIndex, html)`，一次原子性替换 4 个段落；
   - 被替换的 4 个段落全部注入 `attrs.aiChanged = true`。
3. **视觉感知与定位跳转闭环**：
   - 修复 `styles.css` 中浅色模式 `--ai-highlight: #fff3c4` 与 `--ai-highlight-border: #f2b900`；
   - 新增 `.doc-page .ai-nav-target` 呼吸脉冲发光动画；
   - `MarkdownRenderer.tsx` 拦截 `docnav://block/:index` 并派发跳转事件，画布平滑居中滚动至目标块。

### 第二阶段：进阶能力对齐（后续演进）
1. **Ribbon AI 快捷操作恢复**：在开始选项卡恢复“Genspark AI”一键总结、润色、排版整理按钮。
2. **编辑队列面板挂载**：引入 `EditQueueCard`，支持多选区批处理。
3. **气泡级一键回滚**：在工具执行前保存 ProseMirror 文档快照，支持气泡级无损一键撤销。
