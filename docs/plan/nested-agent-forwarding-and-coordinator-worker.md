# 嵌套 Agent 结果转发与 Coordinator Worker 恢复计划

## 1. 文档状态

- **类型**：实施计划
- **状态**：待实施
- **日期**：2026-08-01
- **适用范围**：本地 Agent、Coordinator 模式、后台 Agent、任务通知队列和 Coordinator UI
- **当前版本基线**：当前工作树 `master`，项目已包含 `LocalAgentTask`、Coordinator 和嵌套 Agent 相关实现
- **证据边界**：本计划基于当前源码、架构文档、测试和 `recover/claude-v2.1.165.js` 的历史实现；实施前仍需重新检查调用点和测试状态

本计划解决两个相互关联但应分开处理的问题：

1. 嵌套 Agent 完成结果没有可靠地投递给直接父 Agent，可能进入 Coordinator 主线程并造成重复或错位显示。
2. Coordinator 模式下 `workerAgent.ts` 返回空数组，导致系统提示要求使用的 `worker` Agent 无法解析。

本计划不直接修改生产代码，也不以 UI 文本去重替代运行时消息路由修复。

---

## 2. 目标与非目标

### 2.1 目标

1. 建立清晰的父子 Agent 结果关系：
   - child Agent 保存 `parentAgentId`；
   - child 完成通知通过队列的 `agentId` 投递给直接父 Agent；
   - 父 Agent 已结束时，通知才升级到主线程。
2. 保证一个终态任务只生成一次 terminal `task-notification`。
3. 阻止尚未完成的 tool call 被包装为 `completed`。
4. 恢复 Coordinator 模式所需的内置 `worker` Agent。
5. 让 Coordinator UI 展示任务状态聚合，而不是重复解释同一份结果内容。
6. 为本地 query、后台任务、stream-json/SDK 和 UI 建立可回归的验证矩阵。

### 2.2 非目标

本阶段不做以下工作：

- 不重新设计整个 `TaskStatus` 状态机。
- 不立即引入跨所有展示面的全局 result digest 或复杂事件总线。
- 不依赖 `parent_tool_use_id` 作为嵌套关系的唯一依据。
- 不把完整子 Agent 文本复制到 Coordinator UI。
- 不在第一阶段强制禁止 Worker 使用 `Agent` 工具，除非现有工具池验证证明 prompt 约束不足。
- 不同时实现官方所有 stream-json 新增行为；stream-json 深层转发作为后续阶段独立处理。

---

## 3. 当前实现与问题定位

### 3.1 当前可用的关联字段

当前实现已经拥有足够的关联信息：

| 字段 | 含义 | 主要位置 |
| --- | --- | --- |
| `taskId` / `agentId` | 当前 Agent 任务身份 | `Task.ts`、`LocalAgentTask` |
| `toolUseId` | 创建当前 Agent 的父级 Agent tool call | `TaskStateBase`、Agent metadata |
| `parentAgentId` | 直接父 Agent | `LocalAgentTaskState` |
| `spawnDepth` | 嵌套深度 | `LocalAgentTaskState`、Agent launch 参数 |
| `QueuedCommand.agentId` | 队列消息接收者 | `src/types/textInputTypes.ts` |

`QueuedCommand.agentId` 的约定已经明确：

- `undefined` 表示主线程；
- 子 Agent 只消费发送给自身 `agentId` 的 `task-notification`。

### 3.2 通知生产端缺少目标 Agent

`src/query.ts` 已经实现了队列隔离：

```ts
if (isMainThread) return cmd.agentId === undefined
return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
```

但是 `src/tasks/LocalAgentTask/LocalAgentTask.tsx` 中的 `enqueueAgentNotification()` 当前只向队列写入：

```ts
enqueuePendingNotification({
  value: message,
  mode: 'task-notification',
})
```

它没有使用任务已有的 `parentAgentId`。因此嵌套 Agent 的完成通知默认看起来像主线程通知，可能造成：

```text
Coordinator
  └─ Worker A
       └─ Worker B 完成
            └─ 无 agentId 的 task-notification
                 └─ Coordinator 主线程消费
```

预期应为：

