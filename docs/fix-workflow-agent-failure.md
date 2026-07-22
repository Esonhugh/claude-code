# Workflow Agent Failure Handoff

## 目标

修复 workflow 中 Agent 明明失败却被标记为成功的问题，并同步修正失败重试、journal/resume 和 Agent 计数模型。

本 handoff 基于对 session `bc408503-a83a-42fb-ae9a-92ed92854d60` 的只读审计。文档记录的是实施前基线；修复、测试和 binary 验收状态以当前工作区及最终报告为准。未经用户批准不创建 commit。

## 已确认的问题

### 1. API Error 被显示为成功

`angle-B` 的第二次物理执行最终产生 synthetic API Error：

```json
{
  "error": "unknown",
  "isApiErrorMessage": true,
  "message": {
    "model": "<synthetic>",
    "content": [
      {
        "type": "text",
        "text": "API Error: An error occurred while processing your request..."
      }
    ]
  }
}
```

但 workflow UI 最终显示：

```text
✓ angle-B
```

这不是单纯的 UI glyph 错误。错误状态已经在 AgentTool 和 workflow runtime 中被写成 `completed`。

完整传播链：

```text
Synthetic API Error assistant message
→ AgentTool 未检查 isApiErrorMessage/error
→ AgentTool 返回 status: completed
→ Workflow 提前调用 completeWorkflowAgent(completed)
→ journal 写入普通 result
→ completedAgentIds 加入 angle-B
→ workflowDetailAgentStatus 返回 done
→ WorkflowDetailDialog 渲染 ✓
```

### 2. StructuredOutput 要求与可用工具冲突

workflow schema prompt 要求 Agent 必须调用：

```text
You MUST call the `StructuredOutput` tool exactly once
```

但 Agent context 没有注入 `StructuredOutput`。现有测试还明确断言该工具不存在。

第一次 `angle-B` 因而反复执行：

```text
ToolSearch select:StructuredOutput
No matching deferred tools found
```

持续产生的 progress 会刷新 stall timer，导致该 Agent 长时间不被自动判定 stalled，最后由用户中断并重试。

### 3. Workflow 在 schema 校验前写入 completed

`workflowScriptRuntime.ts` 当前先调用 `completeWorkflowAgent()`，再尝试解析 structured output。即使输出是 API Error、空文本或 schema 无效，task state 也已经被标记为成功。

### 4. Journal 无法表示失败和 retry

workflow journal 的 `result` entry 没有以下字段：

- `status`
- `error`
- `errorKind`
- `attempt`
- `retryOf`

因此 API Error 被保存成普通成功结果，resume cache 也可能直接重用该失败文本。

### 5. Retry 身份模型不一致

手动 retry 时，task/UI Agent ID 会变成：

```text
angle-B (retry 1)
```

但 runtime label、journal `agentId` 和 subagent description 仍然是：

```text
angle-B
```

这造成 UI ID、controller ID、runtime label、journal ID 和物理 Agent attempt 无法稳定关联。

### 6. Agent 总数使用静态最大 fan-out

bundled `code-review` static plan 的总数是 45，但本次 high 配置实际只启动：

- Scope：1
- Find：7
- Verify：按候选动态创建，本次 1
- Sweep：high 默认关闭

journal 实际记录：

- `started`：9
- `result`：8

任务注册却固定使用：

```ts
agentCount: plan.totalAgents
```

UI 又优先显示 `task.agentCount`，所以展示的是理论最大 Agent 数，而不是当前运行实际启动或动态规划的数量。

### 7. Retries 指标不是历史重试数

`formatWorkflowStatus.ts` 当前将所有 phase 的 `failedAgentIds.length` 相加作为 `Retries`。成功 retry 会清除 failed ID，因此这个数字会下降，不能表示历史 attempt 或 retry 次数。

## 关键证据

### Session 和 workflow

- Session ID：`bc408503-a83a-42fb-ae9a-92ed92854d60`
- Task ID：`wnh6xoyzg`
- Workflow Run ID：`wf_5d657876-454`
- Workflow selector：`code-review`

### 主 session 日志

```text
/Users/esonhugh/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/bc408503-a83a-42fb-ae9a-92ed92854d60.jsonl
```

### Workflow journal

```text
/private/tmp/claude-502/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/workflow-runs/wf_5d657876-454/journal.jsonl
```

该 journal 中 `angle-B` 被记录为普通结果：

```json
{
  "type": "result",
  "agentId": "angle-B",
  "phase": "Find",
  "index": 2,
  "result": "API Error: An error occurred while processing your request..."
}
```

### 第一次 angle-B

```text
/Users/esonhugh/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/bc408503-a83a-42fb-ae9a-92ed92854d60/subagents/agent-a3b13be689bf5d6a4.jsonl
```

终态为：

```text
[Request interrupted by user]
```

此前多次搜索不存在的 `StructuredOutput`。

### 第二次 angle-B

