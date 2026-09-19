# 多 Pane 工作台实施计划

> 状态:**v2 终审定稿**(2026-09-20)。v1 经三个独立评审(性能渲染 / 布局拖拽 / 引擎与数据正确性)逐行终审后修订,终审记录见 §13。
> 作为多 pane 工作台改造的唯一实施依据。阶段状态:`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。

---

## 0. 决策记录(已与产品确认)

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | pane 是否分类型 | **不分**。通用 tab/pane 体系,内容 kind 注册进 registry 即获得全部拖拽/分割/联动能力 |
| D2 | pane 边界 | 应用内分割,不做系统级弹出窗口 |
| D3 | 性能目标 | **8 个 pane 同时流式**输出,拖拽期间不掉帧;IPC delta 合帧第一期就做 |
| D4 | 文档联动模型 | **零配置文件跟随**:文档 pane 只认文件不认配对;联动对象由用户操作(拖/@/焦点)指定 |
| D5 | agent↔agent 联动 | 走"摘要+指针"结构化委派消息,不做全量历史拷贝 |
| D6 | 实施节奏 | 分四阶段,每阶段独立可验收 |
| D7 | 上下文策略 | 绑定是引用不是拷贝:注入"路径+骨架+token 预算",细节按需走工具 |
| D8 | 拖拽普适性 | **所有 tab 一视同仁、全部可互拖**;Sidebar=通用收纳区,每个 kind 声明自己的收纳分区 |
| D9 | 硬件加速 | 现状已禁用(`main/index.ts:10`),**禁用原因已查明:修复窗口崩溃**(commit `56f7fb6 "Disable hardware acceleration to resolve window crash & add crash logger"`)。决策:**保持禁用**,60fps 依赖 §8.2 重绘降本(markdown 降频解析 + 打字机分级 + 非聚焦跳过);GPU 恢复作为独立 spike(需崩溃记录器验证)另行评估,不在本计划内 |

---

## 1. 目标与非目标

### 1.1 目标

把 Antigravity 从"单会话 chat + 固定右侧 Word dock"升级为**多 pane 智能体工作台**(paseo 的升级版):

1. **多 agent 并排**:工作区分割出多个 pane,每个 pane 绑定独立会话,同时运行、同时流式输出;
2. **Windows Snap 式拖拽**:拖动会话/pane 时出现半透明落点预览(左半/右半/上下/居中),松手吸附分割;
3. **左右互拖**:Sidebar 条目拖进工作区开成 tab;任意 tab 拖回 Sidebar 收纳(会话后台继续跑);
4. **零配置联动**:agent 改哪份文档,展示该文档的 pane 自动打开/跟随/亮角标;文档"问 AI"自动路由回最近操作它的会话;
5. **agent↔agent 联动**:拖会话 tab 到另一输入框或 @会话,生成委派消息,多 agent 协作;
6. **持久化**:布局(pane 结构/尺寸/tab)重启原样恢复。

### 1.2 非目标(本期不做)

系统级弹出窗口、移动端、插件体系、终端 pane(主进程 `terminal:data/input` 是死接口,先修通再说)、概览审查 pane(现为 mock)、真虚拟化列表(content-visibility 先行,数据说话再上)。

---

## 2. 现状与差距(探索 + 终审核实)

### 2.1 硬缺口

| # | 缺口 | 位置 | 影响 |
|---|------|------|------|
| G1 | 主进程**单 engine** | `src/main/index.ts:28` 全局唯一 `agentEngine`;`run()` 忙时抛 "Agent is already busy"(`AgentEngine.ts:366`) | 第二个会话跑不起来 |
| G2 | 流式事件**无 sessionId** | `agent:event` 单通道广播(`main/index.ts:228-231`);`AgentEvent` 均不带会话标识(`shared/types.ts:42-54`);`main/index.ts:302` 裸 error 发送绕过一切路由 | renderer 无法按 pane 路由 |
| G3 | renderer **单会话假设** | App.tsx(729 行"上帝组件")单 `currentConversationId`(:45)、单 `useReducer`(:56)、单份 `persistedMessageIdsRef`(:62-63) | 多会话下后台 pane 消息不落盘或串会话 |
| G4 | **无 tab/pane/拖拽体系** | 无 tab 管理;无拖拽库;Word 固定右侧 dock 全局单实例(`RightAuxiliaryBar.tsx`) | 多 pane 从零建设 |
| G5 | **硬件加速被禁用** | `main/index.ts:10-14`:`disableHardwareAcceleration()` + `disable-gpu` | 软件光栅下 8 路流式重绘是掉帧第一风险(R10) |
| G6 | **docx 命令无路径寻址** | live 画布分支对"当前活跃文档"操作、`save_document` 把内容写到 LLM 给的路径(`docxTools.ts:63/196/328/551/591/686` → `:201/335/553/597/694`);mcp-bridge 广播到**所有** Word 实例且 main 只收首个回包(`mcp-bridge.ts:270-284`、`docsBridge.ts:144-149`) | 多文档多 pane 下跨文档覆写/双写,联动前置硬门槛(R11) |
| G7 | **sessionStore index 写撕裂** | `persistIndex` 非原子整文件覆写且并发无互斥(`sessionStore.ts:1229-1236`) | 多会话并发 append 时 index.json 撕裂(R13) |
| G8 | **沙箱锁死 workspace 外文档** | `SandboxGuard allowedRoots=[workspaceRoot]`(`SandboxGuard.ts:18-19`),query.ts:216-220 监狱校验 | "路径即身份证"核心场景(打开任意位置的文档)agent 改不了(R14) |

另:`agent:send-message`(`main/index.ts:271`)每次调用改全局 `workspaceRoot` 并重建共享 provider;`setWorkspaceRoot`(`AgentEngine.ts:261-278`)漏重建 `fileHistoryTracker`;renderer 无条件自动批准一切审批(`App.tsx:280-284`)。

### 2.2 可复用资产

- **providers 无状态**(`chatStream` 每次调用自带全量上下文)→ 多 engine 并发共享安全;
- **sessionStore 已按会话分文件**(JSONL 追加路径多会话安全,仅 index 有 G7);
- **chatReducer 纯函数且增量追加语义**(`chatReducer.ts:141/156/176/191` 全是 `+ delta`;非活跃消息原样返回引用 `:133`)→ 多实例化零改动 + message 级 memo 天然命中;
- **buildDocumentContext 已带预算骨架器**(`word/ai/protocol.ts:516-600`,8000 字符上限 + 两级收缩 + 中段省略保索引连续)→ 上下文预算 L1 直接复用;
- **RightAuxiliaryBar rAF 拖宽**(`:149-204`)→ 两阶段 commit 思想出处(渲染手法换 preview 态,见 §4.4);
- **Word 双向联动雏形**:会话↔文档 localStorage 映射、`nexus-word-open-file`/`nexus-word-ask-ai`、`docsBridge` 的 `agent:word-focus`/`docs:file-changed`;
- **MockLLMProvider**(`LLMProvider.ts:264-316`)→ 扩展为性能负载源。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────┐
│ App 壳:DndContext(统一拖拽域) + TopBar + Sidebar     │ ← Sidebar 通用收纳区,可拖出/可接收
├──────────────────────────────────────────────────────┤
│ 布局层:SplitRenderer(递归树) + TabBar + RetainedPanel │ ← 布局 store(zustand persist + zod)
│         pane 内容 = tabRegistry[kind].component        │ ← 注册表:chat / word / …
├──────────────────────────────────────────────────────┤
│ 联动层:pathToTab 路由 + lastTouch 记忆 + 落位策略       │ ← 零配置,意图=拖/@/焦点
│         FileChangeHub 通知枢纽 + 路径规范化契约          │
├──────────────────────────────────────────────────────┤
│ 会话层:useSessionChat(事件总线按 sessionId 投递)      │ ← 每 pane 独立 chatReducer 实例
├──────────────── IPC(agent:event-batch 批量通道)───────┤
│ 主进程:SessionManager(Map<id,Engine>)+ DeltaCoalescer │ ← per-session 生命周期/provider
└──────────────────────────────────────────────────────┘
```

