# 契约: 工具并发编排器 (ToolOrchestrator) 与 异步生成器状态机 (query)

## 1. 契约范围与目标
本契约定义 Agent 核心运行循环与工具调度器的边界规范，对标 `D:\claude code` 的 `src/query.ts` 与 `src/services/tools/toolOrchestration.ts`。

---

## 2. 工具分类与元数据契约 (`ToolTypes.ts`)

### 2.1 属性定义
每个注册工具必须显式声明或继承以下元数据行为：
- `isReadOnly(args)`: 纯只读工具（无副作用、不修改文件系统或系统状态），返回 `true`。
- `isConcurrencySafe(args)`: 并发安全工具（可与其他只读工具在同一微任务批次内并行执行），返回 `true`。
- `isDestructive(args)`: 破坏性操作（如删除文件、kill 进程、覆写配置），必须强制触发审批。
- `requiresApproval(args)`: 门禁拦截函数，返回 `true` 时 Agent 必须挂起并等待人工响应。

### 2.2 默认安全策略 (Fail-Closed)
如果工具未声明上述方法，默认策略一律为：
```typescript
isReadOnly: () => false,
isConcurrencySafe: () => false,
isDestructive: () => false
```

---

## 3. 工具并发编排调度契约 (`ToolOrchestrator.ts`)

### 3.1 分区算法 (`partition`)
- **输入**: 单轮模型产出的工具调用列表 `ToolCallSpec[]`。
- **输出**: `ToolBatch[]`，其中连续的 `isConcurrencySafe === true` 的工具调用必须被合并到同一个 Batch；任何 `isConcurrencySafe === false` 的工具必须作为一个独立的单元素 Batch。
- **不变量 (Invariants)**:
  1. 所有工具执行的整体顺序严格保持原有相对顺序。
  2. 任意两个修改类工具绝不允许出现在同一个 Batch 中。

### 3.2 执行算法 (`executeBatches`)
- **并发批次 (`isConcurrencySafe === true`)**:
  - 使用有界 Promise 池执行，并发上限 `maxConcurrency = 10`。
  - 任意一个工具抛出异常，捕获为 `isError: true` 的 `ToolResultPayload`，不能导致整个批次未完成的工具崩溃。
- **串行批次 (`isConcurrencySafe === false`)**:
  - 严格通过 `await` 按次序串行调用。

---

## 4. 异步生成器状态机契约 (`query.ts`)

### 4.1 循环驱动模型
- 摒弃递归调用，采用 `while(true)` + 状态平铺替换：
```typescript
state = {
  messages: [...messages, assistantMsg, ...toolResults],
  turnCount: turnCount + 1,
  transition: 'next_turn'
}
```
- 每次迭代前检查 `turnCount > maxTurns`，若超限产出终止元数据并退出。
- 每次迭代前检查 `signal.aborted`，若被终止立即中断并优雅退出。

### 4.2 人工审查门禁 (HITL)
- 当工具满足 `requiresApproval(args) === true` 时：
  1. 状态机产生 `{ type: 'status_change', status: 'awaiting_confirmation' }`。
  2. 状态机产生 `{ type: 'approval_required', request: ApprovalRequest }`。
  3. 状态机挂起，等待 `onApprovalRequired` Promise resolve。
  4. 若返回 `false`（驳回）：不执行工具，直接回填 `{ isError: true, error: 'Execution cancelled by user.' }` 给上下文，保证模型能够感知并修正。
  5. 若返回 `true`（批准）：正常派发执行。

---

## 5. 验收测试命令
```powershell
& "C:\Users\Administrator\.bun\bin\bun.exe" test tests/orchestrator.test.ts
& "C:\Users\Administrator\.bun\bin\bun.exe" test tests/queryEngine.test.ts
```
