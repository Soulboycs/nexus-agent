# CONTRACT — S2: layout-model(布局树纯函数)

- task_id: P1-S2 · 日期: 2026-09-20 · 计划依据: `docs/多Pane工作台实施计划.md` §4.1/4.3
- 测试文件: `tests/layoutModel.test.ts` · 门禁: `bun test tests/layoutModel.test.ts` + `bun test tests/` 零新增失败
- 纯 TS,零 React/Electron 依赖(可被 bun 主门禁直接测试);`TabTarget` 类型定义在此处,tab-registry(.tsx)后续 re-export(对计划 §4.2 的小偏差,理由:纯函数层不应依赖 .tsx)

## API(新文件 `src/renderer/src/workspace/layout-model.ts`)

```ts
export type TabTarget = { kind:'chat'; sessionId:string } | { kind:'word'; path:string }
export type LayoutDirection = 'horizontal' | 'vertical'
export type SplitPosition = 'left'|'right'|'top'|'bottom'

export interface PaneTab { tabId: string; target: TabTarget; createdAt: number }
export interface PaneState { id: string; tabs: PaneTab[]; focusedTabId: string|null; hidden?: boolean }
export interface GroupNode { id: string; direction: LayoutDirection; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = { kind:'pane'; pane: PaneState } | { kind:'group'; group: GroupNode }
export interface WorkspaceLayout { root: LayoutNode; focusedPaneId: string|null }
export interface LayoutState { layout: WorkspaceLayout; sizesByGroupId: Record<string, number[]> }
export interface LayoutIds { tab(): string; pane(): string; group(): string }

createDefaultLayout(target: TabTarget, ids: LayoutIds): LayoutState
   // 根=合成 group(horizontal,[单 pane],sizes[1])——R1b:裸 pane root 首次 split 会整树 remount

// —— layout-only 操作(不改任何 group 的 children 数量)——
openTabInLayout(layout, target, opts?: { paneId?: string; afterTabId?: string }, ids): LayoutState | null
   // 去重:同 target(深度相等)已存在 → 只 select+focus,不新建 tab
focusPaneInLayout(layout, paneId): WorkspaceLayout        // pane 不存在 → 原样返回
selectTabInPaneInLayout(layout, paneId, tabId): WorkspaceLayout  // 不改 focusedPaneId
reorderTabsInPaneInLayout(layout, paneId, tabIds): WorkspaceLayout | null  // 非法排列 → null

// —— 涉及 group children 数量变化(必须同步树外 sizes)——
splitPaneInLayout(state, paneId, position, payload: { tabId?: string; target?: TabTarget }, ids):
   { state: LayoutState; paneId: string } | null
   // payload 二选一(都给/都不给 → null);tabId = 移动该 tab 进新 pane;target = 新建 tab
moveTabToPaneInLayout(state, tabId, toPaneId, afterTabId?, ids?): LayoutState | null
closeTabInLayout(state, tabId): LayoutState | null        // 最后可见 pane 的最后一个 tab → null(R3)
closePaneInLayout(state, paneId): LayoutState | null      // 最后可见 pane → null(R3)
setPaneHiddenInLayout(state, paneId, hidden): LayoutState | null  // 藏掉最后一个可见 pane → null

// —— 纯助手 ——
clampNormalizedSizes(sizes: number[], min?): number[]
normalizeLayout(raw: unknown): WorkspaceLayout | null     // 逐节点打捞;不可救 → null(调用方回默认)
collectAllPanes(node): PaneState[] / findPaneById(node, paneId): PaneState | null
```

## 不变量(每次操作后必须成立,测试逐条锁死)

1. `pane.tabs.length ≥ 1`(所有仍存在的 pane);
2. 树内 `group.sizes.length === children.length` 且和为 1;`sizesByGroupId[gid]` 若存在同样匹配;
3. 每个仍存在的 pane 的 `focusedTabId` 指向自己的某个 tab;`focusedPaneId` 指向存在的 pane;
4. **结构共享**:未被操作触及的 pane 节点引用不变(toBe)——这是 memo/不 remount 的正确性基础(R1);
5. group 深度 ≤ MAX_TREE_DEPTH=4,超限 split → null(R4);
6. split/remove 后单子 group 折叠,其 `sizesByGroupId` 条目删除。

## 行为细则(与 paseo 对齐处标注)

- **split 同向插入**:目标 pane 的父 group 方向与 position 推导方向一致 → 在父 group 内相邻插入,槽位对半(`sizes[i]=s/2`,插入 `s/2`;left/top 插前,right/bottom 插后);**树外 stored sizes 若存在,同样 splice**(v2 终审:paseo 自身在此失同步);
- **split 垂直包裹**:方向不一致 → 目标 pane 被包进新 group `[P, new]`(right/bottom)或 `[new, P]`(left/top),sizes [0.5,0.5];父 group children 数不变 → stored sizes 不动;
- **split 传 tabId**:先放置新 pane,再等价 moveTab(源 pane 若因此清空 → 走删除路径;源=目标 pane 时净效果 = "tab 移到旁边,旧空 pane 收掉");
- **remove(共享路径)**:splice child + 树内/树外 sizes 同步 splice → 按剩余比例归一化(sum=1) → 单子折叠递归向上 → focusedPaneId 失效回落首个可见 pane;
- **normalizeLayout 打捞面**:bare pane root 包合成 group(id 固定 `'root'`);单子 group 折叠;空 tabs pane 丢弃;非法 tab(unknown kind / 缺字段)丢弃;dangling focusedTabId/paneId 回落;children 空的 group 丢弃;sizes 长度失配 → 等分重置。信封级垃圾(非对象)→ null。

## 测试清单(B1–B16,先红后绿)

B1 默认布局形状/不变量 · B2 openTab 去重 · B3 openTab afterTabId 插入 · B4 同向 split(树内+树外 sizes 同步) · B5 split 带 target 新建 tab · B6 垂直包裹 split · **B7 R1 连续 split 原 pane 引用不变** · B8 closeTab 级联关 pane+折叠 / 最后可见守门 · B9 closePane 守门+sizes 清理 · B10 hide/unhide(最后可见守门;sizes 不动) · B11 reorder 合法/非法 · B12 clamp 各case · B13 深度上限 · B14 normalize 打捞各case+null · B15 moveTab(含源清空删除) · B16 stored sizes 存在时 split 的同步

## 非目标

不做渲染(zustand store/SplitRenderer 在 S7)、不做持久化 schema(zod 在 S7)、不做拖拽落位计算(阶段二)。

## 回滚

纯新增文件;回滚 = 删除 2 文件。
