# /goal 实现分析与优化计划

## Scope

- Target: `recover/claude-v2.1.165.js`
- Current code: `src/commands/goal.ts`, `src/commands/goal.test.ts`, `src/main.tsx`, `src/utils/hooks/sessionHooks.ts`
- Authorization boundary: 目标文件位于当前授权仓库内，仅本地静态分析，未修改运行时代码。
- Question: 对照官方 v2.1.165 的 `/goal` 实现，分析当前实现差异，并给出优化建议。

## Evidence

- Source-confirmed:
  - 当前 `/goal` command 主实现：`src/commands/goal.ts:56`
  - 当前 Stop hook verifier prompt：`src/commands/goal.ts:7`
  - 当前 `goalStatus` 更新：`src/commands/goal.ts:79`
  - 当前 `/goal clear` 移除 session Stop hook：`src/commands/goal.ts:90`
  - 当前初始状态：`src/main.tsx:4099`
  - 当前 session hook 增删实现：`src/utils/hooks/sessionHooks.ts:68`, `src/utils/hooks/sessionHooks.ts:225`
  - 当前测试覆盖：`src/commands/goal.test.ts:34`
- Binary-observed:
  - 官方 v2.1.165 通过 bundle offset 定位到 `/goal` 相关实现：
    - offset `15511635`：设置 goal、注册 Stop hook、写入 `activeGoal`。
    - offset `15512511`：清除 goal、移除 Stop hook、写入清除 attachment。
    - offset `15512930`：生成 `goal_status` attachment。
    - offset `18585000`：`/goal` command call，含空参数 UI、clear aliases、长度限制、query prompt。
    - offset `20507000`：`restoreGoalFromTranscript` / `findGoalToRestore`，从 transcript 恢复 goal。
- Runtime-observed:
  - 未运行 CLI，仅静态分析。
- Inference / needs verification:
  - 当前源码中未发现 transcript 恢复和 `goal_status` attachment 机制，可能是尚未移植或使用了不同命名；需要全局进一步确认后再实现。

## Findings

### 1. 当前 `/goal` 实现结构

当前实现集中在 `src/commands/goal.ts`。

核心行为：

1. 定义 Stop hook verifier prompt。
   - Stop hook 判断当前目标是否完成。
   - 未完成时返回继续执行指令。
   - 证据：`src/commands/goal.ts:7`

2. 定义 goal prompt。
   - 将用户输入包装成“自主完成目标”的提示。
   - 要求必要时使用 task/todo tools。
   - 要求完成前验证结果。
   - 要求可用 Agent 接续工作。
   - 证据：`src/commands/goal.ts:27`

3. `clear` 判断。
   - 当前只接受精确的 `clear`。
   - 证据：`src/commands/goal.ts:46`

4. command 配置。
   - `type: 'prompt'`
   - `name: 'goal'`
   - `allowedTools: [AGENT_TOOL_NAME]`
   - 自带 Stop hook。
   - 证据：`src/commands/goal.ts:56`

5. hook 注册与查询控制。
   - `/goal clear` 不注册 hook，不触发 query。
   - 普通 `/goal <condition>` 注册 Stop hook 并触发 query。
   - 证据：`src/commands/goal.ts:73`

6. 状态更新。
   - 普通 goal：`goalStatus: { active: true, prompt }`
   - clear：`goalStatus: { active: false }`
   - 证据：`src/commands/goal.ts:79`

7. clear 时移除 session Stop hook。
   - 使用 `removeSessionHook(context.setAppState, getSessionId(), 'Stop', goalStopHook)`。
   - 证据：`src/commands/goal.ts:90`

当前实现比较轻量，主要依赖 prompt command 机制和 session Stop hook 实现“持续工作直到目标完成”。

### 2. 官方 v2.1.165 的 `/goal` 关键逻辑

从 `recover/claude-v2.1.165.js` 可观察到官方实现更完整，主要包含以下模块。

#### 2.1 goal 设置函数

官方设置 goal 时会：