```text
Coordinator
  └─ Worker A
       └─ Worker B 完成
            └─ agentId = Worker A
                 └─ Worker A 消费
```

### 3.3 多个展示面放大了错误路由

同一个 Agent 结果可能同时经过：

1. Agent tool result；
2. `<task-notification>` 对模型的上下文回灌；
3. stream-json/SDK `task_notification` 事件；
4. Coordinator 任务面板；
5. TaskOutput 或 output file；
6. Remote Control/SDK adapter。

因此首先应修复结果的上下文归属，而不是在 Coordinator UI 中对文本做模糊去重。

### 3.4 后台完成判定过于宽松

`src/tools/AgentTool/agentToolUtils.ts` 的 `runAsyncAgentLifecycle()` 在 stream 结束后直接执行：

```text
finalizeAgentTool()
completeAsyncAgent()
enqueueAgentNotification(status: 'completed')
```

同时 `finalizeAgentTool()` 在最后一条 assistant message 没有文本时，会回退到之前的文本消息。如果最后一条消息仍然包含未完成的 `tool_use`，旧文本可能被误当作最终结果。

需要区分：

- 真正完成的最终回答；
- 中断或被 kill；
- 异常失败；
- 最后一轮仍停在未完成的 tool call。

### 3.5 Coordinator Worker 是真实运行时缺口

`src/coordinator/workerAgent.ts` 当前为：

```ts
export function getCoordinatorAgents(): AgentDefinition[] {
  return []
}
```

而 `src/tools/AgentTool/builtInAgents.ts` 在 Coordinator 模式下直接返回 `getCoordinatorAgents()` 的结果，替换普通内置 Agent 列表。

与此同时，`src/coordinator/coordinatorMode.ts` 的系统提示要求：

```text
When calling AgentTool, use subagent_type `worker`.
```

因此当前没有项目/插件自定义 Agent 时，Coordinator 可能出现：

```text
Agent type 'worker' not found
```

历史恢复 bundle `recover/claude-v2.1.165.js` 已包含与当前架构匹配的 `WORKER_AGENT` 定义，可作为实现依据，而不是重新设计另一套 Worker 类型。

---

## 4. 目标架构

### 4.1 结果路由不变量

实现后必须满足：

1. 顶层后台 Agent 的终态通知投递到主线程。
2. 嵌套后台 Agent 的终态通知默认投递到直接父 Agent。
3. 父 Agent 已完成、被停止或不存在时，child 通知可以升级到主线程，但必须保留升级原因。
4. 不允许同一 terminal task 生成多条终态通知。
5. `taskId`、`toolUseId`、`parentAgentId` 的职责不混淆：
   - `taskId` 标识任务；
   - `toolUseId` 关联触发该任务的 tool call；
   - `parentAgentId` 决定默认消息接收者。

### 4.2 Worker 运行时不变量

1. Coordinator 模式下内置 Agent 列表至少包含一个 `worker`。
2. `worker` 使用 `source: 'built-in'` 和 `baseDir: 'built-in'`。
3. Worker 默认异步执行时使用 `permissionMode: 'bubble'`。
4. Worker 的工具和行为限制与现有 Agent tool pool 保持兼容。
5. Worker 不主动创建新的 subagent，优先通过 system prompt 约束；是否增加硬性工具限制由后续测试决定。

### 4.3 终态不变量

只有在最后一轮 Agent 响应可以证明已经结束时，才发送 `completed`：

- 存在 assistant message；
- 没有 terminal error；
- 未被 abort/killed；
- 最后一条 assistant message 不包含未完成的 `tool_use`；
- 最终内容不是仅由旧的中间 assistant 文本兜底得到。

---

## 5. 分阶段实施计划

## 阶段 0：建立基线

### 工作内容

1. 确认工作树无未预期修改。
2. 运行现有 Agent、Task、Coordinator 相关测试。
3. 记录 Coordinator mode 当前的 `worker` 解析失败行为。
4. 确认以下调用点在当前分支仍保持：
   - `enqueueAgentNotification()`；
   - `runAsyncAgentLifecycle()`；
   - `getCoordinatorAgents()`；
   - `getBuiltInAgents()`；
   - `query.ts` 的 agent-scoped queue drain。

