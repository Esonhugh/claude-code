# /goal 完整语义与自动清理设计

## 背景

当前 `/goal` 主要依赖 prompt command 和 session Stop hook 实现“持续工作直到目标完成”。用户指出一个关键风险：目标已经达成时，Stop hook verifier 可能返回成功，但 active goal 与对应 hook 没有被自动 clear，导致后续 turn 仍携带过期 goal 状态或 hook。

本设计选择完整方案：对齐官方 v2.1.165 的核心语义，补齐自动清理、结构化状态记录、resume 恢复、clear aliases、长度限制、空参数状态查询和更可靠的 hook 身份管理。UI 输入框 parity 不纳入本次范围。

## 目标

- Stop hook verifier 判定目标达成后，立即自动清理 active goal。
- 用结构化 transcript sentinel 记录 goal 生命周期，避免只靠自然语言推断。
- resume 时能恢复未完成 goal，不恢复已达成、已清理或失败 goal。
- `/goal` 命令行为清晰：设置、查询、清理三类路径互不混淆。
- 避免旧 hook、延迟 hook result 或重复 hook 误删/误清理当前 goal。

## 非目标

- 不实现 `/goal` 空参数时的交互式输入 UI。
- 不改变 Stop hook 主循环的整体控制流。
- 不引入跨 session 的永久 goal 存储；恢复依据只来自 transcript。
- 不实现复杂 goal 规划器或专用 agent。

## 状态模型

将当前简单状态：

```ts
goalStatus: { active: boolean; prompt?: string }
```

升级为：

```ts
type GoalStatus =
  | {
      active: false
      lastCompleted?: GoalCompletedSummary
    }
  | {
      active: true
      id: string
      prompt: string
      iterations: number
      setAt: number
      tokensAtStart?: number
      lastReason?: string
    }

type GoalCompletedSummary = {
  id: string
  prompt: string
  status: 'met' | 'cleared' | 'failed'
  completedAt: number
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}
```

`id` 用于区分旧 hook 与当前 active goal。Stop hook success callback 只有在 `goalStatus.active === true` 且 `goalStatus.id` 与 hook 绑定 id 一致时，才允许清理。

## Transcript sentinel

新增结构化 attachment：

```ts
type GoalStatusAttachment = {
  type: 'goal_status'
  id: string
  condition: string
  status: 'active' | 'met' | 'cleared' | 'failed'
  sentinel: true
  met?: boolean
  failed?: boolean
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}
```

写入时机：

1. `/goal <condition>` 成功设置后写入 `status:'active'`。
2. Stop hook verifier 返回 `ok:true` 后写入 `status:'met'`。
3. 用户执行 `/goal clear|stop|off|reset|none|cancel` 后写入 `status:'cleared'`。
4. 设置新 goal 替换旧 goal 时，先为旧 goal 写入 `status:'cleared', reason:'replaced'`，再写入新 goal 的 `active` sentinel。
5. 若后续支持明确失败路径，写入 `status:'failed'`。

为兼容官方格式和后续恢复逻辑：

- `met` 为 `true` 表示不应恢复，适用于 `met` 和 `cleared`。
- `failed` 为 `true` 表示不应恢复。
- `active` sentinel 的 `met` 和 `failed` 均为 `false` 或省略。

## 命令行为

### `/goal <condition>`

- trim 输入。
- 如果长度超过 4000 字符，返回错误文本，不注册 hook，不写 sentinel，不触发 query。
- 如果 hooks 被禁用或 workspace 不可信，返回错误文本，不注册 hook。
- 如果已有 active goal：
  - 移除旧 goal hook。
  - 写入旧 goal 的 `cleared` sentinel，`reason:'replaced'`。
- 生成新 goal id。
- 设置 `goalStatus.active=true`，初始化 `iterations=0`、`setAt=Date.now()`。
- 写入 `active` sentinel。
- 注册 goal Stop hook 和 success callback。
- 返回 goal prompt 并触发 query，让主循环立即开始执行。

### `/goal`

不再设置 `(no goal provided)`。

- 无 active goal：返回 `No goal set. Usage: /goal <condition>`。
- 有 active goal：返回当前 goal 状态，包括：
  - condition
  - iterations，若为 0 显示 `not yet evaluated`
  - lastReason，如存在则显示 `Last check: ...`

不触发 query，不注册 hook。

### `/goal clear|stop|off|reset|none|cancel`

- 如果没有 active goal，返回 `No goal set`。
- 如果有 active goal：
  - 移除 goal hook。
  - 写入 `cleared` sentinel。
  - 设置 `goalStatus.active=false`，可写入 `lastCompleted`。
  - 返回 `Goal cleared: <condition>`。

不触发 query，不注册 hook。

## Hook 注册与自动清理

新增专用 helper，集中管理 goal hook：

```ts
registerGoalStopHook({
  setAppState,
  sessionId,
  goalId,
  condition,
  appendGoalStatusAttachment,
})
```

它负责：

