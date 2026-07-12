# Agent Progress Token and Tool Count Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本地前台、后台和递归 Agent 列表稳定显示已完成响应的真实 token 数和客户端 `tool_use` 数，同时保留 Agent 刚启动、纯文本响应和 server-side tool 显示 `0 tools` 的既有语义。

**Architecture:** 不在 UI 层估算 token，也不改变 API streaming/tool execution 时序。把 `ProgressTracker` 改为可重复处理同一 assistant message 的幂等增量统计器；Agent 生命周期在下一条消息到达和 stream 结束时刷新上一条 assistant message，从而读取 `message_delta` 原地回写后的最终 usage。前台 Agent 无条件把 tracker 快照写入根 task store，SDK 事件仍只在原有 gate 下发送。

**Tech Stack:** TypeScript、Bun、React Ink、Node `assert` 测试、tmux 交互式 CLI 验收。

---

## 修复边界

### 本计划修复

1. `content_block_stop` 先 yield zero-usage assistant message、`message_delta` 后回写真实 usage，导致 `task.progress.tokenCount` 永久为 0。
2. 前台 Agent 虽然维护 `syncTracker`，但只有 SDK progress summaries gate 开启且当前消息含 `tool_use` 时才写 `task.progress`，导致 TUI 偶发 `0 tools`。
3. Agent 完成前没有用最终 mutable message usage 校准 progress，导致 completed row 和 `<task-notification>` 继续报告 0 token。
4. 同一 assistant message 被刷新时，tool count 不能重复累计。

### 本计划不改变

1. Agent 刚注册、尚未产生 `tool_use` 时显示 `0 tools`。
2. 只输出文本且未调用客户端工具的 Agent 显示 `0 tools`。
3. `server_tool_use`、`mcp_tool_use`、`web_search_tool_result` 不计入客户端 `tool_use` 数；如需统一统计应另立需求。
4. 父 Agent 不递归聚合子 Agent 的 token/tool；父子仍各自独立统计。
5. 不通过字符长度或 tokenizer 估算 API usage。

## Official Claude 递归层级对照

### Runtime-observed（`official-claude 2.1.201`）

使用与本地测试相同的 prompt，官方二进制成功创建：

```text
parent-probe  spawnDepth=1
└─ child-probe  spawnDepth=2
```

但官方主会话 footer / Agent manager 只把 `parent-probe` 当作顶层 session 行展示：

```text
⏺ main
◯ general-purpose  parent-probe
```

没有把 `child-probe` 提升成第二个根级 session。层级信息保存在 sidechain metadata：

```json
{"agentType":"general-purpose","description":"parent-probe","spawnDepth":1}
{"agentType":"general-purpose","description":"child-probe","spawnDepth":2}
```

并且 child transcript 位于 parent 所属 session 的 `subagents/` 链路中。证据保存在：

```text
/tmp/claude-agent-hierarchy-official-20260710/08-parent-row.txt
/tmp/claude-agent-hierarchy-official-20260710/15-manage.txt
/Users/fakeadmin/.claude/projects/-Users-fakeadmin-Workspace-vsc-claude-code-source-claude-code-self/65da9318-2cba-4089-8bcd-bc0ae641c912/subagents/agent-ad8cd7e1c4dd42a16.meta.json
/Users/fakeadmin/.claude/projects/-Users-fakeadmin-Workspace-vsc-claude-code-source-claude-code-self/65da9318-2cba-4089-8bcd-bc0ae641c912/subagents/agent-aaa3def28532dcbdd.meta.json
```

### 本计划采用的层级语义

1. `LocalAgentTaskState` 保存 `parentAgentId` 和 `spawnDepth`，不再只把 depth 写入磁盘 metadata。
2. 主会话 Agent panel 只展示 `parentAgentId === undefined` 的顶层 Agent，匹配官方行为。
3. 嵌套 child task 仍保留在根 `AppState.tasks` 中，以便 kill、notification、transcript 和父 Agent 生命周期使用；只是不能伪装成第二个根 session。
4. 不在本次修复中发明官方没有展示的树形缩进 UI。若后续需要可展开树，应基于已保存的 `parentAgentId` 单独设计，而不是用 `startTime` 或 `toolUseId` 猜层级。
5. 由于对照版本为官方 `2.1.201`、本地产物为 `2.1.178`，只采用已运行确认的层级语义，不复制官方新版 Agent manager 的整体视觉布局。