1. 检查 hooks gate / trust gate。
2. 移除当前 session 已存在的 goal Stop hook。
3. 添加新的 session-scoped Stop hook。
4. 设置 `activeGoal`：
   - `condition`
   - `iterations: 0`
   - `setAt: Date.now()`
   - `tokensAtStart`
5. 向 transcript 追加 `goal_status` attachment，标记 goal 已设置但未完成。
6. 打 telemetry。

对应 bundle offset：`15511635`。

#### 2.2 goal 清除函数

官方清除 goal 时会：

1. 查找当前 session 中 matcher 为空且 skillRoot 为空的 prompt Stop hook。
2. 移除匹配 hook。
3. 清空 `activeGoal`。
4. 向 transcript 追加 `goal_status` attachment，标记 goal 已清除 / 已满足 sentinel。
5. 打 telemetry。

对应 bundle offset：`15512511`。

#### 2.3 goal 状态 attachment

官方使用 attachment 记录 goal 状态：

```js
{
  type: "attachment",
  attachment: {
    type: "goal_status",
    met: boolean,
    sentinel: true,
    condition: string
  }
}
```

对应 bundle offset：`15512930`。

这个 attachment 是后续 resume 恢复、判断最后一个 goal 状态的关键。

#### 2.4 `/goal` command call

官方 `/goal` command 的交互逻辑包含：

1. 空参数时打开 Goal 输入 UI。
2. 支持多个 clear aliases：
   - `clear`
   - `stop`
   - `off`
   - `reset`
   - `none`
   - `cancel`
3. goal 条件长度限制为 4000 字符。
4. 设置成功后返回：
   - `Goal set: <condition>`
   - `shouldQuery: true`
   - meta message：说明 Stop hook 已激活、应立即开始执行、完成后自动清除。

对应 bundle offset：`18585000`。

#### 2.5 resume 时恢复 goal

官方实现包含：

- `findGoalToRestore(messages)`：从 transcript 末尾倒序查找最后一个 `goal_status` attachment。
  - 如果最后状态是 `met` 或 `failed`，不恢复。
  - 否则恢复其中的 `condition`。
- `restoreGoalFromTranscript(messages, setAppState)`：
  - 检查 gate。
  - 重新注册 Stop hook。
  - 恢复 `activeGoal`。
  - 打 `tengu_goal_restored_on_resume` telemetry。

对应 bundle offset：`20507000`。

## 差异分析

### 差异 1：当前没有发现 `goal_status` transcript attachment

当前实现只更新 `goalStatus` AppState，没有发现向 transcript 追加 `goal_status` attachment 的逻辑。

影响：

- goal 状态可能无法跨 resume 恢复。
- transcript 中缺少明确的 goal set / clear sentinel。
- Stop hook verifier 只能从文本上下文推断 active goal，不如结构化 attachment 稳定。

优化建议：引入结构化 `goal_status` attachment，记录 goal set / clear / met / failed 状态。

优先级：高。

### 差异 2：当前没有发现 resume restore goal 逻辑

官方从 transcript 中恢复未完成 goal。当前搜索 `goalStatus` / `activeGoal` / `goal_status` 未发现类似恢复路径。

影响：

- 用户 `/goal <condition>` 后退出并 resume，goal 可能丢失。
- session Stop hook 是内存态，resume 后如果不恢复，持续执行语义失效。

优化建议：

1. 在 session resume / transcript load 流程中增加 `restoreGoalFromTranscript()`。
2. 从最后一个 `goal_status` attachment 判断是否需要恢复。
3. 恢复时重新注册 Stop hook，并设置 `goalStatus`。

优先级：高。

### 差异 3：clear aliases 支持不足

当前只支持：

```ts
args.trim().toLowerCase() === 'clear'
```

证据：`src/commands/goal.ts:46`

官方支持：

```text
clear, stop, off, reset, none, cancel
```

影响：用户输入 `/goal stop` 或 `/goal cancel` 时，当前会被当成新的目标，而不是清除目标。

优化建议：

```ts
const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
const isGoalClear = (args: string): boolean => GOAL_CLEAR_ALIASES.has(args.trim().toLowerCase())
```

