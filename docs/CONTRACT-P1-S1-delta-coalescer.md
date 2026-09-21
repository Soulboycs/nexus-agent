# CONTRACT — S1: DeltaCoalescer(主进程 delta 合帧器)

- task_id: P1-S1
- 日期: 2026-09-20 · 基线 commit: `28da4a7`(未提交的工作区改动见 git status)
- 计划依据: `docs/多Pane工作台实施计划.md` §7.3;终审记录 §13(性能评审)
- 测试文件: `tests/deltaCoalescer.test.ts` · 门禁命令: `bun test tests/deltaCoalescer.test.ts` + `bun test tests/` 零回归

## 用户可观察行为(最终)

8 个会话并发流式时,渲染进程收到的 IPC `send` 次数从 ~240/s 降到 ~30/s,而 chatReducer 收到的事件序列语义与不合帧时完全等价(文本可拼接、顺序不乱)。

## API(新文件 `src/main/agent/DeltaCoalescer.ts`,纯逻辑,禁止 import Electron)

```ts
import type { AgentEvent } from '../../shared/types'

export interface OutboundAgentEvent { sessionId: string; seq: number; event: AgentEvent }

export interface DeltaCoalescerOptions {
  onBatch: (batch: OutboundAgentEvent[]) => void
  flushIntervalMs?: number   // 默认 33
}

export class DeltaCoalescer {
  constructor(options: DeltaCoalescerOptions)
  ingest(sessionId: string, event: AgentEvent): void
  flushAll(): void    // 同步清空所有积压桶并一次性 onBatch
  dispose(): void     // 停止定时器;不 flush
}
```

## 合帧通道白名单(只有这三种合并)

| 事件 | 合并键 | 拼接字段 |
|------|--------|----------|
| `thinking_delta` | (sessionId, 'thinking_delta') | `delta` |
| `message_delta` | (sessionId, 'message_delta') | `delta` |
| `terminal_output` | (sessionId, 'terminal_output') | `chunk` |

**白名单外的一切事件(含 `tool_call_output`、未来新增类型)按结构化事件处理(fail-closed)。**

## 可执行边界(每条 = 一个测试;测试先写,先红后绿)

| # | 边界 | 通过条件 |
|---|------|----------|
| A1 | 同通道拼接 | 3 个连续 `thinking_delta`('a','b','c') flush 后恰好 1 个出站事件 `delta==='abc'` |
| A2 | 通道不互拼 | `thinking_delta('a')` 后 `message_delta('b')` → 2 个事件,顺序 thinking 在前 |
| A3 | terminal_output 按 chunk 拼接 | 2 个 chunk → 1 个事件 `chunk==='xy'` |
| A4 | FIFO 屏障 | `thinking('a') → tool_call_start → thinking('b')`:同批出站顺序为 `[thinking'a', tool_call_start]`;`'b'` 仍在桶中(下次 flush 才出) |
| A5 | seq 规则 | 每会话单调递增、按**源事件**分配;合并包 seq = 最后一个被合并源事件的 seq;结构化事件各占一个 seq;两会话计数器独立 |
| A6 | 跨会话隔离 | A 的屏障只 flush A 的桶,B 的积压不受影响 |
| A7 | 批量与不重复 | 多会话事件同批交付;flushAll 后定时器再触发不得重复交付(空批不调用 onBatch) |
| A8 | 空文本丢弃 | `delta:''` / `chunk:''` 不产生任何出站事件 |
| A9 | 屏障全覆盖 | `status_change`、`error`、`tool_call_complete`、`tool_call_output` 均先 flush 本会话积压再自占一个出站位 |
| A10 | 定时器路径 | 小 flushIntervalMs 下等待后 onBatch 被调用;dispose 后不再调用 |

## 非目标

不做 IPC 接线(S5)、不做 renderer seq 校验、不合并 `tool_call_output`(v1 屏障,有证据显示洪峰再议)、不落盘。

## 失败/回滚

纯新增文件,无调用方;回滚 = 删除文件 + 测试。测试失败即门禁失败,不允许跳过(skipped 测试计为失败)。