## 文件结构

- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
  - 让 tracker 幂等处理重复 assistant message。
  - 提供刷新最后一条 assistant message和发布 task progress 的小型函数。
- Create: `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`
  - 覆盖 usage 原地回写、重复刷新不重复计 tool、latest-input/cumulative-output 口径。
- Modify: `src/tools/AgentTool/agentToolUtils.ts`
  - 后台 lifecycle 在下一条消息前和 stream 结束时刷新上一条 assistant message。
  - 完成前发布最终 progress；通知复用同一最终 progress。
- Modify: `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`
  - 加入与真实 SSE 时序一致的 zero usage → 原地 mutation → 下一条消息/结束测试。
- Modify: `src/tools/AgentTool/AgentTool.tsx`
  - 前台、前台转后台路径使用同一刷新/发布规则。
  - SDK progress event gate 与 TUI AppState 更新解耦。
- Create: `src/tools/AgentTool/foregroundProgressUpdate.test.ts`
  - 对提取出的前台 progress 发布函数做 gate-off 回归测试。
- Modify: `src/components/CoordinatorAgentStatusRows.ts`
  - 顶层 session panel 过滤嵌套 child；不在 formatter 中修 token/tool。
- Modify: `src/components/CoordinatorAgentStatus.test.ts`
  - 现有 `1.5k tok · 2 tools` formatter 测试继续通过，并新增递归 child 不成为根行的断言。
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
  - `LocalAgentTaskState` 增加 `parentAgentId`、`spawnDepth`。
- Modify: `src/tools/AgentTool/AgentTool.tsx`
  - 注册 child task 时传入当前调用者 Agent ID 和 child depth。
- Modify: `src/tools/AgentTool/runAgent.ts`
  - 磁盘 metadata 与 task state 复用相同 parent/depth 语义。

---

### Task 1: 先固定 ProgressTracker 的幂等统计语义

**Files:**
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:56-152`
- Create: `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`

- [ ] **Step 1: 创建原地 usage 回写的失败测试**

新增 `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`：

```ts
import assert from 'node:assert/strict'
import type { Message } from '../../types/message.js'
import {
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from './LocalAgentTask.js'

function assistantMessage({
  uuid,
  inputTokens,
  outputTokens,
  toolIds = [],
}: {
  uuid: string
  inputTokens: number
  outputTokens: number
  toolIds?: string[]
}): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-07-10T00:00:00.000Z',
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      model: 'test-model',
      content: toolIds.map(id => ({
        type: 'tool_use',
        id,
        name: 'Read',
        input: { file_path: '/tmp/example' },
      })),
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as Message
}

const tracker = createProgressTracker()
const first = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000001',
  inputTokens: 0,
  outputTokens: 0,
  toolIds: ['toolu-1'],
})

updateProgressFromMessage(tracker, first)
assert.deepEqual(getProgressUpdate(tracker), {
  tokenCount: 0,
  toolUseCount: 1,
  lastActivity: {
    toolName: 'Read',
    input: { file_path: '/tmp/example' },
    activityDescription: undefined,
    isSearch: undefined,
    isRead: undefined,
  },
  recentActivities: [
    {
      toolName: 'Read',
      input: { file_path: '/tmp/example' },
      activityDescription: undefined,
      isSearch: undefined,
      isRead: undefined,
    },
  ],
})

first.message.usage.input_tokens = 120
first.message.usage.output_tokens = 8
updateProgressFromMessage(tracker, first)

assert.equal(getProgressUpdate(tracker).tokenCount, 128)
assert.equal(getProgressUpdate(tracker).toolUseCount, 1)

const second = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000002',
  inputTokens: 150,
  outputTokens: 5,
  toolIds: ['toolu-2'],
})
updateProgressFromMessage(tracker, second)
updateProgressFromMessage(tracker, second)

assert.equal(getProgressUpdate(tracker).tokenCount, 150 + 8 + 5)
assert.equal(getProgressUpdate(tracker).toolUseCount, 2)