```text
/Users/esonhugh/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/bc408503-a83a-42fb-ae9a-92ed92854d60/subagents/agent-aa9c6f42f8e19c1b5.jsonl
```

最后一条 assistant message 包含：

```json
{
  "error": "unknown",
  "isApiErrorMessage": true,
  "message": {
    "model": "<synthetic>"
  }
}
```

### Subagent metadata

```text
/Users/esonhugh/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/bc408503-a83a-42fb-ae9a-92ed92854d60/subagents/agent-a3b13be689bf5d6a4.meta.json
/Users/esonhugh/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code/bc408503-a83a-42fb-ae9a-92ed92854d60/subagents/agent-aa9c6f42f8e19c1b5.meta.json
```

两次物理执行都使用：

```json
{
  "agentType": "general-purpose",
  "description": "code-review: angle-B",
  "toolUseId": "call_waNBvrf3F1pWQF4zJ8kgxVRH",
  "spawnDepth": 1
}
```

### 证据限制

- `~/.claude/debug` 中未找到该 session、Task ID 或 Run ID 对应的内部 marker。
- 该 session 使用的是全局安装 binary，而不是本轮从当前工作区构建的 `./built-claude`。
- 因此现有日志足以证明该 session 的错误状态传播，但实施修复后仍需使用当前源码新构建 binary 做正式回归验收。

## 相关代码

### API Error message 构造

`src/utils/messages.ts`

- `createAssistantAPIErrorMessage()` 会设置 `isApiErrorMessage: true`。
- 普通 synthetic interruption 检测只匹配固定文本。
- 项目已有 `isSyntheticApiErrorMessage()`，但 AgentTool 完成路径没有用它决定失败状态。

### Agent result 归类

`src/tools/AgentTool/agentToolUtils.ts`

`finalizeAgentTool()` 只读取最后一条 assistant message 的文本，没有检查：

- `isApiErrorMessage`
- `error`
- `apiError`

`src/tools/AgentTool/AgentTool.tsx`

同步 Agent 只有 generator 真正抛错时才设置 `syncAgentError`。如果 API Error 只是 synthetic assistant message，就继续返回：

```ts
status: 'completed'
```

### Workflow Agent 完成顺序

`src/tools/WorkflowTool/workflowScriptRuntime.ts`

- `buildSchemaPrompt()` 强制要求 `StructuredOutput`。
- `agentTool.call()` 没有注入该 schema tool。
- `completeWorkflowAgent(status: 'completed')` 在 structured output 解析之前发生。
- `realAgent()` 对返回值无条件写入 journal。

### Journal 和 resume

`src/tools/WorkflowTool/workflowJournal.ts`

- `WorkflowJournalResultEntry` 没有状态和 attempt。
- 所有 `result` entries 都会被加载为成功 resume cache。

### Workflow task state 和 retry

`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`

- `completeWorkflowAgent()` 将 ID 加入 `completedAgentIds`。
- 手动 retry 通过展示名生成 `${baseAgentId} (retry ${retryAttempt})`。
- 成功完成会删除同 index 的旧 failed/retry IDs，导致历史状态丢失。

### UI 状态和 glyph

`src/components/tasks/workflowDetailModel.ts`

- `completedAgentIds` 命中后返回 `done`。
- result 不是 explicit failed/skipped/running 时也返回 `done`。

`src/components/tasks/WorkflowDetailDialog.tsx`

状态映射：

```text
done   → ✓
failed → ✗
```

UI 不检查 output 文本，所以不能依靠匹配 `API Error:` 修复该问题。

### Agent 总数和 retry 统计

`src/tools/WorkflowTool/bundled/index.ts`

- static plan 使用最大 fan-out。
- 实际 script 根据 effort、候选数量和 sweep 配置动态生成 Agent。

`src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`

- `Retries` 当前基于 `failedAgentIds.length`，不是历史 retry count。

## 建议实施顺序

### 阶段 1：先添加最小失败测试

测试应先复现以下终态 assistant message：

```ts
{
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'unknown',
  message: {
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: test failure' }],
  },
}
```

至少断言：

1. AgentTool 不返回 `status: completed`。
2. Workflow result 为 `failed`。
3. `completedAgentIds` 不包含该 Agent。
4. `failedAgentIds` 包含该 Agent attempt。
5. UI glyph 为 `✗`。
6. journal 不写成功 `result`，或者写入显式 `status: failed`。
7. resume cache 不复用该失败输出。

测试还应覆盖：

- structured output tool 缺失；
- structured output parse/schema failure；
- manual retry 后首次 attempt 保持 failed、下一 attempt 独立记录；
- retry 成功后历史 retry 数不会回退；
- static maximum 与 actual started count 分离。

### 阶段 2：修复 AgentTool API Error 分类

推荐在 AgentTool 的公共终态归一化位置处理，而不是仅在 WorkflowTool 中匹配错误文本。

要求：