1. 移除旧 goal hook。
2. 注册新的 Stop hook。
3. 绑定 `onHookSuccess`。

`onHookSuccess` 的处理顺序：

1. 读取当前 `goalStatus`。
2. 如果不是 active，或者 id 不匹配，直接返回，避免旧 hook 延迟成功清理新 goal。
3. 根据当前状态计算 `iterations`、`durationMs`、`tokens`。
4. 写入 `goal_status status:'met'` sentinel。
5. 移除 goal Stop hook。
6. 设置 `goalStatus.active=false`，写入 `lastCompleted.status='met'`。

Stop hook 返回 `ok:false` 时不清理 goal。应在 hook 结果处理路径中更新：

- `iterations += 1`
- `lastReason = reason`

主循环仍按现有 Stop hook 机制，把 reason 作为隐藏反馈继续执行。

## Hook 身份与避免误删

推荐为 goal hook 增加稳定身份：

```ts
const GOAL_HOOK_ID = 'builtin-goal-stop-hook'
```

优先方案是扩展 session hook entry metadata，例如：

```ts
source: 'builtin:goal'
goalId: string
```

如果不希望第一阶段改 session hook 类型，可先封装删除逻辑：只删除 matcher 为空、类型匹配、prompt 与 goal condition 匹配的 goal hook。后续再补 metadata。

不建议继续在 command 层散落调用 `removeSessionHook(..., goalStopHook)`，因为它依赖 hook object 相等，未来容易因字段变化而漏删或误删。

## Resume restore

新增：

```ts
findGoalToRestore(messages): GoalStatusAttachment | null
restoreGoalFromTranscript(messages, setAppState): void
```

`findGoalToRestore` 从 transcript 末尾倒序查找最后一个 `goal_status` attachment：

- `status:'active'` 且非 `met`、非 `failed`：返回该 goal。
- `status:'met' | 'cleared' | 'failed'`：返回 null。
- 没有 attachment：返回 null。

`restoreGoalFromTranscript`：

1. 调用 `findGoalToRestore`。
2. 没有可恢复 goal 时，确保 `goalStatus.active=false`。
3. 有可恢复 goal 时：
   - 检查 hooks/trust gate。
   - 重新注册 goal Stop hook。
   - 恢复 `goalStatus.active=true`。
   - `iterations` 从 attachment 读取，默认 0。
   - `setAt` 可用当前时间；若 transcript timestamp 可用，可使用原 timestamp。

## 边界条件

- 超长 condition：拒绝设置，不注册 hook。
- hooks disabled：拒绝设置，不给用户“会持续执行”的错觉。
- untrusted workspace：拒绝设置，提示用户完成 trust 流程。
- replacement：旧 goal 必须先写 cleared sentinel，防止 resume 恢复旧目标。
- delayed hook result：success callback 必须校验 goal id。
- duplicate hooks：设置新 goal 前清理旧 goal hook，确保同一 session 只有一个 active goal hook。

## 测试计划

### Command tests

更新 `src/commands/goal.test.ts`：

- `/goal clear`、`stop`、`off`、`reset`、`none`、`cancel` 都清理 goal。
- `/goal` 空参数不激活 goal；无 active goal 时返回 usage。
- active goal 下 `/goal` 空参数返回当前状态。
- 超过 4000 字符时不设置 active goal，不注册 Stop hook。
- 设置新 goal 前清理旧 hook，并写入旧 goal replaced/cleared sentinel。

### Hook callback tests

- Stop hook success 自动清理 goal。
- success for stale goal id 不清理当前新 goal。
- Stop hook blocking 不清理 goal，只更新 `iterations` 与 `lastReason`。
- 清理时只移除 goal hook，不影响其他 Stop hook。

### Restore tests

- 最后一个 `goal_status active` 会恢复 goal 并重新注册 Stop hook。
- 最后一个 `met`、`cleared` 或 `failed` 不恢复。
- replacement 场景不恢复旧 goal。
- hooks/trust gate 失败时不恢复，并清空 active goal。

## 实施顺序

1. 引入 goal clear aliases、长度限制、空参数状态查询。
2. 增加 goal id 和 richer `goalStatus`。
3. 封装 goal hook 注册/清理 helper，并实现 `onHookSuccess` 自动清理。
4. 增加 `goal_status` attachment 写入。
5. 实现 resume restore。
6. 补充 hook blocking 时的 `iterations` / `lastReason` 更新。
7. 最后补充 hooks/trust gate 检查和必要 telemetry/debug log。

## 验收标准

- 目标达成后，Stop hook success 会自动移除 goal hook，且 `goalStatus.active=false`。
- 达成后的 transcript 最后 goal sentinel 是 `met`，resume 不会恢复该 goal。
- 未完成 goal 的 transcript 最后 sentinel 是 `active`，resume 会恢复该 goal。
- 用户主动 clear 后，resume 不会恢复该 goal。
- `/goal` 空参数不会创建无意义目标。
- clear aliases 不会被误当成新目标。