console.log('LocalAgentTask.progress.test.ts passed')
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
```

Expected: FAIL；重复处理 `first` 后 tool count 变为 2，且 output token 被重复累加。

- [ ] **Step 3: 将 tracker 改为按 message/tool ID 幂等更新**

在 `src/tasks/LocalAgentTask/LocalAgentTask.tsx` 扩展内部 tracker：

```ts
type AssistantUsageSnapshot = {
  inputTokens: number
  outputTokens: number
  sequence: number
}

export type ProgressTracker = {
  toolUseCount: number
  latestInputTokens: number
  cumulativeOutputTokens: number
  recentActivities: ToolActivity[]
  assistantUsageByUuid: Map<string, AssistantUsageSnapshot>
  seenToolUseIds: Set<string>
  nextAssistantSequence: number
  latestInputSequence: number
}
```

初始化：

```ts
export function createProgressTracker(): ProgressTracker {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: [],
    assistantUsageByUuid: new Map(),
    seenToolUseIds: new Set(),
    nextAssistantSequence: 0,
    latestInputSequence: -1,
  }
}
```

在 `updateProgressFromMessage()` 中用 UUID 更新 usage delta，而不是盲目累加：

```ts
const usage = message.message.usage
const inputTokens =
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0)
const outputTokens = usage.output_tokens
const existing = tracker.assistantUsageByUuid.get(message.uuid)
const sequence = existing?.sequence ?? tracker.nextAssistantSequence++

tracker.cumulativeOutputTokens += outputTokens - (existing?.outputTokens ?? 0)
tracker.assistantUsageByUuid.set(message.uuid, {
  inputTokens,
  outputTokens,
  sequence,
})

if (sequence >= tracker.latestInputSequence) {
  tracker.latestInputSequence = sequence
  tracker.latestInputTokens = inputTokens
}
```

对 tool 使用稳定 ID 去重；缺少 ID 时使用 message UUID 与 content index 组成仅限统计的 key：

```ts
for (const [index, content] of message.message.content.entries()) {
  if (content.type !== 'tool_use') continue
  const toolUseKey = content.id ?? `${message.uuid}:${index}`
  if (tracker.seenToolUseIds.has(toolUseKey)) continue
  tracker.seenToolUseIds.add(toolUseKey)
  tracker.toolUseCount++
  // 保留现有 recentActivities 逻辑
}
```

不要改变 `SyntheticOutput` 的现有口径：仍计入 `toolUseCount`，只是不加入 activity preview。

- [ ] **Step 4: 运行 tracker 测试**

Run:

```bash
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
```

Expected: PASS，最终输出 `LocalAgentTask.progress.test.ts passed`。

- [ ] **Step 5: 运行现有 Agent UI formatter 测试**

Run:

```bash
bun src/components/CoordinatorAgentStatus.test.ts
```

Expected: PASS，继续显示 `1.5k tok · 2 tools`。

---

### Task 2: 后台 Agent 在 usage 回写后刷新上一条 assistant message

**Files:**
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:99-152`
- Modify: `src/tools/AgentTool/agentToolUtils.ts:511-640`
- Modify: `src/tools/AgentTool/asyncLifecycleOrdering.test.ts:12-109`

- [ ] **Step 1: 添加 lifecycle 流式时序失败测试**

在 `asyncLifecycleOrdering.test.ts` 保留现有完成顺序断言，并添加第二个 task。其 stream 必须模拟真实顺序：第一次 yield 时 usage 为 0，generator 恢复后原地写入最终 usage，再 yield user tool result。

```ts
const streamingMessage = makeAssistantMessage()
streamingMessage.uuid = crypto.randomUUID()
streamingMessage.message.content = [
  {
    type: 'tool_use',
    id: 'toolu_streaming',
    name: 'Read',
    input: { file_path: '/tmp/example' },
  },
]
streamingMessage.message.usage.input_tokens = 0
streamingMessage.message.usage.output_tokens = 0

registerAsyncAgent({
  agentId: 'agent-progress-test',
  description: 'Progress test',
  prompt: 'read once',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_parent',
})

await runAsyncAgentLifecycle({
  taskId: 'agent-progress-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield streamingMessage as never
    streamingMessage.message.usage.input_tokens = 200
    streamingMessage.message.usage.output_tokens = 12
    yield {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_streaming',
            content: 'ok',
          },
        ],
      },
    } as never
  },
  metadata: {
    prompt: 'read once',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Progress test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_parent',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-progress-test',
  enableSummarization: false,
  getWorktreeResult: async () => ({}),
})

const progressTask = state.tasks['agent-progress-test']
assert.ok(isLocalAgentTask(progressTask))
assert.equal(progressTask.progress?.tokenCount, 212)
assert.equal(progressTask.progress?.toolUseCount, 1)
```