### 交付物

- 基线测试结果；
- 当前失败行为的最小复现；
- 不修改代码的调用链记录。

### 通过标准

基线失败必须能稳定复现或明确记录为未覆盖场景，不能以“测试通过”代替功能验证。

---

## 阶段 1：恢复 Coordinator Worker

### 修改范围

- `src/coordinator/workerAgent.ts`
- `src/tools/AgentTool/builtInAgents.test.ts` 或新增对应测试
- 必要时增加 `src/coordinator/workerAgent.test.ts`

### 实现内容

恢复与历史 bundle 和架构文档一致的 Worker：

```ts
const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'For executing tasks autonomously — research, implementation, or verification.',
  tools: ['*'],
  maxTurns: 200,
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => getWorkerSystemPrompt(),
}

export function getCoordinatorAgents(): AgentDefinition[] {
  return [WORKER_AGENT]
}
```

Worker system prompt 应包含：

- Worker 由 Coordinator 分配任务；
- 只处理明确范围；
- 不自行派生 subagent；
- 并行 Worker 可能修改同一工作树；
- 遇到不确定冲突时向 Coordinator 报告；
- 完成前执行 sanity check；
- 使用 `result:`、`needs input:`、`failed:` 表达终态。

### 暂不做的事情

第一阶段不增加 `disallowedTools: ['Agent']`。先验证现有工具池和 Worker prompt 是否足够；否则会同时改变 Coordinator prompt、Agent tool pool 和 nested Agent 行为。

### 验收标准

1. Coordinator mode 下 `getBuiltInAgents()` 返回 `worker`。
2. `worker.source === 'built-in'`。
3. `worker.permissionMode === 'bubble'`。
4. `worker.maxTurns === 200`。
5. `AgentTool` 能解析 `subagent_type: 'worker'`。
6. Coordinator + simple mode 不再得到空 Agent 列表。
7. 非 Coordinator 模式下原有 built-in Agent 列表不变。

---

## 阶段 2：修复嵌套终态通知路由

### 修改范围

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tools/AgentTool/agentToolUtils.ts`
- Agent launch metadata 类型和传参位置
- `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`
- 必要时增加独立的 notification routing test

### 实现内容

为 `enqueueAgentNotification()` 增加明确的目标字段：

```ts
targetAgentId?: AgentId
```

调用方从任务的 `parentAgentId` 传入目标：

```ts
enqueuePendingNotification({
  value: message,
  mode: 'task-notification',
  agentId: targetAgentId,
})
```

推荐的选择规则：

```text
parentAgentId 存在且父任务仍为 running
  → targetAgentId = parentAgentId

父任务已 terminal、被 evict 或不存在
  → targetAgentId = undefined
  → 标记为主线程升级通知
```

需要避免从 `toolUseId` 反推接收者。`toolUseId` 用来关联父 tool call，不直接等于父 Agent id。

### 投递状态

当前 `TaskStateBase.notified` 已经保证一次任务只 enqueue 一次。第一阶段只增加必要的投递信息，例如：

```ts
notificationDeliveredTo?: AgentId | 'main'
notificationEscalated?: boolean
```

不立即引入全局 result digest；先确保路由正确和终态通知只生成一次。

### 验收标准

1. 顶层 Agent 完成后，通知 `agentId` 保持 `undefined`。
2. 嵌套 Agent 完成后，通知的 `agentId` 等于直接父 Agent。
3. 父 Agent 已完成时，child 通知不会永远留在无人消费的队列中。
4. 主线程不会消费普通 nested child notification。
5. 同一任务重复触发终态路径时，仍只产生一条 terminal notification。
6. `toolUseId` 和目标 `agentId` 在测试中分别断言，防止字段职责混淆。

---

## 阶段 3：收紧后台完成判定

### 修改范围

- `src/tools/AgentTool/agentToolUtils.ts`
- `finalizeAgentTool()` 相关测试
- `runAsyncAgentLifecycle()` 相关测试
- 必要时 `src/tools/AgentTool/runAgent.ts` 的 incomplete tool call 测试

### 实现内容

为最终结果增加明确判断，至少识别：

- 最后一条 assistant message 是否包含文本；
- 最后一条 assistant message 是否包含未完成 `tool_use`；
- 是否存在对应的 tool result；
- 是否已被 abort/killed；
- 是否存在 terminal error。

第一阶段推荐保持现有 `TaskStatus` 枚举不变：

- 正常最终文本：`completed`；
- abort：`killed`；
- 异常：`failed`；
- 未完成 tool call：不得发送 `completed`，转入明确的失败/部分结果路径。

禁止以下行为：

```text
最后一条 assistant 仍是纯 tool_use
  → 使用更早的 assistant 文本
  → 直接标记 completed
