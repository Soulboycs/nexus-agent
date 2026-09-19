# EVIDENCE — 多 Pane 工作台 P1(阶段一)

> 每切片一节:命令、结果、环境、局限。原始输出不粘贴全文,只记关键行;失败历史不删除,后续证据可 supersede。

## 环境

- Windows 10 (win32 10.0.19045) · bun 1.4.2 · 测试命令 `bun test tests/`(主门禁)
- 基线 commit `28da4a7` + 未提交工作区(与本次切片无关的既有改动,见 git status)

## E8 — S8 渲染降本 + 性能钩子 + 阶段一自动化门禁(2026-09-20)

**S8a 渲染降本(§8.2)**:
- MessageRow memo 化(chatReducer 非活跃消息引用稳定 → memo 命中),normalizeMessageBlocks 下沉行内 useMemo(原每帧×每条消息);
- StreamingText `instant` 直显模式(非聚焦 pane 跳过打字机/rAF,合帧后 ~30 提交/s),ChatPane 透传 `streamInstant={!active}`;
- ChatTimeline 消息行 `cv-auto`(content-visibility:auto + contain-intrinsic-size:auto 300px,防 scrollFollower 误判);
- DOM 测试 `tests/dom/render-cost.domtest.tsx` H1–H5:**5/5**。

**S8b 性能钩子(§8.3 可测化)**:
- `SendRateMeter`(主进程 send 次数口径,滚动 1s 峰值)+ `perf:get-stats` IPC;onOutbound 接线记录;
- `createPerfLoadProvider`(确定性合成负载:固定速率 + 周期 10KB 洪峰,不经真实 LLM);
- `perfProbe`(渲染):`window.__frameProbe`(rAF dt max/p99,Playwright 附加点)+ `window.__renderCounts`(React.Profiler per-pane 计数,跨 pane 零渲染断言基础);App dev-only 挂探针,SplitRenderer dev-only 包 Profiler;
- 测试:`perfHooks.test.ts` 4/4(bun)、`perfProbe.domtest.tsx` 3/3;过程记录:K1 首轮失败为测试自身窗口算术错误(峰值模型按轮询重写),实现未改。

**S8c 阶段一门禁(自动化部分)**:
- `bun test tests/` → **652 pass / 0 fail**(55.2s;含用户 WIP providerNegative——本轮已自愈)
- `npx vitest run` → **54 pass / 0 fail**(11 文件)
- `tsc tsconfig.node.json` 0 错(过滤存量 docx-engine)· `tsc tsconfig.web.json` 0 错(过滤存量 protected-render.ts/Ruler.tsx,均用户未提交 WIP)
- `npm run build`(electron-vite 生产构建)→ **✓ built in 6.40s**
- **未完成(诚实声明)**:实机 GUI 验收(8 会话压测的帧率/内存实测、拖宽重启恢复手测)——需用户 `npm run dev` 亲测,Playwright 未安装无法自动化。验收清单见 PLAN-P1 S8c。

## E7 — S7b/c SplitRenderer + ChatPane + App 接线(2026-09-20)

- 新增组件(全部 `src/renderer/src/workspace/`):SplitRenderer(递归树,可见子项 flexGrow 归一化 + 预览态拖宽)、ResizeHandle(pointer capture 两阶段 commit)、TabBar(横向滚动 chip + 菜单)、RetainedPanel(display:none 保活)、tab-registry + pane-content(ChatPane/WordPane 占位/registerBuiltinTabs)、pane-host-context
- App.tsx 手术:主区 → SplitRenderer(PaneHost 包裹、hydration 门);批量通道双订阅(总线 + 全局副作用);**bypass 自动批准上移为全局 responder**;refreshFiles 300ms 去抖;chat 状态/审批卡/落盘去重全部下沉 ChatPane(每 pane 独立);Sidebar 选择 → openTab(去重聚焦);旧 key 迁移(hydrate 后 bootstrapSession,延迟删旧 key);RightAuxiliaryBar/TerminalView/TopBar 原样保留
- 测试:`tests/dom/split-renderer.domtest.tsx`(G1–G6 + RetainedPanel)**8/8 全绿**;vitest DOM 套件整体 **46/46**;bun 主门禁 632 tests
- 过程记录(失败历史,不删):
  1. DOM 首轮 5/8:①**真缺陷**——store.splitPane 空 payload 被 S2"payload 二选一"契约拒绝,TabBar 分割菜单无效;修复:空载荷 = 分屏同内容(克隆聚焦 tab target,VS Code 语义)。②G6 打字机 pacing 时序(happy-dom rAF 单帧只显影部分文本),测试加 250ms 显影等待。
  2. typecheck 双项目(web 过滤存量 protected-render.ts / node 过滤存量 docx-engine)0 错误。