- [ ] **Step 2: 运行 lifecycle 测试并确认失败**

Run:

```bash
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
```

Expected: FAIL，`progressTask.progress?.tokenCount` 为 0。

- [ ] **Step 3: 增加“刷新上一条 assistant”辅助函数**

在 `LocalAgentTask.tsx` 添加：

```ts
export function refreshLastAssistantProgress(
  tracker: ProgressTracker,
  messages: Message[],
  resolveActivityDescription?: ActivityDescriptionResolver,
  tools?: Tools,
): void {
  const lastAssistant = messages.findLast(
    (message): message is Extract<Message, { type: 'assistant' }> =>
      message.type === 'assistant',
  )
  if (!lastAssistant) return
  updateProgressFromMessage(
    tracker,
    lastAssistant,
    resolveActivityDescription,
    tools,
  )
}
```

该函数依赖 Task 1 的幂等统计；不得在未实现幂等前调用。

- [ ] **Step 4: 在后台 lifecycle 的两个时点刷新**

在 `runAsyncAgentLifecycle()` 循环中，先刷新已积累的最后一条 assistant，再 push/process 当前 message：

```ts
for await (const message of makeStream(onCacheSafeParams)) {
  refreshLastAssistantProgress(
    tracker,
    agentMessages,
    resolveActivity,
    toolUseContext.options.tools,
  )
  agentMessages.push(message)
  // 保留 transcript append
  updateProgressFromMessage(
    tracker,
    message,
    resolveActivity,
    toolUseContext.options.tools,
  )
  updateAsyncAgentProgress(
    taskId,
    getProgressUpdate(tracker),
    rootSetAppState,
  )
  // 保留 SDK emit
}
```

stream 结束后、`finalizeAgentTool()` 之前再刷新并发布一次，覆盖“最终文本响应之后没有下一条 recordable message”的情况：

```ts
refreshLastAssistantProgress(
  tracker,
  agentMessages,
  resolveActivity,
  toolUseContext.options.tools,
)
const finalProgress = getProgressUpdate(tracker)
updateAsyncAgentProgress(taskId, finalProgress, rootSetAppState)

const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
```

完成通知复用 `finalProgress`，不要再次从 tracker 构造不同口径：

```ts
usage: {
  totalTokens: finalProgress.tokenCount,
  toolUses: finalProgress.toolUseCount,
  durationMs: agentResult.totalDurationMs,
},
```

这也消除 notification 使用 `agentResult.totalToolUseCount`、列表使用 tracker 的口径分叉。

- [ ] **Step 5: 运行 lifecycle 与 tracker 测试**

Run:

```bash
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
```

Expected: 两者 PASS；progress token 为 212，tool count 为 1。

---