```

如果确实需要保留中间文本，应将其作为 partial output，而不是最终 completed result。

### 完成顺序约束

当前实现先 `completeAsyncAgent()` 再执行耗时的 post-processing，这是为了让 `TaskOutput(block=true)` 能及时解除阻塞。该顺序不应简单移到所有 post-processing 之后。

应把修复重点放在：

1. stream 结束时的 completion 判定；
2. `finalizeAgentTool()` 的 fallback 条件；
3. terminal notification 的 status；

而不是破坏 TaskOutput 的解除阻塞语义。

### 验收标准

| 场景 | 预期 |
| --- | --- |
| 最后一条 assistant 有最终文本 | `completed` |
| 最后一条 assistant 只有未完成 `tool_use` | 不得 `completed` |
| 用户停止/Abort | `killed` |
| 工具或 API 异常 | `failed` |
| 无 assistant message | 明确失败，不生成 completed |
| post-processing 失败但执行已确定完成 | 保持执行终态，增加 warning，不重复发送终态 |

---

## 阶段 4：Coordinator UI 终态聚合

### 修改范围

- `src/components/CoordinatorAgentStatusRows.ts`
- `src/components/CoordinatorAgentStatus.tsx`
- 相关 UI 测试

### 实现内容

当前嵌套树只纳入 `status === 'running'` 的 child。建议改为：

- running child：显示活动状态；
- terminal child：在保留窗口内显示简短状态，或计入父节点终态计数；
- 不在 Coordinator UI 中重复展开完整 `finalMessage`。

推荐的初版显示模型：

```text
Worker A
  2 running · 3 done · 1 failed
```

如果需要保留子节点，则复用现有 `evictAfter`/panel grace 机制，不额外创建新的生命周期缓存。

### 验收标准

1. child 完成后不会造成父 Agent 行重复出现。
2. child 终态在合理保留窗口内仍可归属于原父 Agent。
3. collapsed descendant count 不只统计 running child。
4. UI 展示状态摘要，不复制已回灌给模型的完整结果。
5. workflow child Agent 仍不会与 workflow row 重复显示。

---

## 阶段 5：stream-json、SDK 和远程适配

### 修改范围

- `src/cli/print.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/utils/sdkEventQueue.ts`
- `src/server/directConnectManager.ts`
- 相关 stream-json/SDK 测试

### 实现内容

该阶段独立处理官方近期的 nested subagent forwarding，不与内部队列路由混为一个修复：

1. 为 depth-2+ Agent 的外部转发保留 spawning Agent 的 `tool_use` 关联。
2. 明确区分：
   - 给父 Agent 的内部 `task-notification`；
   - 给 SDK 消费者的 `task_notification`；
   - `--forward-subagent-text` 产生的文本/思考转发。
3. Remote adapter 完整处理 task lifecycle event：
   - `task_started`；
   - `task_progress`；
   - `task_notification`。
4. 不把 `parent_tool_use_id` 当成唯一父子关系字段；优先传递结构化的 task/agent relation。

### 验收标准

1. 默认 stream-json 不额外泄漏 nested child 文本。
2. 启用转发选项后，depth-2+ child 能被正确关联到 spawning Agent。
3. SDK 收到的 task event 不会与同一任务的文本结果重复计为两个完成结果。
4. Remote Control 中途加入会话时能看到已有的 Agent/Workflow 状态。

---

## 6. 代码编辑样例（计划稿）

本节提供接近实际源码的编辑样例，帮助实施时从计划落到代码。它们是**方案草稿，不是未经验证的直接补丁**：实际编辑前需要重新读取当前类型、调用点和测试，尤其是 `AgentLifecycleMetadata`、`AppState` 更新方式和测试 fixture。

### 6.1 恢复 Coordinator Worker

文件：`src/coordinator/workerAgent.ts`

当前文件可以从空实现改为一个明确的 built-in Agent。Worker prompt 应保留历史实现中的范围、并发修改、验证和终态输出约束。

```ts
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'