分层依赖规则:上层依赖下层,严禁反向;pane 内容组件不得感知布局树(经注册表接口)。

---

## 4. 布局层设计(L2)

### 4.1 数据模型(参考 paseo,适配 React DOM,终审修订)

```ts
// src/renderer/src/workspace/layout-model.ts —— 纯函数,无 React 依赖

interface PaneTab {
  tabId: string;
  target: TabTarget;          // 判别联合,见 4.2
  createdAt: number;
}

interface PaneState {
  id: string;                 // 稳定 id,持久化,禁止改名(React key 同源)
  tabs: PaneTab[];            // tab 栈直接存对象(终审:不做 tabIds 镜像,用时派生,消灭失序 bug 类)
  focusedTabId: string | null;
  hidden?: boolean;           // 隐藏仍在树里,让位不删除
}

interface GroupNode {
  id: string;
  direction: 'horizontal' | 'vertical';
  children: LayoutNode[];
  sizes: number[];            // 归一化小数,和为 1;仅作初始默认
}

type LayoutNode = { kind: 'pane'; pane: PaneState } | { kind: 'group'; group: GroupNode };

interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
}
```

要点(终审定稿):

- **不变量 `pane.tabs.length ≥ 1`**:空 pane 自动补一个新 chat tab(split 不带 tab、closeTab 清空、持久化恢复三个场景由 normalizeLayout 兜底)——同时消灭 `focusedTabId: null` 渲染分支;
- **尺寸存树外**:`sizesByGroupId: Record<groupId, number[]>` 单独存,resize 不改树、不触发重挂载;**split/remove 改变某 group children 数量时必须同步 splice/删减对应 sizes 条目**(否则继承 paseo 自己都有的"resize 后再 split 尺寸跳变"瑕疵);渲染读序 `stored ?? tree.sizes`;
- **最小叶子 0.1**:`clampNormalizedSizes` 迭代式锁 0.1 再重分配;
- **树深上限**:MAX_TREE_DEPTH = 4,超限 split 返回 null(UI toast);
- **最后可见 pane 守门**:`setPaneHidden` 是唯一允许收起最后可见 pane 的路径,close 一律拒绝;
- **归一化渲染**:可见子项 `flexBasis:0 + minWidth/minHeight:0`,宽度只由 flexGrow 表达且按 sizes 归一化(hidden 子项 grow=0,恢复原宽还原);**ResizeHandle 只插在两个可见子项之间**,pointerdown 必须 stopPropagation(防被 DndContext PointerSensor 抢走);
- **根节点恒包一层合成 group**:裸 root pane 首次 split 会在同位置类型失配整树 remount——这是 R1 之外的第二个 remount 源;
- **normalizeLayout = 逐节点打捞**(单子 group 折叠、dangling focusedTabId/paneId 回落首个可见 pane);"整体弃用"**仅限存储层 strict 校验失败**,结构合法但语义脏的输入一律打捞不丢布局。

### 4.2 TabTarget 与注册表(回应 D1/D8:pane 不分类型)

```ts
// src/renderer/src/workspace/tab-registry.tsx
type TabTarget =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'word'; path: string };
// 以后新类型只在这里扩展 + 注册,自动获得拖拽/分割/联动全部能力

interface TabKindRegistration {
  kind: TabTarget['kind'];
  title: (t: TabTarget) => string;
  icon: (t: TabTarget) => ReactNode;
  component: React.ComponentType<{ target: TabTarget; active: boolean }>;
  sidebarSection: 'sessions' | 'docs';   // 侧栏收纳分区(拖回侧栏=收回至此,拖出=从分区打开)
  mentionSource?: (query: string) => MentionItem[];  // @ 提及候选源(§6.7,新类型零成本进 @ 列表)
  // 联动接口(阶段三启用):
  // exposeContext?(t): 联动资源标识(如 word → path)
  // onAgentEvent?(t, event): 联动事件入口
}
```

第一期注册两种 kind:`chat`(绑 sessionId)、`word`(绑 docPath)。

### 4.3 核心 mutation(纯函数,均有单测)

`normalizeLayout(unknown)`(逐节点打捞)/ **`openTabInLayout(layout, target, {paneId?, afterTabId?})`**(**去重:同 target 已存在只 focus**——"+"菜单、Sidebar 双击、阶段三落位策略全靠它)/ `splitPaneInLayout(layout, paneId, position: 'left'|'right'|'top'|'bottom', tabId | null)` / `moveTabToPaneInLayout(layout, tabId, toPaneId, afterTabId?)` / **`reorderTabsInPaneInLayout(layout, paneId, tabIds)`**(阶段二行内重排)/ `closeTabInLayout` / `closePaneInLayout` / `setPaneHiddenInLayout` / `focusPaneInLayout` / `selectTabInPaneInLayout` / `clampNormalizedSizes`。

`resizeSplit(groupId, sizes)` 是 **store action 不是树 mutation**(写前 clamp;树外 sizes)。

关键实现守门(见 §9):split 判父用完整 targetPath(R1)+ 根节点合成 group(R1b),两个 remount 源都要守,单测覆盖"连续 split 不 remount 已有 pane"。

### 4.4 渲染与交互(终审修订)