优先级：中高。

### 差异 4：当前没有 goal 长度限制

官方限制 goal condition 最长 4000 字符。当前 `goal.ts` 未看到长度限制。

影响：

- 极长 goal 会进入 prompt 与 Stop hook，造成上下文膨胀。
- 可能影响 hook verifier 稳定性。

优化建议：

```ts
const GOAL_MAX_LENGTH = 4000
if (!clearGoal && args.trim().length > GOAL_MAX_LENGTH) {
  return [{ type: 'text', text: `Goal condition is limited to ${GOAL_MAX_LENGTH} characters (got ${args.trim().length})` }]
}
```

但需注意当前 command API 如何表达“系统显示但不 query / 不注册 hook”。如果 `shouldRegisterHooksForCommand()` 只看 args，则应把长度检查也纳入注册与 query 判断，避免超长 goal 仍注册 hook。

优先级：中高。

### 差异 5：当前 goal 状态字段较弱

当前状态：

```ts
goalStatus: { active: boolean; prompt?: string }
```

证据：`src/main.tsx:4099`

官方状态更丰富：

```js
activeGoal: {
  condition,
  iterations,
  setAt,
  tokensAtStart,
  lastReason?
}
```

影响：

- 无法展示目标已检查次数。
- 无法计算 goal 运行时长与 token 增量。
- Stop hook 每次反馈无法结构化记录。
- 无法实现 `/goal` 空参数查看当前 goal 状态。

优化建议：将 `goalStatus` 扩展为：

```ts
type GoalStatus =
  | { active: false }
  | {
      active: true
      prompt: string
      iterations: number
      setAt: number
      tokensAtStart?: number
      lastReason?: string
    }
```

优先级：中。

### 差异 6：当前 `/goal` 空参数行为与官方不同

当前空 goal 会变成：

```ts
(no goal provided)
```

证据：`src/commands/goal.ts:22`

官方交互模式下空参数打开 Goal 输入 UI；非交互模式下空参数展示当前 goal 状态或 usage。

影响：

- 用户误输入 `/goal` 会激活一个无意义目标。
- Stop hook 会围绕 `(no goal provided)` 运行，语义不清。

优化建议：

1. 如果当前 command framework 支持输入 UI，则空参数时打开 goal input。
2. 如果不支持 UI，至少改为不激活 goal，并返回 usage / 当前 goal 状态：
   - 无 active goal：`No goal set. Usage: /goal <condition>`
   - 有 active goal：`Goal active: <condition>`

优先级：中高。

### 差异 7：当前缺少 hooks / trust gate 检查

官方设置 goal 前会检查：

- hooks 是否被禁用。
- workspace 是否可信。

当前实现未在 `goal.ts` 中发现类似检查。

影响：

- 如果 hooks 实际不会执行，用户仍会看到 goal prompt，形成“以为会持续执行”的错觉。
- 在非 trusted workspace 中可能行为不一致。

优化建议：

1. 复用现有 hooks settings / trust 判断函数。
2. 在 `shouldRegisterHooksForCommand()` 或 `getPromptForCommand()` 早期阻止设置。
3. 返回明确系统消息：hooks disabled / workspace untrusted。

优先级：中。

### 差异 8：当前 `/goal clear` 移除 hook 方式可能过宽或过窄

当前移除逻辑：

```ts
removeSessionHook(context.setAppState, getSessionId(), 'Stop', goalStopHook)
```

证据：`src/commands/goal.ts:94`

官方移除逻辑是查找 matcher 为空、skillRoot 为空、type 为 prompt 的 Stop hook，然后逐个删除。

当前风险：

- 如果同 prompt hook 被添加多次，是否全部移除取决于 `isHookEqual()`。
- 如果未来 goal hook 从 `agent` hook 改为 `prompt` hook 或字段变化，clear 可能失效。
- 如果其他功能使用相同 hook prompt，可能误删。

优化建议：

1. 给 goal hook 增加稳定 id 或 dedicated type metadata。
2. clear 时只移除 goal 自己注册的 hook。
3. 同时清理所有旧版本 goal hook，兼容迁移。

