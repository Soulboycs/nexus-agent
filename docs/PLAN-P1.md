# P1 任务拆分(多 Pane 工作台 · 阶段一:地基)

> 依据:`docs/多Pane工作台实施计划.md`(v2 定稿)§10 阶段一。
> 模式:evidence-driven;每切片先写 CONTRACT + 失败测试(red),再实现(green),证据记入 `docs/EVIDENCE.md`。
> 状态:`未开始` / `red`(测试已写待实现) / `green`(切片测试通过) / `集成验证` / `完成`。

## 切片与依赖

| ID | 切片 | 内容 | 依赖 | 状态 |
|----|------|------|------|------|
| S1 | DeltaCoalescer | 主进程 delta 合帧器:3 通道拼接、FIFO 屏障、seq 信封、批量出站(计划 §7.3) | 无 | **green**(E1,16/16 + 全量回归*) |
| S2 | layout-model | 布局树纯函数:normalize/openTab(去重)/split/move/reorder/close/hide 守门/clamp/sizes 同步(§4.1/4.3) | 无 | **green**(E2,23/23,typecheck 0 错) |
| S3 | SessionManager | Map<sessionId,Engine> 并发生命周期、事件 sessionId 注入咽喉、provider 指纹缓存、turn 终止批量落盘(§7.1) | S1 | **green**(E3;provider 缓存与落盘接线归 S5) |
| S4 | sessionStore persistIndex 加固 | 单飞互斥 + 原子写(temp+rename)+ 防抖(R13) | 无 | **green**(E3;防抖暂缓,单飞已消撕裂) |
| S5 | IPC/preload 接线 | shared/types 加 sessionId、agent:event-batch 通道、preload 签名(§7.2) | S1,S3 | **green**(E4;运行时手测归 S8 验收) |
| S6 | useSessionChat + 事件总线 | renderer 按 sessionId 精确投递 + 副作用分流(§8.1) | S5 | **green**(E5;副作用分流随 S7 App 接线落地) |
| S7 | layout-store + SplitRenderer + ChatPane | zustand+zod 持久化、递归渲染、RetainedPanel、TabBar 按钮/快捷键、App 主区替换、迁移(§4.4/§8.1) | S2,S6 | **green**(E6+E7:DOM 8/8、vitest 46/46、双项目 typecheck 0 错) |
| S8 | 渲染降本 + 性能钩子 + 阶段一验收 | MessageRow memo、markdown 降频、打字机分级、content-visibility、__frameProbe/send 计数(§8.2/8.3) | S7 | **自动化全绿**(E8:652 bun + 54 vitest + build ✓);实机 GUI 验收待用户(`npm run dev`) |

## S8c 实机验收清单(需用户执行)

1. `npm run dev` 启动 → 单 chat pane 正常渲染,历史会话装载;
2. TabBar"…"→ 右侧分割 → 新 pane 用 Sidebar 切另一会话 → 两 pane **同时**发消息,各自流式互不串扰;
3. 拖宽分隔条 → 重启应用 → 宽度恢复(两阶段 commit 持久化);
4. 多会话压测(可选):8 个会话各发一条长任务,观察流畅度;DevTools console 执行 `__frameProbe.stats()` 看 max/p99;
5. 关闭其中一个 pane(菜单"关闭此窗格")→ 另一 pane 流式不断;
6. Tab 点击切换、"+"新建、拖宽中不闪跳(preview 态生效)。

## 已定决策记录

- **D9/R10 已裁(2026-09-20)**:硬件加速保持禁用——git 考古证实禁用是为修窗口崩溃(commit `56f7fb6`),恢复需独立 spike;60fps 由渲染降本承担。
- S1 与 S2 无依赖,可独立 TDD;S3 依赖 S1(合帧器是 SessionManager 的事件管道组件)。

## 验证命令

- 主门禁:`bun test tests/`(全部零回归)
- DOM 套件:`npm run test:vitest`(tests/dom/**/*.domtest.tsx)
- 类型:`npm run typecheck`