- **SplitRenderer**:`SplitNodeView` 递归;group → flex + ResizeHandle;pane → `RetainedPanel`(display:none 保活)+ TabBar + 内容区;group/pane 用稳定 id 作 React key;
- **两阶段拖宽(本地预览态覆盖,不做 DOM 直改)**:拖动中 setState 更新本组 `preview`(rAF 节流,仅该组重渲染),渲染取 `preview ?? stored`;pointerup 时 `clampNormalizedSizes` 写 store 并清 preview(同一事件内收敛,无跳变)。理由:布局树里 flexGrow 受 store 控制,DOM 直改会产生双权威,任何 store 更新都会把值拉回。相邻对 min 钳制(`computeResizeHandleSizes` 纯函数,可测);preview 用"相邻对"算法(只有相邻两格动);
- **持久化**:zustand 5 + persist → localStorage,`name: nexus_workspace_layout`,`version: 1`;**校验用 zod strictObject(zod 已在项目依赖,不手写)**:信封级失败(JSON 损坏/缺 version/version 未来/未知字段)→ removeItem 回默认;结构内语义脏 → normalizeLayout 打捞;`partialize` 写前 normalize;**hydration 门**:`useLayoutHydrated()`(persist.hasHydrated + onFinishHydration)完成前不渲染布局,防默认布局闪现;**LinkageState 用独立 localStorage key**,不与布局树同 key 存亡;**schema 字段从此禁止改名**;
- **默认布局与迁移(阶段一只迁会话)**:阶段一根节点 = 单 chat pane(绑 `nexus_active_session_id` 的会话);`nexus_sidebar_open`/`nexus_word_drawer_open` 与 word 入树**推迟到阶段三**(避免阶段一期间 Word"右侧 dock + 树内隐藏 pane"双表示回归);迁移在 hydrate 后 bootstrap 执行,**首次 persist 落盘成功才删旧 key**(旧 key 只读保留一个版本,与 R9 一致)。

---

## 5. Snap 拖拽层设计(L3/L4,D8)

### 5.1 统一拖拽域

**依赖面:仅 `@dnd-kit/core` 单包**(不引 sortable/utilities——paseo 用 sortable 只是事件绑定语法糖,插入索引自算、不做 transform 跟随);`useDraggable`(tab chip、侧栏条目)+ `useDroppable`(chip 双注册、pane overlay、侧栏分区)+ DragOverlay。**全应用一个 DndContext** 包住 Sidebar + 工作区;禁止任何子列表自建内层 DndContext。

**设计原则:所有 tab 一视同仁、全部可互拖**——右侧工作区内随意重排/堆叠/跨 pane/边缘分割;pane⇄Sidebar 双向(收回/拖出)。右侧是拼装台,左侧是收纳区。

拖拽数据协议(**单轨**,drop 端只有 openTab/split/move/close 四个入口):

```ts
type DragPayload =
  | { kind: 'target'; target: TabTarget }   // 侧栏条目(未必已打开;drop 走 openTabInLayout 去重)
  | { kind: 'tab'; tabId: string };         // tab chip(paneId 由 drop 时查树,不随 payload)
```

### 5.2 落点判定与 Snap 预览

| 落点 | 判定 | 行为 | 预览样式 |
|------|------|------|----------|
| pane 边缘 | 指针在 pane 四边 15% 环内 | splitPane(被拖 tab 带入新 pane) | 半透明色块占 pane 一半 + 2px 描边 |
| pane 中央 | pane 中央 40% 矩形(两轴同时在 40% 内) | moveTabToPane(堆叠) | 整格 inset 高亮 + 描边 |
| tab 间隙 | 命中 tab chip 行,比较被拖 chip 中心 X 与目标 chip 中心 X | 同 pane 重排 / 跨 pane 插入 | 4px 竖 pill 插在 chip 间隙 |
| Sidebar | 命中对应收纳分区(会话区/文档区) | 任意 tab 收回:pane 关闭,条目回分区,状态保留后台继续跑 | 整分区高亮(不做插入指示线,侧栏顺序不持久化) |

- 预览画在**每个 pane 内容区的 overlay**(absolute inset-0、zIndex 40、pointerEvents:none;pane overflow-hidden 自动裁圆角;内容 wrapper 加 `isolation: isolate` 防编辑器高 z-index 反盖),两层 = 半透明填充 + 描边框,纯尺寸定位无动画库;只有 hovered 的 pane 画预览,8 pane 成本可忽略;
- **落点选择用指针(pointerWithin),pane 内位置判定用被拖 rect 平移后中心点**——纯指针会在 chip 尚未到边时误触发 split;
- collision 顺序:pointerWithin → tab-chip > pane-drop > sidebar-section;**去掉 closestCenter 兜底**(指针在一切落点之外 = 无预览、松手取消);
- PointerSensor distance: 8(桌面验证值,CSS 像素与 DPI 无关);**拖拽结束吞掉原生 click**(justDraggedRef)防误激活 chip;
- `resolveSplitDropPosition` 写成纯函数(edge 0.15 / center 0.40 / 死区按最近边回落)+ 单测;阈值常量收进一个文件,非对称调参留到验收后。

### 5.3 性能守门

- 预览状态(`{ paneId, position } | null`)锁在 DndContext 局部 state,**不进全局 store**;
- 被拖物走 DragOverlay 克隆浮层,源 chip 仅降透明度;
- drop 发生才写 layout store——拖拽全程零整树重渲染。

### 5.4 交互入口(拖拽之外)