const WORKER_SYSTEM_PROMPT = `You are a worker agent executing a task assigned by the coordinator.

Complete exactly what was asked. Do not fix unrelated issues. Do not spawn subagents.
If other workers may touch the same files, inspect the current state and report conflicts
instead of overwriting work you do not understand.

Before reporting completion, run an appropriate sanity check. Report the result directly
to the coordinator using one of: result:, needs input:, or failed:.
`

export const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'For executing tasks autonomously — research, implementation, or verification.',
  tools: ['*'],
  maxTurns: 200,
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => WORKER_SYSTEM_PROMPT,
}

export function getCoordinatorAgents(): AgentDefinition[] {
  return [WORKER_AGENT]
}
```

编辑注意事项：

- 不要把 `WORKER_AGENT` 改成普通 custom Agent；`builtInAgents.ts` 依赖 `source: 'built-in'`。
- 不要省略 `permissionMode: 'bubble'`，Coordinator Worker 默认异步执行，需要沿用现有权限回传路径。
- 第一版不要直接增加 `disallowedTools: ['Agent']`，先用测试确认 Worker prompt 和现有工具池是否足够。

### 6.2 为完成通知增加目标 Agent

文件：`src/tasks/LocalAgentTask/LocalAgentTask.tsx`

`QueuedCommand.agentId` 已经是现有队列协议中的接收者字段，因此优先扩展通知生产端，而不是修改 `query.ts` 的消费过滤器。

```ts
import type { AgentId } from '../../types/ids.js'

export function enqueueAgentNotification({
  taskId,
  description,
  status,
  error,
  setAppState,
  finalMessage,
  usage,
  toolUseId,
  parentAgentId,
  getAppState,
  worktreePath,
  worktreeBranch,
}: {
  taskId: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
  setAppState: SetAppState
  getAppState: () => AppState
  finalMessage?: string
  usage?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  toolUseId?: string
  parentAgentId?: AgentId
  worktreePath?: string
  worktreeBranch?: string
}): void {
  // 保留现有的 task.notified 原子检查和 XML 构造逻辑。
  const parentTask = parentAgentId
    ? getAppState().tasks[parentAgentId]
    : undefined
  const parentIsRunning =
    isLocalAgentTask(parentTask) && parentTask.status === 'running'
  const targetAgentId = parentIsRunning ? parentAgentId : undefined

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    // undefined 表示主线程；有值时由父 Agent 的 query loop 消费。
    agentId: targetAgentId,
  })
}
```

这里的 `message` 代表现有 XML 构造结果，计划中不要求改变 XML 格式即可完成第一阶段路由修复。父任务已结束时，`targetAgentId` 回退为 `undefined`，并应在任务状态或日志中记录升级原因，例如 `parent-completed`、`parent-killed` 或 `parent-missing`。

编辑注意事项：

- `parentAgentId` 是目标接收者；`toolUseId` 仍只表示触发该 Agent 的父 tool call。
- 不要把当前任务的 `taskId` 写入 `QueuedCommand.agentId`。
- 保留现有 `notified` 检查，不能因为增加路由字段而允许重复 terminal notification。
- 如果直接在 `enqueueAgentNotification()` 中读取 AppState 不方便，也可以在调用方提前解析 `targetAgentId`，但测试必须覆盖父任务状态变化。

### 6.3 从生命周期调用通知生产端

文件：`src/tools/AgentTool/agentToolUtils.ts`

需要把 `parentAgentId` 从 Agent launch metadata 传到所有终态分支，而不是只修改正常完成分支。

```ts
// 计划稿：实际名称应与当前 Agent metadata 类型统一。
type AgentLifecycleMetadata = Parameters<typeof finalizeAgentTool>[2] & {
  parentAgentId?: AgentId
}

