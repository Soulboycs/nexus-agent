# CONTRACT — S3 SessionManager + S4 persistIndex 加固

- task_id: P1-S3 / P1-S4 · 日期: 2026-09-20 · 计划依据: `docs/多Pane工作台实施计划.md` §7.1(R13)
- 测试文件: `tests/sessionManager.test.ts`(S3)、`tests/session_store_concurrent.test.ts`(S4)
- 门禁: `bun test tests/sessionManager.test.ts tests/session_store_concurrent.test.ts` + `bun test tests/` 零新增失败

## S3 — SessionManager(`src/main/agent/SessionManager.ts`,纯逻辑零 Electron 依赖)

依赖倒置:定义最小引擎接口 `SessionEngineLike extends EventEmitter { run/abort/respondApproval/setPermissionMode/getPermissionMode/getStatus }`——真实 `AgentEngine` 满足它;测试注入 fake,不依赖 LLM。

```ts
export interface SessionManagerOptions {
  createEngine: () => SessionEngineLike      // per-session 工厂(workspace/provider 由调用方烘焙)
  onOutbound: (batch: OutboundAgentEvent[]) => void
  flushIntervalMs?: number
}
class SessionManager {
  ensureEngine(sessionId): SessionEngineLike  // 懒创建:工厂→默认权限模式→订阅 event→coalescer.ingest
  has(sessionId): boolean
  getEngine(sessionId): SessionEngineLike | undefined
  async run(sessionId, prompt, opts?): Promise<unknown>
    // busy(thinking|tool_executing|awaiting_confirmation)→ throw `Session <id> is busy (<status>)`
    // 否则 engine.run(prompt, { sessionId, ...opts })
  abort(sessionId): boolean                   // 只路由到该引擎;无会话 false
  respondApproval(sessionId, callId, verdict): boolean
  setPermissionMode(sessionId, mode): void    // 仅该引擎
  setDefaultPermissionMode(mode): void        // 现存全部引擎 + 之后新建的引擎
  getPermissionMode(sessionId): PermissionMode | undefined
  flushAll(): void                            // 转发 coalescer(关停/测试用)
  dispose(): void                             // 停 coalescer 定时器
}
```

### 边界(C1–C8,先红后绿)

| # | 边界 |
|---|------|
| C1 | 懒创建:同 sessionId 复用同一引擎(工厂只调一次);未 run 过的会话 has=false |
| C2 | 引擎事件 → coalescer → onOutbound 携带正确 sessionId 与 seq(delta 需 flush 触发) |
| C3 | 两会话事件交错,sessionId/seq 互不串 |
| C4 | run 期间(状态 thinking)再次 run → reject 且消息含 sessionId;首 run 正常 resolve 后可再 run |
| C5 | abort('sA') 只调 sA 引擎的 abort |
| C6 | respondApproval 路由到正确引擎 |
| C7 | setPermissionMode(s1) 只影响 s1;setDefaultPermissionMode 影响现存+未来引擎 |
| C8 | dispose 后定时器不再触发 onOutbound |

## S4 — sessionStore.persistIndex 加固(改动 `src/main/session/sessionStore.ts` 单方法)

现状(G7/R13):`persistIndex` 非原子整文件 `fs.writeFile`,并发 append/listSessions 交错可撕裂 index.json。

改为:**单飞互斥队列(indexWriteQueue)+ `atomicWriteFile`(temp+rename,复用 `src/main/docx/atomic-write.ts`,Windows EPERM 重试已有)+ 快照序列化**(调用时刻取 JSON 快照入队,后续 mutations 不污染排队中的写)。**调用点签名不变**(7 处 `await persistIndex()` 语义保持"await 后已持久化"),失败仍吞掉并 console.error(appendMessage 不因 index 写失败而失败)。防抖暂不做:调用方 await 语义要求 durability,单飞已消除撕裂;防抖与 flush API 留待 IO 剖证需要时叠加(计划 §7.1 的偏差,记入 EVIDENCE)。

### 边界(D1–D3)

| # | 边界 |
|---|------|
| D1 | 8 会话 × 10 消息并发 append(Promise.all)→ 结束后 index.json 可解析、含全部 8 会话、目录无 `.tmp` 残留 |
| D2 | append 与 listSessions 交错竞跑 → 无异常、index 全程可解析 |
| D3 | 单会话 200 连发 → index 可解析、tmp 零残留 |

## 非目标

不做 IPC 接线(main/index.ts 改造在 S5);不做 turn 终止批量落盘(依赖真实引擎历史接线,S5 一并);不改 index.json schema。

## 回滚

S3 纯新增;S4 仅改 persistIndex 方法体,回滚 = 恢复原方法体。