- TabBar:每个 pane 顶部 tab 行,**横向滚动 + chip min 96px / max 160px + truncate + 两端渐隐**(不做 paseo 的 chip 测量制——三套测量机制是用不上的复杂度),带"+"菜单(新会话/打开文档)、Split Right / Split Down、Maximize、Close;
- Tab 右键菜单:Close / Close Others / Close Right;
- 快捷键(最小集):`Ctrl+\` split right、`Ctrl+Shift+\` split down、`Ctrl+W` 关 tab;不引 KeyboardSensor;
- Sidebar:通用收纳区(会话区 + 文档区,分区由各 kind 的 `sidebarSection` 声明);所有条目可拖出到工作区任意落点;双击=在聚焦 pane 打开(openTabInLayout 去重)。

---

## 6. 联动层设计(L5,零配置文件跟随,D4)

### 6.1 设计原则:联动对象由用户操作指定,系统从不猜

三层意图输入,按明确程度递减:

1. **拖拽即指定**:文档 tab 拖进会话输入框 = "处理这份文档"(上下文附件);会话 tab 拖进另一会话输入框 = "委派协作"(生成委派消息);
2. **@即指定**(交互规格见 §6.7):`@文档名` = 文档上下文;`@会话名` = 跨会话消息;
3. **焦点即默认**:聚焦哪个会话 pane 就发给谁;agent 改哪份文档,该文档 pane 就跟随。

### 6.2 五条大白话规则(实现即按此验收)

1. **文件变,窗口变**:同路径文档全局唯一 pane 实例;agent 改《论文》→ 展示《论文》的 pane 自动刷新(微信消息自动更新心智);
2. **新文档有固定落位**:会话上次打开它的 pane → 未锁定且未修改的 LRU 预览 tab(防增殖)→ 会话 pane 旁新 split 文档 pane(一次性成本,之后复用);
3. **放不下就叠 tab + 亮角标**:文档 pane 的 tab 栈可堆叠;后台文档被改,未激活 tab 亮小红点,点开即最新;
4. **问 AI 发给最近改它的人**:每份文档独立记忆 lastTouchSession(10 份文档 = 10 个独立指针);无记录发给聚焦会话,发送后记忆;
5. **两个 agent 抢一份文档,先问一句**:检测点在 `query.ts` 的 **runGate**(所有工具统一闸门)——**in-flight 写注册表**(`canonicalPath → 占用会话集`,tool_call_complete/executor.discard/abort 时释放;精确重叠判定,非时间窗,无误报);冲突时合成 `kind:'doc-conflict'` 的 ApprovalRequest **复用现有 pendingApprovals 全链路**(approval_required 事件 + respond-approval IPC)。**前置:renderer 现在无条件自动批准一切(App.tsx:280-284),必须对 doc-conflict 豁免自动批准**,否则本规则形同虚设(列入阶段三验收)。

### 6.3 数据结构与路径身份契约

**文档身份契约:路径即身份证,且必须规范化。** 文档的"是什么"与"在哪里"统一由**绝对路径**表示:联动表 key、IPC 传递、工具参数、记忆(lastTouch)全部用路径。渲染进程不直接碰文件,主进程是唯一读写方(docx-engine 所在层)。

**规范化规则(Windows:大小写不敏感、分隔符混用、8.3 短名)** —— 新建 `src/shared/paths.ts`:

- `normalizeKeyPath(p)`(renderer 表 key 用)= trim → 去引号 → 去 `file://` 前缀 → 反斜杠统一正斜杠 → 全路径 toLowerCase(`\\wsl$` 前缀例外);
- `canonicalizePath(p, workspaceRoot)`(仅 main 边界用)= isAbsolute 判定 → join → `fs.realpath.native`(解析短名/软链/规范大小写;文件不存在回退语法形——新建文档场景);
- **三个入口统一产出 canonical**:①工具参数(ToolContext 增加 canonicalize,带 mtime 缓存,替换 docxTools 的裸 resolvePath——LLM 可能给相对/变体路径);②`docs:open-path` 返回值;③`docs:file-changed`/`agent:word-focus` 事件 payload。renderer 联动表只收 canonical 再 normalizeKeyPath。不归一的后果:同一文档以短名/大小写变体分裂成多个 key,联动失联。

```ts
interface LinkageState {
  pathToTab: Record<string, string>;            // 文档路径(canonical)→ tabId(唯一实例路由表)
  lastTouch: Record<string, string>;            // 文档路径 → 最近操作的 sessionId
  panePreference: Record<string, string>;       // sessionId → 上次打开文档的 paneId(落位记忆)
  followPaused: Record<string, boolean>;        // tabId → 暂停跟随
  suppressedPaths: string[];                    // 不再自动打开的文档路径
}
```

### 6.4 路由流程与前置改造(数据正确性硬门槛)

**前置改造(G6/R11,不修不准上联动)**:

1. **禁止跨文档覆写**:docxTools 的 live 画布分支(docx_read/modify_block/append/insert_table/delete/apply_ops)对"当前活跃文档"操作,`save_document` 却把内容写到 LLM 给的路径——filePath ≠ 活跃文档即跨文档覆写。必须做 **docsBridge path 寻址**:`docs:mcp-ready` 带 `{path, tabId}`,main 维护 `Map<canonicalPath, {wcId, tabId}>`(复用现有 destroyed 清理机制);新增 `runDocsCommandForPath(command, payload, canonicalPath)`,**执行前校验目标实例当前文档 == canonicalPath**,不匹配 → 返回错误走离线分支;`getActiveDocsWcId` 降级为"任意实例 ready"语义;
2. **mcp-bridge 实例端过滤**:`normalizeKeyPath(message.targetPath) !== normalizeKeyPath(自身 doc.filePath)` → 直接忽略不回包(消灭多实例广播双写);
3. **`window.__aidocs` 改 per-instance 注册**(现多实例互相覆盖):path→context 映射,否则骨架注入拿错文档;
4. **通知枢纽 FileChangeHub**(main 单例):`notifyChanged(canonicalPath, source: 'tool'|'editor'|'external')`——mtime+size 去重、同 path 50ms 合并,统一广播 `docs:file-changed`;接入点 = docxTools 两个分支(**现状 live 分支从不通知**)+ `docs:save/save-as` handler;fs.watch 只对已打开文档所在目录兜底(捕获外部编辑;OneDrive/网络盘丢事件可接受——后果仅角标不亮,下次打开仍拉最新)。

**路由流程(实现顺序即判断顺序)**:

```
docx_* 事件到达(携带 sessionId + canonicalPath):
  ① pathToTab[path] 存在? → 是:更新该 tab;tab 未激活且未 followPaused → 亮角标。结束
  ② 不存在 → 按落位策略(6.2 规则 2)打开新 word tab,写 pathToTab。结束

"问 AI"点击(word pane):
  ① lastTouch[path] 存在且该会话 pane 在布局中? → 发给它,高亮该 pane
  ② 否则 → 发给当前聚焦的 chat pane;发送成功后写 lastTouch[path]

composer 发送(带文档上下文 chip):
  → 上下文预算器(6.6)拼装注入
```

### 6.5 取消联动(三层,均无破坏性)

原则:**取消联动不碰 agent 和文件本身**——暂停跟随只是 UI 不再看,agent 照常跑;要连 agent 一起停是 abort 会话,两者独立。

| 层级 | 操作 | 机制 |
|------|------|------|
| 消息级 | 输入框上下文 chip 点 ×(文档附件/@ 的会话/未发送的委派) | 移除 chip,本轮 prompt 不含该上下文 |
| Pane 级 | tab 右键"**暂停跟随**"(免打扰心智) | pane 忽略文件更新事件:不跳转不抢焦点,角标仍提示;再点恢复 |
| Pane 级 | 关闭被 agent 编辑的文档 pane → 轻提示"**不再自动打开**" | 写入 suppressedPaths,落位策略跳过该路径;手动打开/重新拖入即解除 |
| 记忆级 | tab 右键"清除最近操作记忆" | 删 lastTouch[path];不清也会被下次写入自然覆盖(last-writer-wins) |

### 6.6 上下文预算(回应"上下文过多"问题,D7)

绑定是**引用,不是拷贝**,分级注入:

| 级别 | 内容 | 时机 | 预算 |
|------|------|------|------|
| L0 | 绑定元数据(pathToTab/lastTouch) | 永不进 prompt | 0 token |
| L1 | 文档路径 + 骨架大纲 | 每轮发送时注入 | **复用 `buildDocumentContext`**(8000 字符上限 + 两级收缩 + 中段省略保块索引连续);@-chip 总预算 ~12000 字符(≈2-3k token),超出按 chip 均分 |
| L2 | 文档细节 | agent 用 docx 工具按 block 读取;大结果经 ToolResultStorage 落盘存引用 | 按需 |
| L3 | 跨会话委派 | 摘要 + 源会话 id;接收方按需工具拉取 | 单条委派消息预算上限 |

实现要点:预算用**字符近似**(保守安全);截断**分层级砍不砍尾部**(标题行必留 → 正文块预览 → 中段省略 → 绝不切断单行索引行);**@ 选中 chip 时即取骨架**(文档已打开 → 实例 buildDocumentContext;未打开 → 主进程 parseDocx 同款摘要,按 canonicalPath+mtime 缓存),发送时零等待拼接;替换 App.tsx:358-379 单 activeDoc 注入为 per-chip 循环。**注意 L1 依赖 §6.4 前置 3(per-instance context)**,否则拿错文档骨架。

### 6.7 输入框 @ 提及(意图输入的 UI 形态,对标 ZCode @ 弹层)

- **触发**:composer 输入 `@` → 光标处弹出提及面板,继续输入 @ 后文字实时过滤(无需独立搜索框);↑↓ 选择、Enter 确认、Esc 关闭;
- **手动输入畅通(弹层是辅助不是门)**:无匹配时列表底部给兜底行"使用『输入文字』"(按普通文本发送);Esc 关闭弹层后 @ 即普通字符,不拦截;粘贴 .docx 绝对路径 → 自动识别升级为文档引用 chip(与 @ 选入同一表示);
- **候选分组**:📄 文档(最近打开 + 当前已开,行=文件名+修改时间)、💬 会话(行=标题+运行状态徽章+会话色);运行中的会话排前;
- **确认后**:`@xxx` 变为引用 chip(高亮小块,退格整体删除/点 × 移除 = 6.5 消息级取消);
- **发送解析**:文档 chip → 路径+骨架注入(6.6 L1 预算截断);会话 chip → 委派消息(阶段四);
- **注册表扩展**:每个 kind 可声明 `mentionSource`(候选列表 + 行渲染),@ 面板自动聚合所有类型——新类型零成本进入提及列表。

---

## 7. 多会话引擎设计(L1,主进程,终审定稿)

### 7.1 SessionManager

```ts
// src/main/agent/SessionManager.ts
class SessionManager {
  private engines: Map<string, AgentEngine>;              // sessionId → engine(懒创建)
  private providers: Map<string, { provider, fingerprint }>;  // per-session provider 缓存
  run(sessionId, prompt, opts): void;      // 忙则错误回对应 pane;workspace 是首次创建引擎的构造参数
  abort(sessionId): void;
  respondApproval(sessionId, callId, decision): void;
  setPermissionMode(sessionId?: string, mode): void;  // 带 sessionId=单会话;不带=设默认并应用到现存引擎(兼容现有单开关 UI)
}
```

- **工厂与共享**:per-session 工厂直接用 `createDefaultAgentEngine`——工具实例本就是可共享单例(每引擎只是新 registry 引用 + 11 个轻对象,构造零 IO);**不复用 SubagentEngine**(缺 EventEmitter/审批/压缩器,只借鉴其"派生 registry"模式);`createAgentTool` 闭包捕获 workspaceRoot 与 engine.getProvider,**必须随引擎创建**;
- **workspace**:作为引擎**构造参数**;运行中换 workspace = **销毁重建引擎**(不走 setWorkspaceRoot——它漏重建 fileHistoryTracker,快照会写进旧 workspace 的 `.nexus/history`);
- **provider 缓存**:fingerprint = `activeProviderId|modelId|baseURL|apiKey|apiFormat|temperature`;config 保存 → **全量失效,下次 run() 开头惰性重建,禁止 mid-run setProvider**(run 中 query 已捕获 provider 引用);
- **事件注入咽喉**:sessionId/seq 在 SessionManager **转发处**统一注入(引擎构造期/轮次外事件拿不到 sessionId,转发处是 engine↔session 1:1 绑定的天然单一咽喉);`main/index.ts:302` 的裸 error 发送必须改走 SessionManager;`main/index.ts:277-280` awaiting_confirmation 卡死自动 abort 逻辑搬进 SessionManager per-session 化;
- **持久化上移**:SessionManager 在 **turn 终止时一次性批量写该 turn 全部消息**(废除 renderer 逐条 appendMessage IPC 往返;renderer 的 persistedMessageIdsRef 去重集合随之废除——G3 的"后台 pane 消息不落盘"由架构消除);
- **sessionStore 并发加固(G7/R13)**:`persistIndex` 加**单飞互斥(indexWriteQueue)+ 原子写(temp+rename)+ 100ms 防抖合并**;JSONL 追加路径不动(按会话分文件,appendFileSync 天然安全);
- 引擎懒创建 + 空闲保留;空闲超时 dispose(TODO,防长会话内存单调上涨)。

### 7.2 IPC 协议变更(硬切,无兼容窗口)

同包原子发布无版本偏斜,协议直接切;`AgentEvent.sessionId` 字段保留 optional 一个迭代(存量测试/MockLLMProvider 不改),renderer 对无 sessionId 事件按"忽略"处理。

| 通道 | 变更 |
|------|------|
| `agent:event-batch`(新) | 批量出站:`Array<{sessionId, seq, event}>`;event 本体与现 AgentEvent 同形,delta 为拼接增量(reducer 零改动的关键) |
| `agent:send-message` | 已带 sessionId;**不再改全局 workspace/重建共享 provider** |
| `agent:abort` / `agent:respond-approval` | 加 sessionId |
| `agent:set-permission-mode` / `agent:get-permission-mode` | 带 sessionId=单会话;不带=默认值语义(兼容现有 UI) |
| `perf:get-stats`(新,dev only) | send 计数/渲染计数输出(§8.3) |

### 7.3 delta 合帧(DeltaCoalescer,终审定稿)