- **范围外发现(报告用户,未代修)**:bun 全量回归中 `tests/providerNegative.test.ts` 2 fail + 1 error(Anthropic 500 / Responses 503 测试)——根因是**用户未提交的 WIP** `src/main/agent/utils/providerHttp.ts`(`??` 未跟踪,会话开始后出现的共享 5xx 重试策略,2s×3 退避)使测试总时长超 bun 5s 默认超时;重试耗尽的最终抛错消息本身含状态码(契约满足)。修法建议:该测试文件 beforeEach 设 `NEXUS_PROVIDER_RETRY_DELAY_MS=0`(providerHttp 已预留此测试开关)。与本次切片无导入关系,不属本任务范围。
- 未验证(诚实声明):Electron GUI 实机启动(`npm run dev` 会弹出窗口)留待 S8 阶段一验收与用户一起做。

## E6 — S7a layout-store(2026-09-20)

- 新增依赖:zustand ^5.0.15(npm install;React 19 兼容)
- Red:模块不存在 → 实现 `src/renderer/src/workspace/layout-store.ts`
- Green:`bun test tests/layoutStore.test.ts` → **10 pass / 0 fail**(35 expect)
- 要点:zod strict 信封校验(未来版本/未知字段/坏树 → null 回默认,merge 层承载)+ normalizeLayout 打捞;node 测试环境注入 no-op storage(persist 真实生效在 Electron);bootstrapSession 占位替换幂等;`LAYOUT_PERSIST_KEY='nexus_workspace_layout'`/version 1 导出为 R2"字段禁改名"锚点
- 过程记录:tsc 抓出 bootstrap 里多余 openTabInLayout 调用的类型错误(去重语义下无效),删除简化;全量回归 **620 pass / 0 fail**
- 局限:persist 的 localStorage 真实读写、hydration 门在 Electron 运行时验证(归 S7c/S8)

## E5 — S6 sessionEventBus + useSessionChat(2026-09-20)

- 契约:tests/sessionEventBus.test.ts 头注(E1–E6)
- Red:模块不存在(先红)→ 实现 `src/renderer/src/utils/sessionEventBus.ts`
- Green:**7 pass / 0 fail**(订阅/多监听者/隔离/抛错不中断/退订清理/seq 去重+断档告警)
- `src/renderer/src/hooks/useSessionChat.ts`:薄胶水(useReducer + subscribe),逻辑由总线测试与 S7 DOM 测试承载
- typecheck:web 范围 0 错(过滤存量 protected-render.ts)

## E4 — S5 IPC/preload 接线(2026-09-20)

- SessionManager 补充语义(C6b/C9–C12,先红后绿):respondApprovalByCallId(callId→最近审批会话路由)、dropEngine、abortAll、fail(sessionId 注入 error)、getDefaultPermissionMode、awaiting_confirmation 自动 abort 后继续(原 main:282 逻辑 per-session 化)→ `sessionManager.test.ts` **13 pass / 0 fail**
- `src/main/index.ts` 重写接线:单 engine → SessionManager(工厂 pendingCreateCtx 烘焙 workspace+config;onOutbound → `agent:event-batch`);send-message 按 workspace/provider 指纹销毁重建引擎(忙则推迟,禁 mid-run setProvider);save-config → 指纹全量失效;abort=abortAll、审批按 callId 路由、权限模式=默认值语义;workspace:select-folder 不再 setWorkspaceRoot(引擎 per-session)
- `src/preload/index.ts`:onAgentEventBatch(原始批量)+ onAgentEvent(旧签名,批量通道派生)——传输层单通道
- `src/shared/types.ts`:AgentEvent 增加 optional sessionId 引用注释在 IElectronAPI(onAgentEventBatch 声明)
- 验证:`bun test tests/` → **610 pass / 0 fail**(62.5s);tsc node 范围 0 错
- 存量问题记录(非本次范围,已报告):
  - `src/packages/docx-engine/parse-styles.ts:609`(GenOffice 未提交工作)类型错误
  - `src/renderer/src/components/word/editor/protected-render.ts:30`(`??` 未跟踪文件)语法错误