- 使用 message metadata，不匹配本地化或供应商相关的 `API Error:` 文本前缀。
- 最终 assistant message 为 `isApiErrorMessage` 或明确携带 fatal error 时，返回失败或抛出可分类异常。
- 保留已产生的 usage、duration、tool-use count，失败不应丢失统计。
- 不要把普通 partial assistant content 和 synthetic API Error 混为一类。

### 阶段 3：调整 Workflow 完成顺序

只有以下步骤成功后才能调用 `completeWorkflowAgent(status: 'completed')`：

1. AgentTool 成功完成；
2. 获取有效输出；
3. 若声明 schema，则 structured output 已提取；
4. schema 验证通过。

任一步失败时：

- 调用 workflow failure 路径；
- 设置明确的 `errorKind`；
- journal 记录失败事件；
- 不进入成功 resume cache。

### 阶段 4：解决 StructuredOutput 工具契约

二选一，但必须保持 prompt、runtime 和测试一致：

1. 为 schema Agent 注入真实、按 schema 校验的 `StructuredOutput` tool；或
2. 删除“必须调用不存在工具”的要求，使用明确支持的返回协议。

若采用工具方案，应验证：

- 工具只对当前 schema Agent 可见；
- nested Agent tool 禁用策略不误删该工具；
- schema validation error 可反馈给 Agent 重试；
- 成功 tool call 的结构化结果能被 runtime 直接读取；
- 不依赖最终文本正则提取 JSON。

### 阶段 5：重构 journal 和 retry identity

建议区分：

- `logicalAgentId`：例如 `angle-B`；
- `attemptId`：每次执行唯一；
- `attempt`: 0、1、2；
- `retryOfAttemptId`；
- `status`: started/completed/failed/interrupted/stopped；
- `error` 和 `errorKind`。

不要把 `angle-B (retry 1)` 当作唯一身份。展示名称应由 logical ID 和 attempt 派生，不应反过来承担状态关联。

journal 应记录独立生命周期事件，resume 时只缓存验证成功的 completed attempt。

### 阶段 6：修复 Agent 计数

至少分离：

- `plannedMaxAgents`：static plan 的理论最大值；
- `startedAgentAttempts`：实际启动次数；
- `activeAgentAttempts`；
- `completedAgentAttempts`；
- `failedAgentAttempts`；
- `logicalAgents`；
- `retryCount`。

UI 不应将 static plan 的 45 直接显示为本次实际总数。对于运行时动态 fan-out，可显示已启动数和当前已知计划数，或明确标注最大值。

## 测试与验收要求

### 定向测试

优先运行相关 Bun tests，具体文件名以现有测试布局为准。重点覆盖：

- AgentTool synthetic API Error；
- WorkflowTool schema success/failure；
- LocalWorkflowTask retry transitions；
- journal resume filtering；
- workflow detail model status；
- WorkflowDetailDialog glyph；
- dynamic Agent counts。

### 静态检查

修复完成后至少运行：

```bash
bunx tsc --noEmit --pretty false
bun run lint
git diff --check
```

如项目相关测试已有更小入口，先运行定向测试，再视结果扩大范围。

### Build

先读取 `Makefile` 确认当前 `VERSION` 和目标，再运行：

```bash
make build
```

必须使用本轮从当前源码成功构建的 `./built-claude`，不能回退旧 binary 并声称通过。

### Workflow 交互验收

该问题涉及 Workflow、Agent lifecycle、retry 和 TUI，必须按照项目 skill `claude-agent-workflow-validation` 的规则，在 tmux 中脚本驱动最新 `built-claude`：

- slash/workflow 输入必须发送到 binary stdin；
- parent-side Agent/Workflow/Task 不能作为 binary-side 证据；
- 保存 ready/submitted/running/terminal pane；
- 保存 exact input、session、pane target、debug log 和 Git 状态对照；
- 失败 Agent 必须显示 `✗`，不得显示 `✓`；
- retry 必须产生可关联但独立的 attempt；
- journal、task state、pane 和 debug marker 必须来自同一次运行；
- 没有完整终态证据时标记 `running` 或 `not covered`，不能判定 passed。

建议至少验证两个受控场景：

1. Agent 返回 synthetic API Error，workflow 显示 failed，journal 不缓存为成功。
2. 第一次 attempt 失败后手动 retry 成功，UI、计数、journal 和 resume 都保留正确历史。

## 完成定义

只有满足以下条件才能认为修复完成：

- synthetic API Error 不再返回 Agent `completed`；
- structured output 无效时 workflow 不再提前写 completed；
- schema prompt 与实际可用工具一致；
- failed/interrupted attempt 不进入成功 resume cache；
- journal 可区分 logical Agent 和每个 attempt；
- retry 历史和计数稳定，不因后续成功而消失；
- static max fan-out 与 actual started count 分离；
- workflow UI 对失败显示 `✗`；
- 相关 Bun tests、类型检查、lint、diff check 和 build 通过；
- 最新 `built-claude` 的脚本化 tmux 验收具有完整且同次运行的证据；
- diff 不包含临时代码、调试日志或无关重构；
- 未经用户明确批准，不创建 commit、push 或 PR。