- **合帧 key = (sessionId, 通道)**,通道 ∈ {`thinking_delta`, `message_delta`, `terminal_output`}(terminal_output 现为每 chunk 即发 `AgentEngine.ts:440-442`,8 路跑命令必洪峰,一并纳入);输出为**相邻同通道拼接后的增量 delta**——chatReducer 是增量追加语义,协议保持增量才能零改动;
- **FIFO 屏障(正确性关键)**:`tool_call_start/complete`、`status_change` 等结构化事件是**顺序屏障——透传前必须先 flush 同会话积压文本**;否则 thinking→text 相位切换乱序会造出错序 block(reducer 永远追加到最后一个同型 block);
- **全局单定时器 33ms**(非每会话一个):扫 Map(≤8 项)出站,**每 tick 一次批量 send**;renderer 一个 task 内分发全部 pane,吃满 React 19 自动批处理;
- **seq 挂信封层**(`{sessionId, seq, event}`),合并包 seq = 最后一个被合并源事件的 seq(计数器按源事件自增,天然无洞);v1 只做**去重与乱序告警**——不做"断档全量拉取"恢复(流中未落盘尾巴无可拉端点,拉了也拉不回);gap → 该 pane 标记 degraded 提示重试;
- 明确不做(过度设计):按帧 budget 截断/尾包补发、renderer 侧 RIC/useSyncExternalStore 调度层(输入速率已被主进程控住)、seq 复杂重同步。

---

## 8. 会话层设计(L1.5,renderer,终审定稿)

### 8.1 useSessionChat

```ts
// src/renderer/src/hooks/useSessionChat.ts
function useSessionChat(sessionId: string) {
  // 模块级事件总线:单订阅 agent:event-batch,按 sessionId 精确投递
  // Map<sessionId, Set<(e: AgentEvent) => void>>;listener 包 try/catch(单 pane 抛错不中断同 tick 分发)
  // unsubscribe 时 Set.size === 0 → Map.delete(sessionId)
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  useEffect(() => subscribe(sessionId, dispatch), [sessionId]);
  return { state, send, abort, ... };
}
```

- **chatReducer 零改动**(纯函数直接复用);
- ChatPane(`workspace/pane-content/ChatPane.tsx`)= 现 App.tsx 主区抽参数化:ChatTimeline + FloatingInputDock + scrollFollower + status 副作用,按 sessionId 隔离;
- **副作用分流(终审定稿,不能一刀切随 pane)**:

| 现状副作用(App.tsx) | 判定 | 去向 |
|---|---|---|
| 自动批准 approval_required(:280-284) | **集中** | 全局单例 responder 按 event.sessionId 调 respondApproval(pane 可被收回/卸载而 agent 继续跑,随 pane 挂载会让 pendingApprovals 永久挂起);**豁免 doc-conflict**(§6.2 规则 5) |
| saveActiveSession(:113-134) | **上移主进程** | SessionManager turn 终止批量写(§7.1) |
| refreshFiles(:251-279) | **集中 + 去抖** | 全局 300-500ms trailing debounce(现状每工具完成全量 scanDirectory 深度 3,8 会话 8 倍重复扫描) |
| status_change → setStatus | 随 pane | useSessionChat |
| docx_* → 开 Word/打开文件(:254-271) | 联动层 | §6.4 路由器单例 |

### 8.2 性能隔离(8 pane 流式的渲染纪律)

| 措施 | 说明 |
|------|------|
| 事件精确投递 | 会话 A 的 delta 只触发 A 的 reducer;B pane Profiler **零渲染记录**(验收项);合帧+批量后每 tick 每 pane 一次提交(React 自动批处理) |
| memo 边界 = **message 级** | reducer 对非活跃消息原样返回引用(chatReducer.ts:133/168),`memo(MessageRow)` 零成本命中;`normalizeMessageBlocks`(现为每帧对每条消息执行,ChatTimeline.tsx:139)下沉进 MessageRow 内部 useMemo;ActionStepRow 补 memo;**不做 block 级**(活跃消息 blocks 每 delta 新建,拦不住白付比较) |
| **流式渲染主链降本** | 现状 StreamingText 每帧 setState → MarkdownRenderer 因 content 每帧变化重算 → **每帧 marked.parse + DOMPurify + dangerouslySetInnerHTML**(O(块长)/帧,整流 O(n²))——8 路即 8×/帧,是比 React 提交更大的 CPU 项,叠加软件渲染(G5)即掉帧主因:**流式期间 MarkdownRenderer 降频重解析**(每 ~100ms 或 delta 间隔阈值),StreamingText 结束才全量渲染 |
| 打字机分级 | **非聚焦 pane 的 StreamingText 跳过插值直接显示 target**(~30 提交/s),聚焦 pane 保留 60fps 打字机——消除 8 路 rAF setState 风暴 |
| 隐藏 pane 降载 | **streamPacer"后台休眠"不是现成的**(rAF 是文档级,display:none 的 pane 在可见窗口内照跑;visibilitychange 只覆盖窗口最小化):RetainedPanel 显式接线——pane 不可见 → StreamingText cancel rAF + **暂停文本 delta dispatch**(结构化事件照常 dispatch,低频且影响状态机),重显 → 单 task 重放缓冲(reducer 追加语义天然接上)+ pacer flush 追平;同一 session 多 pane 时可见性取 OR(阶段一约定 session 单实例规避) |
| 长时间线窗口化 | ChatTimeline 加 `content-visibility: auto` **+ `contain-intrinsic-size: auto 300px`**(不设则屏外高度按 ~0 估,scrollHeight 低估 → scrollFollower 的 distanceFromBottom<80 启发式误判,跟随被误重启);回归"流式中上滚/回底"两条路径 |
| Word 单实例 | 同路径唯一挂载实例(内存大头);非活动 word tab 可选休眠(卸载编辑器留 tab) |

### 8.3 性能预算(验收指标,全部脚本化)

**前置决策(D9/R10)**:`main/index.ts:10-14` 已 `app.disableHardwareAcceleration()`——软件光栅下每帧 innerHTML 替换是 CPU 全量重绘。**阶段一开工前决策:恢复 GPU 合成(首选,需回归验证;当初禁用原因需先查明)或把重绘速率压入预算。**

- 8 pane 同时流式 + 拖拽:rAF 抖动 **max < 50ms 且 p99 < 34ms**(`window.__frameProbe` 探针,dev 构建注入;Playwright `_electron.launch` 附加);
- 单 pane 流式 10s,其余 pane **Profiler 计数增量为 0**(dev-only `<Profiler id={sessionId}>` 计数器;注明 dev 模式验收);
- IPC:**`webContents.send` 次数 < 60/s**(合帧+批量后理论 ~30/s;口径是 send 次数不是事件条数——8×30=240 条按条数永远过不了;main 侧包装计数,滚动 1s 窗口取峰值);
- 内存:`app.getAppMetrics()` 每 5s 采样求和,8 流式 + 3 Word 实例 soak 30 分钟峰值 < 1536MB;
- 负载可复现:扩展现成 MockLLMProvider 加 perf 模式(`__perf` 标记 → 合成 provider 固定速率发 delta + 周期 10KB 突发),CI 可跑。

---

## 9. 风险守门(v2,终审扩充)