- 未验证(诚实声明):Electron 主/渲染进程实际运行(IPC 往返、批量通道、引擎重建)未做运行时手测——归阶段一验收(S8)

## E3 — S3 SessionManager + S4 persistIndex 加固(2026-09-20)

- 契约:`docs/CONTRACT-P1-S3-S4.md`(C1–C8 / D1–D3)
- Red:`bun test tests/sessionManager.test.ts` → 模块不存在(S4 的 D1–D3 修复前即过——撕裂窗口为概率性,无法确定性复现;此三条定位为**新不变量的回归守卫**,修复价值由代码分析支撑:persistIndex 非原子整文件写,异步交错无互斥)
- 实现:`src/main/agent/SessionManager.ts`(新增)+ `sessionStore.ts` persistIndex 方法体(单飞队列 indexWriteQueue + atomicWriteFile temp+rename + 调用时刻快照;7 个调用点签名/语义零改动;防抖暂缓——调用方 await 要求 durability,单飞已消撕裂,偏差记录在案)
- Green:三套件 `bun test tests/sessionManager.test.ts tests/session_store_concurrent.test.ts tests/deltaCoalescer.test.ts` → **27 pass / 0 fail**
- 过程记录(失败历史,不删):
  1. **真实现 bug(S1 回归捕获)**:DeltaCoalescer.dispose 后 SessionManager 的引擎监听器仍会 ingest → ensureTimer 复活定时器(dispose 形同虚设,C8 抓出)。修复:DeltaCoalescer 增加 disposed 旗标,ensureTimer 守门。
  2. C7 测试断言与注释自相矛盾(期望 bypass 但语义即全局覆盖);按全局开关语义(兼容现有单开关 UI:默认值覆盖一切现存引擎)修正断言为 plan。
- 回归:`bun test tests/` → **575 pass / 0 fail**(65.0s) · `tsc -p tsconfig.node.json` → 0 错误
- 局限:SessionManager 用 fake 引擎测试(接口倒置);真实 AgentEngine 接线在 S5,Electron 运行时行为在阶段一验收手测。

## E2 — S2 layout-model(2026-09-20)

- 契约:`docs/CONTRACT-P1-S2-layout-model.md`(B1–B16 + 不变量 1–6)
- Red:`bun test tests/layoutModel.test.ts` → 模块不存在(先红)
- 实现:`src/renderer/src/workspace/layout-model.ts`(新增 ~470 行纯函数,零 React/Electron 依赖)
- Green:`bun test tests/layoutModel.test.ts` → **23 pass / 0 fail**(188 expect)
- 过程记录(失败历史,不删):
  1. 首轮 19/23。**真实现 bug ×1**:垂直包裹 split 把整棵 root 节点当作被包裹子节点塞进 wrap(B6 抓出;B7 曾凭损坏树侥幸通过——正好证明"单测全绿≠正确",多角度断言的必要性);修复为引用 `parentGroup.children[index]`。
  2. sizes 语义澄清:树内 sizes=默认值、树外 stored=用户权威值,渲染取 `stored ?? tree`(paseo 同构);B16 测试原断言树内值,修正为断言 stored。
  3. remove 后 stored 修复策略:丢弃改为"以正确 splice 的树内 sizes 修复 stored"(B16b 抓出 undefined)。
  4. 测试侧修正 3 处:openTab 返回 WorkspaceLayout 的调用点、moveTab afterTabId 语义(插在其后)、clamp 浮点断言改 toBeCloseTo。
- typecheck:`npx tsc --noEmit -p tsconfig.web.json` → 0 错误
- 回归:`bun test tests/` → **558 pass / 0 fail**(65.3s;E1 中的 DeepSeek E2E 本次网络恢复亦通过,全绿)

## E1 — S1 DeltaCoalescer(2026-09-20)