### Task 3: 修复前台 Agent 的 task.progress 写回条件

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx:1219-1613,1699-1737`
- Create: `src/tools/AgentTool/foregroundProgressUpdate.test.ts`
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

- [ ] **Step 1: 提取无 gate 的 task progress 发布函数并写失败测试**

在 `LocalAgentTask.tsx` 添加纯粹的组合函数：

```ts
export function publishAgentProgress(
  taskId: string,
  tracker: ProgressTracker,
  setAppState: SetAppState,
): AgentProgress {
  const progress = getProgressUpdate(tracker)
  updateAgentProgress(taskId, progress, setAppState)
  return progress
}
```

新增 `foregroundProgressUpdate.test.ts`，注册 foreground task，处理一条 tool-use assistant message，然后在没有 SDK summary gate 的情况下调用 `publishAgentProgress()` 并检查 task：

```ts
import assert from 'node:assert/strict'
import type { AppState } from '../../state/AppState.js'
import {
  createProgressTracker,
  isLocalAgentTask,
  publishAgentProgress,
  registerAgentForeground,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'

// 构造最小 AppState、selectedAgent 和一条 input=30/output=4 的 Read tool_use message。
// registerAgentForeground() 后调用 updateProgressFromMessage() 和 publishAgentProgress()。
// 不设置 SDK summaries gate。

const task = state.tasks['foreground-progress-test']
assert.ok(isLocalAgentTask(task))
assert.equal(task.progress?.tokenCount, 34)
assert.equal(task.progress?.toolUseCount, 1)

console.log('foregroundProgressUpdate.test.ts passed')
```

测试中的 AppState/selectedAgent/message 构造应直接复用 `asyncLifecycleOrdering.test.ts` 的最小形状，不引入新 helper 文件。

- [ ] **Step 2: 运行前台 progress 测试**

Run:

```bash
bun src/tools/AgentTool/foregroundProgressUpdate.test.ts
```

Expected: 如果先写测试再实现 export，则 FAIL，提示 export 不存在；实现函数后 PASS。该测试固定“AppState 发布不依赖 SDK gate”的接口语义。

- [ ] **Step 3: 前台循环每条消息都发布 AppState progress**

将 `AgentTool.tsx:1582-1612` 调整为：

```ts
refreshLastAssistantProgress(
  syncTracker,
  agentMessages,
  syncResolveActivity,
  toolUseContext.options.tools,
)
agentMessages.push(message)
updateProgressFromMessage(
  syncTracker,
  message,
  syncResolveActivity,
  toolUseContext.options.tools,
)

if (foregroundTaskId) {
  publishAgentProgress(
    foregroundTaskId,
    syncTracker,
    rootSetAppState,
  )

  const lastToolName = getLastToolUseName(message)
  if (lastToolName) {
    emitTaskProgress(
      syncTracker,
      foregroundTaskId,
      toolUseContext.toolUseId,
      description,
      agentStartTime,
      lastToolName,
    )
  }
}
```

注意：当前代码在 `agentMessages.push(message)` 后刷新会把当前 zero-usage assistant 当成 last assistant。实施时必须在 push 当前消息之前刷新旧 assistant，或单独保存 `previousMessages`；不要刷新错误对象。

删除仅包围 `updateAsyncAgentProgress()` 的：

```ts
if (getSdkAgentProgressSummariesEnabled()) { ... }
```

但保留 `startAgentSummarization()` 和 SDK summary event 自身的原 gate。修复目标是 AppState，不是扩大 SDK event 面。

- [ ] **Step 4: 前台 stream 结束前做最终校准**

在 `finally` 中、`unregisterAgentForeground()` 之前：

```ts
refreshLastAssistantProgress(
  syncTracker,
  agentMessages,
  syncResolveActivity,
  toolUseContext.options.tools,
)
if (foregroundTaskId && !wasBackgrounded) {
  publishAgentProgress(
    foregroundTaskId,
    syncTracker,
    rootSetAppState,
  )
}
```

随后再计算 SDK completion usage：

```ts
const progress = getProgressUpdate(syncTracker)
```

纯前台 task 仍按现有逻辑立即 unregister；最终发布用于 SDK completion 和在终态切换前保证口径正确，不延长 UI 生命周期。

- [ ] **Step 5: 运行前台、后台和 UI 测试**

Run:

```bash
bun src/tools/AgentTool/foregroundProgressUpdate.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
bun src/components/CoordinatorAgentStatus.test.ts
```

Expected: 全部 PASS。

---

### Task 4: 修复“前台转后台”路径的最终 usage 刷新

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx:1383-1455`
- Test: `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts`

- [ ] **Step 1: 在既有 tracker 测试加入 replay 后重复刷新断言**

在 `LocalAgentTask.progress.test.ts` 增加：

```ts
const replayTracker = createProgressTracker()
for (const message of [first, second]) {
  updateProgressFromMessage(replayTracker, message)
}
for (const message of [first, second]) {
  updateProgressFromMessage(replayTracker, message)
}
assert.equal(getProgressUpdate(replayTracker).tokenCount, 163)
assert.equal(getProgressUpdate(replayTracker).toolUseCount, 2)
```

Expected: Task 1 实现正确时 PASS；如果重复 replay 导致 tools/output 翻倍则 FAIL。

- [ ] **Step 2: 前台转后台初始化 tracker 后立即发布**

现有代码会用 `agentMessages` 重建 tracker：

```ts
for (const existingMsg of agentMessages) {
  updateProgressFromMessage(...)
}
```

保留 replay，但在进入第二个 `runAgent()` 前增加：

```ts
refreshLastAssistantProgress(
  tracker,
  agentMessages,
  resolveActivity2,
  toolUseContext.options.tools,
)
publishAgentProgress(
  backgroundedTaskId,
  tracker,
  rootSetAppState,
)
```

- [ ] **Step 3: 后台 continuation 每条消息前刷新旧 assistant**

在 `AgentTool.tsx:1416-1430` 采用与 Task 2 相同顺序：

```ts
refreshLastAssistantProgress(
  tracker,
  agentMessages,
  resolveActivity2,
  toolUseContext.options.tools,
)
agentMessages.push(msg)
updateProgressFromMessage(...)
publishAgentProgress(backgroundedTaskId, tracker, rootSetAppState)
```

- [ ] **Step 4: continuation 完成前最终刷新并统一通知 usage**

在 `finalizeAgentTool()` 前刷新最后 assistant，发布最终 progress，并让通知使用：

```ts
const finalProgress = publishAgentProgress(
  backgroundedTaskId,
  tracker,
  rootSetAppState,
)

usage: {
  totalTokens: finalProgress.tokenCount,
  toolUses: finalProgress.toolUseCount,
  durationMs: agentResult.totalDurationMs,
}
```

- [ ] **Step 5: 运行回归测试**

Run:

```bash
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
bun src/tools/AgentTool/foregroundProgressUpdate.test.ts
```

Expected: 全部 PASS，无重复 tool/output 统计。

---

### Task 5: 保存递归 Agent 层级并匹配官方顶层列表语义

**Files:**
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:167-199,574-733`
- Modify: `src/tools/AgentTool/AgentTool.tsx:488-499,719-720,1109-1121,1263-1271`
- Modify: `src/components/CoordinatorAgentStatusRows.ts:29-74`
- Modify: `src/components/CoordinatorAgentStatus.test.ts:12-187`
- Test: `src/tools/AgentTool/agentLaunchParams.test.ts`

- [ ] **Step 1: 添加递归 child 不成为根 session 的失败测试**

在 `CoordinatorAgentStatus.test.ts` 增加一个 child task：

```ts
const nestedAgentTask: LocalAgentTaskState = {
  ...agentTask,
  id: 'agent-child',
  agentId: 'agent-child',
  description: 'Child research',
  startTime: 1_500,
  parentAgentId: 'agent-1',
  spawnDepth: 2,
  progress: {
    tokenCount: 700,
    toolUseCount: 3,
  },
} as LocalAgentTaskState
```

将其放入 `tasks` 后断言：

```ts
assert.deepEqual(
  getVisibleAgentTasks(tasks).map(task => task.id),
  ['agent-1', 'workflow-1'],
)
assert.equal(
  getCoordinatorSessionRows({
    tasks,
    selectedIndex: undefined,
    viewingAgentTaskId: undefined,
    nameByAgentId: new Map(),
    now: 5_000,
  }).some(row => row.id === 'agent-child'),
  false,
)
```

同时增加一个没有 parent 的 depth-1 Agent，确认仍作为顶层行显示，避免错误地按 `spawnDepth > 1` 之外的模糊条件过滤。

- [ ] **Step 2: 运行 UI 测试并确认失败**

Run:

```bash
bun src/components/CoordinatorAgentStatus.test.ts
```

Expected: FAIL；当前 `getVisibleAgentTasks()` 会平铺显示 `agent-child`。

- [ ] **Step 3: 给 task state 增加明确层级字段**

在 `LocalAgentTaskState` 增加：

```ts
parentAgentId?: string
spawnDepth: number
```

扩展 `registerAsyncAgent()` 和 `registerAgentForeground()` 参数：

```ts
parentAgentId?: string
spawnDepth: number
```

并写入两个 task state：

```ts
parentAgentId,
spawnDepth,
```

不要通过 `toolUseId` 推断父子关系；同一 workflow 或并行 tool batch 可能共享其他关联语义，不能作为 parent ID。

- [ ] **Step 4: AgentTool 注册时传递父 Agent ID 与 child depth**

在 `AgentTool.call()` 中，`childSubagentDepth` 已由：

```ts
const childSubagentDepth = getNextSubagentDepth(toolUseContext.options)
```

得到。定义 parent：

```ts
const parentAgentId =
  toolUseContext.options.subagentDepth && toolUseContext.agentId
    ? toolUseContext.agentId
    : undefined
```

向两条注册路径传入：

```ts
parentAgentId,
spawnDepth: childSubagentDepth,
```

这里使用“当前 context 已经是 subagent”作为 parent 判定，避免把主会话自身的 session agent ID 当作 parent。若类型显示 `agentId` 可能是 branded type，传入前按现有 `asAgentId`/string 风格处理，不新增 cast helper。

- [ ] **Step 5: 顶层 session panel 过滤 nested child**

在 `getVisibleAgentTasks()` 的 local agent 条件中加入：

```ts
isPanelAgentTask(t) &&
t.parentAgentId === undefined &&
t.evictAfter !== 0 &&
!isWorkflowChildAgent(t, workflowToolUses)
```

保留 child task 本身，不从 AppState 删除；只过滤根 session panel。

- [ ] **Step 6: 更新现有注册测试调用点**

所有测试中调用 `registerAsyncAgent()` / `registerAgentForeground()` 时显式传：

```ts
spawnDepth: 1
```

只有递归测试传：

```ts
parentAgentId: 'agent-parent'
spawnDepth: 2
```

不要给 API 参数设置隐式错误默认值来掩盖漏改调用点；生产调用和测试调用都应明确层级。

- [ ] **Step 7: 运行层级与 launch metadata 测试**

Run:

```bash
bun src/components/CoordinatorAgentStatus.test.ts
bun src/tools/AgentTool/agentLaunchParams.test.ts
bun src/tools/AgentTool/subagentDepth.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: 全部 PASS；metadata 的 `spawnDepth` 与 task state 一致。

- [ ] **Step 8: 确认层级展示范围**

验收静态行为：

```text
main
parent-probe
```

不应在根 panel 出现：

```text
child-probe
```

但 `AppState.tasks[childAgentId]` 必须仍存在，状态、progress、abort controller 和 result 都可更新。该断言应放在注册/生命周期测试中，而不是 UI formatter 测试中。

---

### Task 6: 静态检查、构建和真实 TUI 验收

**Files:**
- Verify: all modified files
- Runtime artifacts: `/tmp/claude-agent-progress-fix-20260710/`

- [ ] **Step 1: 运行相关测试集合**

Run:

```bash
bun src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
bun src/tools/AgentTool/foregroundProgressUpdate.test.ts
bun src/components/CoordinatorAgentStatus.test.ts
bun src/tools/AgentTool/agentProgressPayload.test.ts
```

Expected: 每个脚本输出对应的 `passed`，进程退出码均为 0。

- [ ] **Step 2: 运行 lint**

Run:

```bash
bun run lint
```

Expected: exit code 0；不得通过放宽 lint 或添加无关 disable 规避。

- [ ] **Step 3: 检查 Makefile 版本和构建入口**

确认：

```text
VERSION := 2.1.178
build -> CLAUDE_CODE_VERSION=$(VERSION) bun package:binary
```

如 Makefile 在实施期间未变化，执行：

```bash
make build
```

Expected: 生成新的 `./built-claude`，exit code 0。

- [ ] **Step 4: 用 tmux 驱动真实递归 Agent 测试**

创建独立 artifact 目录和 tmux session：

```bash
mkdir -p /tmp/claude-agent-progress-fix-20260710
tmux kill-session -t claude-agent-progress-fix 2>/dev/null || true
tmux new-session -d \
  -s claude-agent-progress-fix \
  -x 180 -y 48 \
  -c "$PWD" \
  './built-claude --dangerously-skip-permissions --debug-file /tmp/claude-agent-progress-fix-20260710/built-debug.log'
```

通过 `tmux set-buffer`/`paste-buffer` 发送：

```text
请使用 Agent 工具启动一个后台 general-purpose 子 Agent，描述为 parent-probe。要求 parent-probe 再使用 Agent 工具启动一个后台 general-purpose 子 Agent，描述为 child-probe。两个 Agent 都至少调用 Glob 和 Read，然后执行 sleep 20 再返回。
```

- [ ] **Step 5: 在运行期间至少捕获四个状态**

保存：

```text
/tmp/claude-agent-progress-fix-20260710/01-parent-start.txt
/tmp/claude-agent-progress-fix-20260710/02-parent-progress.txt
/tmp/claude-agent-progress-fix-20260710/03-child-progress.txt
/tmp/claude-agent-progress-fix-20260710/04-completed.txt
```

验收标准：

1. 初始行允许短暂出现 `0 tok · 0 tools`。
2. parent 产生第一轮完整响应/tool result 后，token 必须大于 0。
3. child 产生第一轮完整响应/tool result 后，其 task progress token 必须大于 0；通过测试/debug evidence 验证，不要求把 child 提升为根 session 行。
4. 根 Agent panel 只显示 `main` 和 `parent-probe`，匹配 official `2.1.201`；不得把 `child-probe` 平铺成第二个根 session。
5. child task 仍存在于 `AppState.tasks`，并能独立完成、通知和清理。
6. tool count 随客户端 `tool_use` 增长，不因 usage refresh 翻倍。
7. parent 和 child 的计数保持独立，不递归相加。
8. completed row 的 token 不回退为 0。

- [ ] **Step 6: 验证纯文本 Agent 的 0 tools 语义未被破坏**

另起一个后台 Agent，明确要求“不调用任何工具，只回复 OK”。验收：

```text
<non-zero tok> · 0 tools completed
```

这证明修复没有把 assistant response 或 server event 错计为 client tool。

- [ ] **Step 7: 清理测试会话并保留证据**

Run:

```bash
tmux kill-session -t claude-agent-progress-fix
```

保留 `/tmp/claude-agent-progress-fix-20260710/` 中的 debug log 和 pane captures；根据项目要求不要由助手自行删除调试日志。

- [ ] **Step 8: 检查最终 diff**

Run:

```bash
git status --short
git diff -- src/tasks/LocalAgentTask/LocalAgentTask.tsx \
  src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts \
  src/tools/AgentTool/agentToolUtils.ts \
  src/tools/AgentTool/asyncLifecycleOrdering.test.ts \
  src/tools/AgentTool/AgentTool.tsx \
  src/tools/AgentTool/foregroundProgressUpdate.test.ts
```

Expected: 仅包含计划内修复与测试；无 debug logging、临时代码、无关格式化或依赖变化。

---

## 实施注意事项

1. **不要在 UI 层修。** `CoordinatorAgentStatusRows.ts` 应继续只格式化 `task.progress`。
2. **不要把 token 改成字符估算。** 本问题已有真实 API usage，只是读取时机错误。
3. **不要在 `claude.ts` 延迟所有 assistant yield。** 这会改变 streaming tool execution 和 UI 时序，范围远大于当前需求。
4. **必须幂等后再刷新。** 否则重复处理 mutable assistant message 会把 tool 和 output token 加倍。
5. **AppState 更新与 SDK event 分开。** TUI progress 应无条件更新；SDK summary/event 继续遵循现有 feature gate。
6. **不新增依赖。** 当前工具足够完成修复。
7. **不自动提交。** 项目要求用户明确批准后才能创建 git commit；实施完成、验证通过后先报告 diff 和测试结果，再询问是否提交。

## 自检结果

- Spec coverage：覆盖 token 永久为 0、后台/前台/转后台、tool 偶发 0、递归 Agent 独立计数、完成通知口径。
- Placeholder scan：无 TBD、TODO 或“类似处理”等占位步骤。
- Type consistency：统一使用 `ProgressTracker`、`AgentProgress`、`refreshLastAssistantProgress()`、`publishAgentProgress()`。
- Scope control：没有改变 server-side tool 统计口径，没有改 UI formatter，没有引入 token 估算或依赖。