| # | 风险 | 守门 |
|---|------|------|
| R1 | split 判父用错路径导致整树 remount | 父判定必须用完整 targetPath(单测覆盖:连续 split 不 remount) |
| R1b | 裸 root pane 首次 split 类型失配整树 remount | 根节点恒包合成 group(§4.1) |
| R2 | 持久化 schema 改名导致用户布局全丢 | zod strict 校验 + version + 字段禁改名;迁移必须写 migrate(§4.4) |
| R3 | 误关最后一个可见 pane | 只有 setPaneHidden 可收起;closePane/closeTab 最后一个拒绝 + toast(侧栏收回同门) |
| R4 | 无限分割 | MAX_TREE_DEPTH=4,超限拒绝 + toast |
| R5 | 嵌套 DndContext 抢事件 | 全应用唯一 DndContext;子列表经 DragPayload 协议接入 |
| R6 | 两个 agent 覆盖同一文档 | runGate in-flight 注册表 + doc-conflict 审批 + **renderer 自动批准豁免 doc-conflict**(§6.2 规则 5) |
| R7 | 8 路流式 IPC 洪峰 / 事件错序 | DeltaCoalescer:FIFO 屏障 + 批量通道 + 全局单定时器(§7.3);seq 去重告警 |
| R8 | Word 多实例内存膨胀 | 同路径单实例 + 休眠策略(§8.2) |
| R9 | 旧 localStorage 迁移破坏现有用户状态 | hydrate 后 bootstrap,首次落盘成功才删旧 key,旧 key 只读保留一个版本;失败逐 key 跳过不阻塞启动 |
| R10 | **硬件加速已禁用**,软件渲染扛不住 8 路流式 | 已决策:保持禁用(禁用原因是修窗口崩溃,commit 56f7fb6,贸然恢复会复活崩溃);以 §8.2 重绘降本补偿;GPU 恢复为独立 spike |
| R11 | docx live 分支跨文档覆写 + mcp-bridge 广播双写 + __aidocs 串实例 | §6.4 前置改造(path 寻址 + 实例过滤 + per-instance context);**完成前 Word 不入 pane** |
| R12 | 路径变体(大小写/短名/分隔符/file://)导致联动表 key 分裂 | shared/paths.ts 规范化契约,三入口统一 canonical(§6.3) |
| R13 | sessionStore index.json 并发写撕裂 | 单飞互斥 + 原子写(temp+rename)+ 防抖(§7.1) |
| R14 | SandboxGuard 锁死 workspace 外文档,联动核心场景失效 | "已打开文档目录"动态加入 allowedRoots,集中管理(阶段三随联动落地) |
| R15 | 拖拽结束原生 click 误激活 chip | justDraggedRef 吞 click(§5.2) |
| R16 | ResizeHandle 事件被 PointerSensor 抢走 | handle pointerdown stopPropagation + preventDefault(§4.1) |

---

## 10. 分阶段实施计划(v2)

### 阶段一:地基——多会话并发 + 布局树(含性能地基)`[ ]`

**前置决策**:R10 硬件加速(恢复 GPU 首选,查明当初禁用原因并回归)。

1. `shared/types.ts`:`AgentEvent` 加 optional `sessionId`;abort/审批/permissionMode IPC 加 sessionId;
2. 新建 `src/main/agent/SessionManager.ts`(§7.1 全部要点:workspace 构造参数、provider 指纹缓存、持久化上移、awaiting_confirmation per-session、main:302 裸 error 改道);
3. 新建 `src/main/agent/DeltaCoalescer.ts`(§7.3:通道合帧 + FIFO 屏障 + 批量通道 + 全局单定时器);
4. `sessionStore.persistIndex` 加固(单飞 + 原子写 + 防抖,R13);
5. `preload/index.ts` 同步签名(agent:event-batch 订阅等);
6. 新建 `hooks/useSessionChat.ts`(§8.1 事件总线)+ 副作用分流(全局 responder/refreshFiles 去抖);
7. 新建 `workspace/layout-model.ts`(§4.1/4.3 纯函数全集)+ `tab-registry.tsx`(先 chat kind)+ `layout-store.ts`(zustand+zod+hydration 门)+ `SplitRenderer.tsx`(§4.4:RetainedPanel、预览态拖宽、合成 group 根);
8. 新建 `workspace/pane-content/ChatPane.tsx`(§8.1),App.tsx **仅主区**换 SplitRenderer(RightAuxiliaryBar/TerminalView/TopBar 开关一行不改);迁移仅 `nexus_active_session_id → chat tab`(hydrate 后,首写成功才删);
9. 流式渲染降本落地(§8.2:MessageRow memo + normalizeMessageBlocks 下沉 + MarkdownRenderer 降频 + 打字机分级)+ ChatTimeline content-visibility + contain-intrinsic-size;
10. split/关闭先用 TabBar 按钮 + 快捷键(拖拽在阶段二);
11. 新增依赖:zustand(@dnd-kit/core 在阶段二);
12. 性能钩子:MockLLMProvider perf 模式 + __frameProbe + Profiler 计数 + send 计数(§8.3)。

**验收**:8 会话并发流式互不串扰(Profiler 验证);按钮 split/关闭/收起正常;拖宽 commit 后重启宽度恢复;连续 split 不 remount 已有 pane;重启布局恢复;`npm run typecheck` + 全量 vitest 零回归;新增单测:layout-model 全 mutation(含 R1/R1b remount、最后可见 pane 守门)、SessionManager 并发、事件路由与合帧(含 FIFO 屏障顺序)、persistIndex 原子性;性能指标四项脚本跑通。

### 阶段二:Snap 拖拽 + 左右互拖 `[ ]`

13. 新增依赖 `@dnd-kit/core`;单一 DndContext + DragOverlay + 统一 DragPayload(§5.1);
14. 拖源:侧栏条目(target)、tab chip;落点四类 + Snap 预览(§5.2:overlay 两层、指针选落点/中心点定位、collision 无兜底、resolveSplitDropPosition 纯函数);
15. Sidebar 通用收纳区(会话区/文档区,分区由注册表 sidebarSection 声明):任意 kind tab 收回/拖出;TabBar 横向滚动 + 右键/溢出菜单(§5.4);
16. 拖后 click 吞掉(R15)+ 性能守门落地(§5.3)。

**验收**:拖侧栏会话→预览→吸附成 pane→接上自己的流;pane 互拖 split/堆叠/重排;任意 tab 拖回对应分区收回(会话后台继续跑);拖拽全程 60fps(拖拽期间 layout store 零写入验证)。

### 阶段三:零配置联动 `[ ]`

17. **前置硬门槛(G6/R11,§6.4)**:docsBridge path 寻址(禁跨文档覆写)+ mcp-bridge 实例端 targetPath 过滤 + `__aidocs` per-instance 注册 + FileChangeHub 通知枢纽;
18. `shared/paths.ts` 规范化契约落地:三入口统一 canonical(§6.3/R12);
19. word kind 迁入 pane:WordEditorContainer 从 RightAuxiliaryBar 迁入注册表(RetainedPanel + memo 持久挂载;同路径单实例 + 可选休眠);RightAuxiliaryBar 退役;`nexus_sidebar_open`/`nexus_word_drawer_open` 迁移;
20. 联动状态与路由(§6.3/6.4):pathToTab 路由、落位策略、更新角标、lastTouch、问 AI 反向路由;
21. 取消联动三层(§6.5):chip ×、暂停跟随、不再自动打开抑制名单、清除记忆;
22. 拖拽即指定 + @ 提及骨架(§6.7):弹层/chip/过滤/键盘导航/兜底行/粘贴路径识别,注册表 `mentionSource` 接口就位;
23. 上下文预算器(§6.6):复用 buildDocumentContext,per-chip 骨架(打开→实例/未打开→main parseDocx 按 mtime 缓存),替换 App.tsx:358-379 单 activeDoc 注入;
24. 工具层防覆盖(§6.2 规则 5):runGate in-flight 注册表 + doc-conflict 审批 + **renderer 自动批准豁免 doc-conflict**;
25. SandboxGuard 动态 allowedRoots(R14:已打开文档目录集中管理);
26. 旧 `nexus_session_word_docs` 迁移(值过 normalizeKeyPath;旧 key 只读保留一版)。

**验收**:会话改论文→文档 pane 自动开/实时跟随/后台更新亮角标;10 文档并发改动各归各 pane(live 分支不串文档);问 AI 回对会话;长文档注入不超预算;暂停跟随/不再自动打开/清除记忆可操作且不影响 agent 运行;doc-conflict 确认不被自动批准跳过。

### 阶段四:agent↔agent 联动 `[ ]`

27. 委派消息协议(§6.6 L3):任务描述 + 源 sessionId + 精选片段,单条预算上限;接收方按需工具拉取细节;
28. composer @会话 / 拖会话 tab 到输入框 → 生成结构化委派(复用 §6.7 chip 体系);
29. 预留 `mode: 'coordinator'` 数据通路(本期 UI 从简)。

**验收**:两个 pane 的 agent 互发委派并回传摘要;全程上下文可控(委派消息有预算上限)。

---

## 11. 测试与交付纪律

- 每阶段:`npm run typecheck` + 全量 vitest 零回归 + 一次 git commit(含本文档状态更新);
- 新增测试分布:layout-model 纯函数全覆盖(R1/R1b remount、守门、sizes 同步)、DeltaCoalescer(FIFO 屏障顺序、拼接、seq)、SessionManager 并发、事件路由、resolveSplitDropPosition、computeResizeHandleSizes/clampNormalizedSizes、persistIndex 原子性、normalizeKeyPath/canonicalizePath、落位策略、lastTouch 路由;
- 性能四指标(§8.3)脚本化进 CI(dev 模式),手工验收记录回填各阶段验收小节。

## 12. 里程碑

| 里程碑 | 内容 | 量级 |
|--------|------|------|
| M1 | 阶段一完成:8 会话并行 + 可分割布局 + 性能指标达标 | 最大(引擎+布局双地基) |
| M2 | 阶段二完成:Snap 拖拽 + 全 tab 互拖可演示 | 中 |
| M3 | 阶段三完成:文档联动端到端(截图场景,含数据正确性前置) | 中 |
| M4 | 阶段四完成:agent 互协作 | 小 |

---

## 13. 终审记录(v1 → v2 修订依据)

三个独立评审对 v1 逐行终审(实读计划文档 + 现状代码 + paseo 参考实现),主要修正:

**性能渲染评审**:
- 发现 G5/R10:硬件加速已全局禁用,是 60fps 目标第一风险,v1 零字提及;
- 流式渲染主链每帧全量 markdown 重解析(O(n²))未被 v1 memo 清单覆盖 → §8.2 降频重解析;
- "streamPacer 后台休眠现成"结论错误(rAF 文档级)→ §8.2 显式接线 + 暂停 dispatch;
- 合帧协议重定义:通道级合帧 + FIFO 屏障(防 block 错序)+ 批量通道 + 全局单定时器;terminal_output 纳入;
- 副作用三分:自动批准集中、存盘上移主进程、refreshFiles 去抖(v1"随 pane 实例化"一刀切会导致 pendingApprovals 挂起和后台 pane 丢盘);
- 砍过度设计:RIC/useSyncExternalStore 调度层、seq 全量拉取恢复、帧预算截断、真虚拟化;
- 指标口径修正:<60 send 次数/s(非事件条数);四指标全部脚本化。

**布局拖拽评审**:
- 模型修正:pane 直接存 tabs 数组(不做 tabIds 镜像)、空 pane 不变量、补 openTabInLayout/reorderTabsInPane 两个缺失 mutation、树外 sizes 需随 split/remove 同步 splice(paseo 自身瑕疵,不照抄);
- 拖宽从"DOM 直改"改为"本地预览态覆盖"(双权威问题);
- 依赖面收缩:仅 @dnd-kit/core(不引 sortable);DragPayload 单轨化;collision 去掉 closestCenter 兜底;拖后 click 吞掉;
- 砍过度设计:TabBar chip 测量制→横向滚动、侧栏插入指示线→整分区高亮、手写校验→zod(已在依赖);
- 补欠设计:hydration 门、根节点合成 group(R1b)、ResizeHandle stopPropagation(R16)、阶段一不迁 word pane(消双表示回归)。

**引擎与数据正确性评审**:
- 发现 G6/R11:docx live 分支跨文档覆写 + mcp-bridge 广播双写 + __aidocs 串实例——多 pane 多文档下的确定性数据覆盖,列为阶段三前置硬门槛;
- 发现 G7/R13:sessionStore persistIndex 非原子并发撕裂(v1 称"sessionStore 零改动"不成立);
- 发现 G8/R14:SandboxGuard 锁死 workspace 外文档,联动核心场景失效;
- 路径契约落地:normalizeKeyPath + canonicalizePath 双层规范(v1"路径即身份证"未定义规范化,等于没契约);
- SessionManager 细化:workspace 作构造参数(setWorkspaceRoot 漏重建 fileHistoryTracker)、provider 指纹惰性重建(禁 mid-run setProvider)、事件注入选 SessionManager 转发处(单一咽喉)、不复用 SubagentEngine;
- 防覆盖检测放 runGate + in-flight 注册表(非时间窗);复用 pendingApprovals 但必须豁免 renderer 全量自动批准;
- 上下文预算:复用 buildDocumentContext(勿重写);迁移统一"旧 key 只读保留一版"(消除 v1 §4.4 与 R9 的矛盾表述)。