优先级：中。

### 差异 9：当前 Stop hook verifier 未记录 iterations / lastReason

当前 verifier prompt 要求返回 continuation instruction，但源码中未看到把失败原因写回 `goalStatus.lastReason` 或增加 `iterations`。

官方状态含 `iterations` / `lastReason`，并能展示：

```text
Last check: ...
```

影响：

- 用户无法查看目标当前为什么未完成。
- 重复 Stop hook 触发不可观察。
- 难以调试 goal 卡住问题。

优化建议：

1. 在 Stop hook 执行结果处理路径中，识别 goal hook 结果。
2. 每次 verifier 执行后更新：
   - `iterations += 1`
   - `lastReason = reason`
3. goal 完成时写入 `goal_status met: true` attachment，并清理 active goal。

优先级：中。

## 建议落地顺序

### 第一阶段：修正用户可见语义

1. 支持 clear aliases：`clear` / `stop` / `off` / `reset` / `none` / `cancel`。
2. 空参数不再设置 `(no goal provided)`，改为显示 usage 或当前 active goal。
3. 增加 4000 字符长度限制，并确保超长 goal 不注册 hook、不触发 query。

### 第二阶段：补齐持久化与恢复能力

1. 引入 `goal_status` attachment。
2. 设置 goal 时追加未完成 sentinel。
3. clear / met / failed 时追加终止 sentinel。
4. 在 resume 流程中实现 `restoreGoalFromTranscript()`。

### 第三阶段：增强状态与可观测性

1. 扩展 `goalStatus`：记录 iterations、setAt、tokensAtStart、lastReason。
2. Stop hook 结果写回 goalStatus。
3. `/goal` 空参数显示当前状态、检查次数、最近失败原因。

### 第四阶段：安全与边界

1. 增加 hooks disabled / managed hooks / trust gate 检查。
2. 给 goal hook 加稳定 id，避免 clear 误删或漏删。
3. 增加 telemetry 或 debug log，便于分析 goal restore / clear / met。

## 测试建议

新增或更新 `src/commands/goal.test.ts`：

1. `/goal stop`、`/goal off`、`/goal reset`、`/goal none`、`/goal cancel` 都应清除 goal。
2. `/goal` 空参数不应设置 active goal。
3. 超过 4000 字符时不应注册 Stop hook、不应设置 active goal。
4. 设置新 goal 前应移除旧 goal hook。
5. `/goal clear` 应只移除 goal hook，不影响其他 Stop hook。
6. 如果引入 attachment：
   - 设置 goal 追加 `goal_status met:false sentinel:true`。
   - clear 追加 `goal_status met:true sentinel:true`。
   - resume 时最后一个未完成 goal 会恢复。
   - resume 时最后一个 met / failed goal 不恢复。
7. 如果扩展状态：
   - Stop hook 未完成时 `iterations` 增加，`lastReason` 更新。

## Commands / artifacts

- Local commands used:
  - 使用 `Grep` 搜索当前源码中的 `goal` / `goalStatus` / `activeGoal` / `goal_status`。
  - 使用 `Read` 阅读 `src/commands/goal.ts`、`src/commands/goal.test.ts`、`src/main.tsx`、`src/utils/hooks/sessionHooks.ts`。
  - 使用本地 `python3` 对 `recover/claude-v2.1.165.js` 进行 offset 片段提取。
- Local outputs created:
  - `docs/goal-update-plan.md`
- Code changes:
  - 仅新增分析文档，未修改运行时代码。

## Risks / limits

- `recover/claude-v2.1.165.js` 是压缩 bundle，变量名不可读，函数语义来自字符串与上下文推断。
- 当前只做静态分析，没有运行 CLI 或测试。
- `goal_status` attachment 需要确认当前消息类型系统是否已有 attachment 支持；如果没有，应先设计类型与 transcript 序列化兼容层。
- Stop hook 结果写回 `goalStatus` 需要找到 hook 执行聚合路径，避免只在 command 层修改导致状态无法更新。