- 契约:`docs/CONTRACT-P1-S1-delta-coalescer.md`(A1–A10)
- Red:`bun test tests/deltaCoalescer.test.ts` → `Cannot find module '../src/main/agent/DeltaCoalescer'`(1 fail,确认先红)
- 实现:`src/main/agent/DeltaCoalescer.ts`(新增,纯逻辑零 Electron 依赖)
- Green:`bun test tests/deltaCoalescer.test.ts` → **16 pass / 0 fail**(33 expect)
- 过程记录:首轮 15/16,失败项为 **测试自身断言算术错误**(A4 场景总数应为 3:屏障批 2 + flushAll 补发 1; CONTRACT 语义"b 下次 flush 才出站"与实现一致),修正测试断言后全绿。实现未改动。
- 回归:`bun test tests/` → **533 pass / 1 fail**(61.9s)
  - 唯一失败:`E2E — Real Live Streaming, TTFT & TPS Performance > measures real DeepSeek TTFT...`(需真实 DeepSeek API 网络;日志 `[LLMProvider] Request failed`)
  - 判定:**存量环境性失败,与本切片无关**——本切片仅新增 2 个文件(`DeltaCoalescer.ts`、`deltaCoalescer.test.ts`),未修改任何现有文件;该测试不导入新增模块。
- 局限:S1 仅验证合帧器纯逻辑;IPC 接线与 60fps 实测在 S5/S8。

## E0 — 方案事实核查(2026-09-20)

- 逐条对照代码验证 v2 计划的关键声明,全部属实(部分行号 ±10 漂移,机制无误):硬件加速禁用(`main/index.ts:10`)、单 engine(:28)、busy throw、AgentEvent 无 sessionId(`types.ts:58`)、chatReducer 增量追加、buildDocumentContext 8000 字符预算、docxTools live 分支跨路径 save(:201/348/578/622/719)、docsBridge 首包优先、SandboxGuard 锁 workspace、bypass 自动批准、zod 已在依赖(:49)。
- **R10 关键发现**:`git log -S disableHardwareAcceleration` → commit `56f7fb6 "fix: Disable hardware acceleration to resolve window crash & add crash logger"`——禁用是为修窗口崩溃。D9 裁定:保持禁用,GPU 恢复为独立 spike(已写入计划 v2)。

## E9 — 阶段二 Snap 拖拽(2026-09-20)

- 落点几何纯函数 `drag-geometry.ts`(edge 0.15/center 0.40/最近边回落 + chip 插入索引):`tests/dragGeometry.test.ts` **7/7**(过程:2 处测试用例与契约不符已修,实现未改)
- WorkspaceDnd:全应用唯一 DndContext(PointerSensor distance 8,activationConstraint)、三类 droppable 优先级 collision(tab-chip > pane-drop > sidebar-section,无兜底)、DragOverlay、预览经 context 下发;TabBar chip useDraggable+useDroppable+拖后 click 吞掉(R15);pane PaneDropZone+DropPreviewOverlay(两层:半透明填充+描边);Sidebar 会话行 useDraggable(重命名态免监听)+ SidebarDropZone 收回
- TabBar 右键菜单(关闭/关闭其他/关闭右侧);快捷键 Ctrl+\ / Ctrl+Shift+\ / Ctrl+W

## E10 — 阶段三 零配置联动(2026-09-20)

- P3-a `shared/paths.ts` 契约(normalizeKeyPath/canonicalizePath;WSL 例外=保留大小写):4/4;过程:file:// 剥除残留盘符斜杠、WSL 语义修正(Linux 大小写敏感,整体保留)
- P3-b R11:docsBridge 路径注册表(path→wcId,mcp-ready 携带 path)+ `runDocsCommandForPath`(无实例即抛→离线分支);docxTools **12 个 live 调用点**全部按路径寻址;**mcp-bridge 实例端 targetPath 过滤**(消灭广播双写);实例内切文档 1.5s 重报自愈;FileChangeHub(50ms 合并)+ docs:save 接线
- P3-c:linkage-store(pathToTab/lastTouch/角标/暂停跟随/抑制/panePreference/旧映射迁移)5/5;WordPane 单实例宿主(DOM reparent,防双实例);RightAuxiliaryBar 撤编辑器挂载;ChatPane docx_ 事件→lastTouch+word tab 自动打开(抑制名单跳过);TabBar word 角标;App:file-changed→角标、问AI lastTouch 反路由(§6.4)、bootstrapFromLegacy
- P3-e:DocConflictDetector(in-flight 注册表,精确重叠)3/3 + query.ts runGate 门(偏差:采用明确拒绝而非审批确认,记录于代码注释与本文档);SandboxGuard 动态 allowedRoots(docsBridge 注册文档目录时放行,R14)
- 过程:zustand getState 快照陈旧(测试侧修)、wordHost require→静态导入、word/App 具名导出、FloatingInputDock JSX 插入语法错误(手工修复)

