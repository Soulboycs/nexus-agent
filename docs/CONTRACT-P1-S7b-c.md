# CONTRACT — S7b/S7c: SplitRenderer + TabBar + ChatPane + App 接线

- task_id: P1-S7b/S7c · 依据: 计划 §4.4/§8.1/§10 阶段一 · 待开工(S7a 已完成,E6)
- 测试: DOM 组件走 vitest(`tests/dom/**/*.domtest.tsx`,`npm run test:vitest`);逻辑回归走 `bun test tests/`

## S7b — 渲染组件(全部新文件,`src/renderer/src/workspace/`)

| 文件 | 职责 | 关键约束(计划 §4.1/4.4/§5.4) |
|------|------|------|
| `SplitRenderer.tsx` | 布局树递归渲染 | group→flex row/column + ResizeHandle(仅可见子项间,pointerdown stopPropagation);子项 flexBasis:0+minWidth/Height:0,宽度=归一化 flexGrow(hidden grow=0);渲染尺寸取 `sizesByGroupId[gid] ?? group.sizes`;pane→RetainedPanel(display:none 保活)+ TabBar + 内容;**根恒为合成 group(S2 已保证)**;节点 id 作 React key |
| `ResizeHandle.tsx` | 两阶段拖宽 | 拖动中本地 preview state(rAF 节流)覆盖 store 值,渲染 `preview ?? stored`;pointerup 才 `resizeSplit(gid, clamp(sizes))` + 清 preview;相邻对算法:Δratio 只分给相邻两格(双侧钳制 0.1) |
| `TabBar.tsx` | pane 顶部 tab 行 | chip(标题=注册表 title)点击=selectTab;活跃高亮;"+"菜单(新会话/打开文档→openTab);溢出菜单 Split Right/Down、Close pane;横向滚动 chip min-96/max-160 truncate(不做测量制);close 按钮=closeTab |
| `RetainedPanel.tsx` | 保活容器 | hidden→`display:none`(不卸载);始终渲染子树 |
| `pane-content/ChatPane.tsx` | 会话 pane 内容 | 从 App.tsx 主区抽参数化:ChatTimeline+FloatingInputDock+scrollFollower+status;**用 useSessionChat(sessionId)**(事件来自 sessionEventBus,不再由 App 单订阅分发);submitPrompt/abort/sendMessage 走 preload(带 sessionId) |
| `pane-content/WordPane.tsx` | 占位(阶段三实装) | 渲染"文档 pane 将在阶段三接入"占位,保证 tab-registry word kind 可注册 |

tab-registry(`tab-registry.tsx`):kind→{title,icon,component,sidebarSection} 映射;第一期 chat(Component=ChatPane)+ word(占位)。

### DOM 测试清单(G1–G6,vitest domtest)

G1 默认布局渲染出 1 个 pane + TabBar 1 chip · G2 按钮触发 store.splitPane → 2 pane(宽度 flex 断言) · G3 ResizeHandle 拖动改 flex/松手写 store(mock pointer events) · G4 tab 点击切换 focusedTabId · G5 closeTab 级联 · G6 ChatPane 挂载订阅 sessionEventBus(注入假批次,断言消息渲染)。

## S7c — App.tsx 接线 + 迁移

1. 主区(:644-702 的 `<main>`)替换为 `<SplitRenderer/>`;**RightAuxiliaryBar/TerminalView/TopBar/SettingsModal 一行不动**(阶段三才退役);
2. 启动接线(一次性):
   - `window.electronAPI.onAgentEventBatch(b => sessionEventBus.ingestBatch(b))`(App 级单订阅;**移除**旧 onAgentEvent 订阅及其全局 chatReducer/useReducer——chat 状态全部下沉 ChatPane);
   - 布局 hydration:`useLayoutStore.persist.onFinishHydration(() => { setHydrated(); migrateLegacy() })`;渲染门禁 `hydrated===true`;
   - `migrateLegacy()`:`nexus_active_session_id` → `bootstrapSession(id)` → 成功 persist 后删除旧 key;`nexus_sidebar_open/nexus_word_drawer_open` 原样保留(阶段三迁);
   - 自动批准 **全局 responder**(App 级单例:approval_required → bypass 模式时 respondApproval;阶段三加 doc-conflict 豁免);refreshFiles 全局 300-500ms trailing 去抖;
   - Sidebar `onSelectConversation` → `openTab({kind:'chat',sessionId})`(去重只聚焦);新建会话 → openTab 新 chat target;
   - `nexus-word-ask-ai`/`nexus-word-open-file` 等全局事件过渡期路由到"聚焦 pane 的会话"(阶段三接 lastTouch);
3. 全局单份状态处置:currentConversationId 由 `layout.focusedPaneId 所在 pane 的 focusedTab` 派生(useLayoutStore selector);statusRef 等随 ChatPane 实例化。

## 验收(阶段一收官,合并 S8)

8 会话并发流式互不串扰(Profiler/手测)、按钮 split/关闭/收起、拖宽重启恢复、`bun test tests/` + `npm run test:vitest` 全绿、`npm run dev` 手测单 pane 与双 pane 场景。

## 回滚

全部为新增文件;App.tsx 改动集中主区与启动接线,按 commit 粒度可单独回退。