// 正常完成、post-processing 失败后的 completed、killed、failed 四条路径
// 都要传递同一个 parentAgentId。
enqueueAgentNotification({
  taskId,
  description,
  status: 'completed',
  setAppState: rootSetAppState,
  getAppState: toolUseContext.getAppState,
  parentAgentId: metadata.parentAgentId,
  toolUseId: toolUseContext.toolUseId,
  finalMessage,
  usage: {
    totalTokens: finalProgress.tokenCount,
    toolUses: finalProgress.toolUseCount,
    durationMs: agentResult.totalDurationMs,
  },
  ...worktreeResult,
})
```

`status: 'killed'` 和 `status: 'failed'` 的两个分支也必须传递相同的 `parentAgentId`。否则正常完成结果会回到父 Agent，而异常结果仍会泄漏到主线程。

### 6.4 防止未完成 tool call 生成 completed

文件：`src/tools/AgentTool/agentToolUtils.ts`

当前 `finalizeAgentTool()` 会在最后一条 assistant message 没有文本时向前寻找旧文本。建议先增加一个明确的未完成判断，再决定是否允许 fallback：

```ts
function hasUnresolvedToolUse(messages: MessageType[]): boolean {
  const pending = new Set<string>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          pending.add(block.id)
        }
      }
    }

    if (message.type === 'user') {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          pending.delete(block.tool_use_id)
        }
      }
    }
  }

  return pending.size > 0
}

export function finalizeAgentTool(/* existing parameters */): AgentToolResult {
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }

  if (hasUnresolvedToolUse(agentMessages)) {
    throw new Error('Agent stopped with an unresolved tool call')
  }

  // 只有确认没有未完成 tool_use 后，才允许现有的旧文本 fallback。
  // 更严格的版本可以要求最后一条 assistant 直接包含最终文本。
  const content = extractFinalContentWithExistingFallback(agentMessages)
  // 保留当前 usage、structured output 和 telemetry 组装逻辑。
  return buildAgentToolResult(content, lastAssistantMessage)
}
```

如果当前消息类型不允许直接读取 `tool_result.tool_use_id`，应先增加类型守卫，而不是用宽泛的 `any`。第一版可以把异常转入现有 `failed` 分支，不必立即新增 `partial` 或 `incomplete_tool_use` TaskStatus。

在 `runAsyncAgentLifecycle()` 中保持现有顺序：

```ts
const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

// 仍然先写入确定的执行终态，避免 TaskOutput(block=true) 被 post-processing 阻塞。
completeAsyncAgent(agentResult, rootSetAppState)

// 后续继续执行 handoff classifier、worktree cleanup 和 notification。
```

关键改变是 `finalizeAgentTool()` 不再把未完成 tool call 当作正常 completed，而不是把 `completeAsyncAgent()` 无条件后移。

### 6.5 Coordinator UI 终态聚合样例

文件：`src/components/CoordinatorAgentStatusRows.ts`

当前 child 构建只保留 `status === 'running'`。第一版可以先把所有未被 evict 的 child 纳入统计，再决定是显示子行还是只显示计数：

```ts
type ChildCounts = {
  running: number
  completed: number
  failed: number
  killed: number
}