## E11 — 阶段四 agent↔agent 委派(2026-09-20)

- `mentions.ts` 纯函数(extractMentionQuery/filterMentionCandidates/resolveMentions):5/5
- FloatingInputDock @ 弹层(💬会话/📄文档,点击插入);ChatPane 提交解析:@会话 → 结构化委派消息(带来源 sessionId 标注)发给目标会话并聚焦其 pane;@文档 → 上下文路径
- 门禁:bun **704 pass / 0 fail** · vitest **59/59** · 双 typecheck 干净 · `npm run build` ✓ 6.39s
- 范围外修复:tests/providerNegative.test.ts 增加重试环境快路+恢复(用户 WIP providerHttp 重试风暴超 bun 5s 超时;env 进程级泄漏已用保存/恢复修复 R2/R4 交叉失败)
- 偏差与限制(诚实):委派为全文转发非摘要压缩;@ 提及无键盘导航(点击选择);doc-conflict 为拒绝非审批;上下文预算未接 token 计数(骨架器自带 8000 字符上限);终端/浏览器/概览 pane 未注册;实机 GUI 8 会话压测待手测

## E12 — 评审整改(响应 Reviewer A/B,2026-09-20)

针对两份独立评审的 FAIL/PARTIAL 项,已逐项整改:

| 评审项 | 整改 | 验证 |
|---|---|---|
| 取消联动三层不可操作(store-only) | TabBar 右键菜单(仅 word tab):暂停跟随/恢复跟随、不再自动打开、清除最近操作记忆 | TS+人工入口(角标/免打扰语义不变) |
| 落位策略缺失(openTab 抢聚焦 pane) | placeWordTab:panePreference 存活→用它;否则本会话 pane 右侧 split+记忆;兜底聚焦 | 代码+TS |
| @仅文档上下文被丢弃 | 非委派路径 docPaths 注入【涉及文档】 | TS |
| allowDocRoot 死代码(R14 失实) | docsBridge.registerDocPath → allowDocRoot(dirname)(已打开文档目录动态放行) | 代码+TS |
| docConflict 登记泄漏(流中断路径) | releaseSession(sid) 于 run finally | 单测 3/3 |
| abort 无 per-session | agent:abort(sid?) + preload + ChatPane 传 sid;无参=全量(旧语义) | 代码+TS |
| 持久化不上移(pane 收回丢转录) | 双保险:ChatPane 卸载冲刷 + persist owner 所有权(renderer 声明存续期,main onTurnEnd 兜底落盘,确定性 id 幂等) | 代码+TS |
| MarkdownRenderer 每帧重解析(O(n²) 主链) | StreamingText pacer 提交节流 90ms(打字机 60fps 不变,解析 ~11fps),instant 路径已直显 | 测试 H 系列回归 |
| chip 插入恒后插 + 无 pill 预览 | computeChipInsertion 接入 onDragOver(中心点 before/after)+ TabBar 4px pill;model moveTab 增加 front 前插 | TS+DOM |
| providerNegative 超时(用户 WIP providerHttp 10 次重试风暴) | 测试文件设快路 env(锁定 3 次)+进程级保存/恢复(修复 R2/R4 交叉污染) | 4/4 |

整改后门禁:`bun test tests/` **718 pass / 0 fail** · vitest **59/59** · 双 typecheck 干净(过滤用户 WIP:fileTools aliases 重复键为用户进行中改动,非本任务范围,已提醒)

## E13 — 附录 T:标签页工具类型补齐(2026-09-20)

- 终端:主进程 `shellService.ts`(cmd /Q /K 常驻管道 shell + cd 同步)+ TerminalView 行模式(本地回显/退格,回车发整行)+ pane 变体(占满容器);与底部抽屉共享 shell。限制:无 TTY 无全屏程序(诚实标注)。
- 浏览器:`webviewTag: true`(main webPreferences)+ BrowserPane(webview + 地址栏/后退);同 URL openTab 去重。
- 审查:ReviewPane 真实数据(工作区顶层文件树 + 会话摘要,readWorkspaceFiles/listSessions)。
- 注册表:三种 kind 注册 newCard/onCreateInTab/mentionSource 扩展点;isValidTarget 接受新 kind;T 系列测试(layoutModel 26/26)。
- 门禁:bun **727 pass / 0 fail** · vitest **59/59** · 双 typecheck 干净 · build ✓ 6.44s。