function countChildren(
  parentId: string,
  agents: LocalAgentTaskState[],
): ChildCounts {
  const counts: ChildCounts = {
    running: 0,
    completed: 0,
    failed: 0,
    killed: 0,
  }

  for (const agent of agents) {
    if (agent.parentAgentId !== parentId) continue
    if (agent.evictAfter === 0) continue
    counts[agent.status] += 1
  }

  return counts
}
```

UI 文案可以由计数生成：

```text
Worker A · 2 running · 3 done · 1 failed
```

这只是状态摘要，不应再次渲染 child 的完整 `finalMessage`。`workflow child` 的既有过滤逻辑必须继续优先于普通 nested Agent 计数。

### 6.6 回归测试编辑样例

#### Worker 定义测试

```ts
it('provides the worker built-in in coordinator mode', () => {
  const [worker] = getCoordinatorAgents()

  expect(worker).toMatchObject({
    agentType: 'worker',
    source: 'built-in',
    baseDir: 'built-in',
    maxTurns: 200,
    permissionMode: 'bubble',
  })
  expect(worker?.tools).toEqual(['*'])
  expect(worker?.getSystemPrompt({ options: {} as never })).toContain(
    'worker agent',
  )
})
```

实际测试不应依赖未启用的 feature flag；如果测试 `getBuiltInAgents()`，应使用项目现有的 feature/env mock 方式验证 Coordinator 分支。

#### 通知路由测试

```ts
it('routes a nested completion to its running parent', () => {
  enqueueAgentNotification({
    taskId: 'child-agent',
    description: 'Child',
    status: 'completed',
    parentAgentId: 'parent-agent' as AgentId,
    getAppState: () => stateWithRunningParent,
    setAppState,
    finalMessage: 'child result',
  })

  const [command] = getCommandQueue()
  expect(command?.mode).toBe('task-notification')
  expect(command?.agentId).toBe('parent-agent')
})

it('falls back to the main thread when the parent is terminal', () => {
  enqueueAgentNotification({
    taskId: 'child-agent',
    description: 'Child',
    status: 'completed',
    parentAgentId: 'parent-agent' as AgentId,
    getAppState: () => stateWithCompletedParent,
    setAppState,
  })

  const [command] = getCommandQueue()
  expect(command?.agentId).toBeUndefined()
})
```

#### 未完成 tool call 测试

```ts
it('does not finalize a response with an unresolved tool call', () => {
  const messages = [assistantWithToolUse('toolu_child')]

  expect(() => finalizeAgentTool(messages, 'child-agent', metadata)).toThrow(
    /unresolved tool call/,
  )
})
```

测试样例的重点不是固定错误文本，而是锁定三个行为不变量：目标接收者正确、父任务终态会触发升级、未完成 tool call 不会产生 `completed`。

---

## 8. 测试与验证矩阵

### 8.1 Worker 定义

| 场景 | 验证内容 |
| --- | --- |
| Coordinator mode | 内置 Agent 只有统一 `worker` |
| Coordinator + simple | 仍能解析 `worker` |
| 普通模式 | `general-purpose`、`Explore`、`Plan` 等原有列表不变 |
| Worker prompt | 包含范围、并发修改、验证和终态输出约束 |
| Worker permission | `bubble` 保持有效 |

### 8.2 嵌套路由

| 场景 | 预期接收者 |
| --- | --- |
| Coordinator → Worker | 主线程接收 Worker 终态 |
| Worker → child Worker | 直接父 Worker 接收 |
| depth-2 → depth-3 | 不进入 Coordinator 主线程 |
| 父 Worker 已完成 | 升级主线程或明确记录未投递 |
| 父 Worker 被 kill | child 不静默丢失 |
| 重复终态回调 | 只产生一条 terminal notification |

### 8.3 终态判定

| 场景 | 预期状态 |
| --- | --- |
| 正常最终文本 | `completed` |
| 未完成 tool call | 不得 `completed` |
| Abort | `killed` |
| API/工具异常 | `failed` |
| 旧文本 fallback | 不得掩盖未完成 tool call |

### 8.4 展示与协议

| 展示面 | 验证内容 |
| --- | --- |
| 主线程 query | 不消费普通 nested notification |
| 父 Agent query | 能消费 child notification |
| Coordinator UI | child 状态归属于父 Agent，不重复展开结果 |
| stream-json | task event 关联稳定 |
| SDK | `task_id/tool_use_id/parent_agent_id` 关系可追踪 |
| TaskOutput | 不因错误 completed 提前释放错误最终结果 |

### 8.5 基础验证

按照项目现有开发指南执行：

```bash
bun exec tsc --noEmit --pretty false
bun run build
bun run lint
git diff --check
```

CLI 和 UI 变更还需要：

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

测试必须在启用 Coordinator 和嵌套 Agent 的条件下运行，不能只验证默认普通模式。

---

## 9. 风险与回滚策略

### 风险 1：父 Agent 结束后通知无人消费

**原因**：严格路由到 `parentAgentId`，但父 Agent 已经 terminal。

**控制措施**：

- 入队前读取父任务状态；
- 父任务不可消费时升级到主线程；
- 记录 `notificationEscalated` 和原因；
- 增加父任务完成、kill、evict 三类测试。

### 风险 2：过早扩大 TaskStatus

**原因**：为 `partial`、`max_turns`、`incomplete_tool_use` 增加新的终态。

**控制措施**：

- 第一阶段保持现有 `TaskStatus`；
- 将 completion kind 先作为结果/通知 metadata；
- 等 UI、恢复和 TaskOutput 都有需求后再扩展状态枚举。

### 风险 3：Worker 工具权限变化

**原因**：恢复 Worker 时加入硬性 `disallowedTools`。

**控制措施**：

- 第一阶段只恢复历史实现中的 `tools: ['*']`、`permissionMode: 'bubble'`；
- 通过 Worker prompt 和行为测试确认是否会自行派生 Agent；
- 只有验证失败才增加硬性限制。

### 风险 4：重复修复同一条通知链

**原因**：同时修改 LocalAgentTask、query、print、SDK adapter，导致同一通知被多次消费或丢失。

**控制措施**：

- 先只修改通知生产端，复用现有 query filter；
- 每个阶段只增加一类断言；
- 记录 `taskId`、`toolUseId`、目标 `agentId` 和 status 的完整测试输出。

### 风险 5：破坏 TaskOutput 的及时解除阻塞

**原因**：把 `completeAsyncAgent()` 推迟到所有 post-processing 完成后。

**控制措施**：

- 保持当前“执行终态先落 AppState”的原则；
- 只修正 completion 判定和 notification status；
- 对 `TaskOutput(block=true)` 增加回归测试。

---

## 10. 推荐实施顺序

```text
阶段 0  建立基线
   ↓
阶段 1  恢复 Coordinator Worker
   ↓
阶段 2  修复嵌套终态通知路由
   ↓
阶段 3  收紧后台完成判定
   ↓
阶段 4  Coordinator UI 终态聚合
   ↓
阶段 5  stream-json / SDK / Remote parity
```

推荐优先完成阶段 1–3。它们分别解决：

```text
Worker 空列表       → Coordinator 无法启动 worker
通知没有目标        → nested 结果进入错误上下文
旧文本 fallback     → 未完成 Agent 被误判 completed
```

阶段 4 和阶段 5 应建立在运行时路由和终态语义稳定之后，避免用 UI 或协议层补偿底层生命周期错误。

---

## 11. 实施完成定义

本计划对应的工作全部完成，需要同时满足：

- Coordinator mode 能稳定启动和解析内置 `worker`；
- 嵌套 child 的终态通知默认进入直接父 Agent；
- 父 Agent 不可用时有明确升级策略；
- 未完成 tool call 不会产生 `completed` notification；
- 同一 task 不会重复发送 terminal notification；
- Coordinator UI 能表达 nested child 的终态归属而不重复渲染完整结果；
- stream-json/SDK 场景至少不会破坏现有 task lifecycle 输出；
- Coordinator、嵌套 Agent、后台 Agent、TaskOutput 和普通模式回归测试均通过；
- 生产代码、测试、架构文档和 CHANGELOG 的变更范围保持一致。

## 12. 相关文件索引

### Agent 与 Coordinator

- `src/coordinator/workerAgent.ts`
- `src/coordinator/coordinatorMode.ts`
- `src/tools/AgentTool/builtInAgents.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tools/AgentTool/runAgent.ts`
- `src/tools/AgentTool/loadAgentsDir.ts`

### Task 与通知

- `src/Task.ts`
- `src/taskStatus.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`
- `src/utils/messageQueueManager.ts`
- `src/types/textInputTypes.ts`
- `src/query.ts`

### UI 与协议

- `src/components/CoordinatorAgentStatus.tsx`
- `src/components/CoordinatorAgentStatusRows.ts`
- `src/cli/print.ts`
- `src/utils/sdkEventQueue.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/server/directConnectManager.ts`

### 参考资料

- `docs/architecture/agent-team.md`
- `docs/architecture/agent.md`
- `docs/guides/secondary-development.md`
- `recover/claude-v2.1.165.js`
