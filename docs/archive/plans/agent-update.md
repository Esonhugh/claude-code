# AgentTool 调度逻辑分析与优化计划

## Scope

- Target: `/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self/recover/claude-v2.1.165.js`
- Current code: `src/tools/AgentTool/AgentTool.tsx`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- Question: 学习官方 v2.1.165 的 `AgentTool` / Agent 调度逻辑，对比当前实现，找可优化点。
- Authorization boundary: 目标文件位于当前授权仓库内，仅本地读取与静态分析，未修改代码逻辑。

## Evidence

- Source-confirmed:
  - 当前 `AgentTool` schema / call / async 调度：`src/tools/AgentTool/AgentTool.tsx:168`, `src/tools/AgentTool/AgentTool.tsx:344`, `src/tools/AgentTool/AgentTool.tsx:486`, `src/tools/AgentTool/AgentTool.tsx:848`, `src/tools/AgentTool/AgentTool.tsx:986`, `src/tools/AgentTool/AgentTool.tsx:1093`
  - 当前前台任务转后台：`src/tasks/LocalAgentTask/LocalAgentTask.tsx:641`
  - 当前 tool result 映射：`src/tools/AgentTool/AgentTool.tsx:1742`
- Binary-observed:
  - `recover/claude-v2.1.165.js` 是压缩后的官方恢复文件，版本标记在文件开头 `Version: 2.1.165`。
  - 官方 `AgentTool` 逻辑可通过字符串定位到 bundle offset 约 `13734926` 起，包括 schema、agent 选择、fork、async/sync 调度和 result mapping。
- Runtime-observed:
  - 未运行 CLI，仅静态分析。
- Inference / needs verification:
  - 以下优化方向需要结合测试验证，尤其是 Agent 类型匹配、后台任务通知、MCP required server 检查。

## Findings

### 1. 当前 Agent 调度主流程

当前 `AgentTool.call()` 的核心流程如下：

1. 解析输入：
   - `description`
   - `prompt`
   - `subagent_type`
   - `model`
   - `run_in_background`
   - `name`
   - `team_name`
   - `mode`
   - `isolation`
   - `cwd`

   证据：`src/tools/AgentTool/AgentTool.tsx:391`

2. 判断 Team / teammate 场景：
   - `team_name && name` 走 `spawnTeammate()`
   - teammate 不允许嵌套 teammate
   - in-process teammate 不允许后台 agent

   证据：`src/tools/AgentTool/AgentTool.tsx:421`

3. 选择 agent 类型：
   - 有 `subagent_type` 则使用它
   - 否则如果 fork subagent gate 开启，则走 fork path
   - 否则默认 `general-purpose`

   证据：`src/tools/AgentTool/AgentTool.tsx:486`

4. 非 fork path 下，从 active agents 中查找 exact match：
   - 先按 `allowedAgentTypes` 和 deny rule 过滤
   - 再 `agents.find(agent => agent.agentType === effectiveType)`

   证据：`src/tools/AgentTool/AgentTool.tsx:515`

5. 检查 required MCP servers：
   - 如果有 pending required MCP server，最多等待 30s
   - 然后从 `currentAppState.mcp.tools` 提取 server name
   - 缺失则抛错

   证据：`src/tools/AgentTool/AgentTool.tsx:568`

6. 计算是否异步运行：
   - `run_in_background`
   - agent definition `background`
   - coordinator mode
   - fork mode
   - Kairos assistant mode
   - proactive mode

   证据：`src/tools/AgentTool/AgentTool.tsx:848`

7. 组装 worker tools：
   - 使用 agent 自己的 permission mode
   - 默认 `acceptEdits`

   证据：`src/tools/AgentTool/AgentTool.tsx:861`

8. 支持 worktree / cwd：
   - worktree 创建 early agent id
   - fork + worktree 会注入 path notice

   证据：`src/tools/AgentTool/AgentTool.tsx:870`

9. async path：
   - `registerAsyncAgent()`
   - `runAsyncAgentLifecycle()`
   - 返回 `async_launched`

   证据：`src/tools/AgentTool/AgentTool.tsx:986`

10. sync path：
    - 注册 foreground task
    - 超过阈值显示 background hint
    - 可转后台继续执行
    - 完成后 `finalizeAgentTool()`

    证据：`src/tools/AgentTool/AgentTool.tsx:1093`

整体上，当前实现已经覆盖官方 v2.1.165 的主要调度结构：schema、team spawn、fork path、async path、sync-to-background transition、worktree cleanup、progress tracking。

## 可优化方向

### 优化 1：补齐官方的 `subagent_type` 规范化匹配与歧义提示

官方 v2.1.165 在找不到 exact `agentType` 时，会做一次 normalized matching：

```js
normalize("NFKC")
  .toLowerCase()
  .replace(/[\p{White_Space}\p{Pd}_]+/gu, "")
```

并处理三种情况：

1. normalized 后匹配多个 agent：提示 ambiguous，并列出候选。
2. normalized 后匹配一个可用 agent：自动接受，并打 telemetry。
3. normalized 后匹配一个被 deny 的 agent：报 denied rule。
4. 完全找不到：报 available agents。

当前代码只做 exact match：

```ts
const found = agents.find(agent => agent.agentType === effectiveType)
```

证据：`src/tools/AgentTool/AgentTool.tsx:526`

这会导致这类输入体验较差：

- `code reviewer`
- `code-reviewer`
- `Code_Reviewer`
- 全角 / Unicode normalization 后等价的名字

建议新增：

```ts
function normalizeAgentTypeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{Pd}_]+/gu, '')
}
```

然后在 exact match 失败后追加 normalized fallback。

- 优先级：高
- 收益：提升 Agent 调用容错性，减少模型因小拼写差异导致 `Agent type not found`。
- 风险：需要处理 ambiguous，不能静默选错 agent。

### 优化 2：`async_launched` 的 tool result 文案应避免鼓励读取完整 JSONL

官方 v2.1.165 对后台 agent 的 result 文案非常保守：

- 明确说不要重复 agent 工作
- 告知 output file
- 但强调不要 `Read` 或 `tail` 该 JSONL transcript，避免上下文爆炸
- 如果用户问进度，只说 agent 仍在运行，完成会通知

当前实现是：

```ts
If asked, you can check progress before completion by using Read or Bash tail on the output file.
```

证据：`src/tools/AgentTool/AgentTool.tsx:1783`

这有潜在问题：

1. `Read` 默认可能读取大量 JSONL。
2. 模型容易真的去读完整 transcript。
3. 与 Agent 工具说明中“自动完成通知”的模式冲突。
4. 长后台任务会把上下文打爆。

建议改成更接近官方：

```text
output_file: ...
Do not read or tail this transcript unless explicitly needed; it can be very large.
If the user asks for progress, say the agent is still running; you'll receive a completion notification.
```

如果仍希望支持进度查看，建议提供专用 `TaskOutput` / `TaskGet`，而不是鼓励 `Read`。

- 优先级：高
- 收益：降低上下文溢出风险。
- 风险：如果当前项目依赖 Read output file 查进度，需要同步调整提示与测试。

### 优化 3：Agent 类型 miss 的错误信息可以更可操作

当前错误：

```ts
Agent type '${effectiveType}' not found. Available agents: ...
```

证据：`src/tools/AgentTool/AgentTool.tsx:542`

官方会在 normalized matching 后给出更具体信息：

- ambiguous：`matches A, B`
- denied：指出 deny rule source
- unavailable：区分存在但被过滤 / 不存在

当前已有“exists but denied”的 exact 检查，但没有 normalized denied / ambiguous。

建议优化错误路径：

1. exact found
2. normalized candidates from all active agents
3. candidates > 1：ambiguous
4. candidate == 1 但不可用：denied / unavailable
5. none：not found

- 优先级：中高
- 收益：模型更容易自我修正工具调用参数。
- 风险：要避免把 denied agent 细节泄露过多，保持和现有 permission error 一致。

### 优化 4：required MCP server 检查可合并当前 tool pool 中的 MCP tools

官方 v2.1.165 在检查 required MCP servers 时，server 来源不是只看 app state MCP tools，还合并了当前 tool pool 中的 MCP tools：

```js
for (let AH of zH.mcp.tools.concat(h)) { ... }
```

其中 `h` 来自当前 `w.options.tools.filter(...)`。

当前代码只遍历：

```ts
for (const tool of currentAppState.mcp.tools) { ... }
```

证据：`src/tools/AgentTool/AgentTool.tsx:616`

潜在问题：

- 某些 MCP tool 已经在当前 tool pool 中，但 appState MCP tools 状态同步滞后。
- 或 feature / permission / tool assembly 后的工具池与 appState 不完全一致。
- required MCP 检查可能误判 missing。

建议：

```ts
const mcpToolCandidates = [
  ...currentAppState.mcp.tools,
  ...toolUseContext.options.tools.filter(t => t.name?.startsWith('mcp__')),
]
```

并去重 server name。

- 优先级：中
- 收益：减少 MCP required server race / false negative。
- 风险：需要确认 `toolUseContext.options.tools` 中是否可能包含被 permission 禁用但仍不应视为可用的工具。

### 优化 5：给 `runAgentParams` 补充更多上下文字段

官方 v2.1.165 的 run agent 参数里包含更多上下文：

- `name`
- `spawnedBySkill`
- `toolUseId`
- `onMcpServersBlocked`
- fork path 下的 `replHydration`

当前 `runAgentParams` 里主要包含：

- `agentDefinition`
- `promptMessages`
- `toolUseContext`
- `canUseTool`
- `isAsync`
- `querySource`
- `model`
- `override`
- `availableTools`
- `forkContextMessages`
- `useExactTools`
- `worktreePath`
- `cwd`
- `description`

证据：`src/tools/AgentTool/AgentTool.tsx:902`

建议评估补充：

```ts
name,
toolUseId: toolUseContext.toolUseId,
spawnedBySkill: toolUseContext.options.spawnedBySkill ?? toolUseContext.options.activeSkill,
onMcpServersBlocked: ...
```

收益：

- 更准确的 telemetry / transcript attribution
- 技能触发的 subagent 可以保留来源
- MCP blocked 时可向 UI / SDK 发通知

- 优先级：中
- 风险：取决于当前 `runAgent()` 类型是否已支持这些字段；需要先读 `src/utils/agent/runAgent.ts` 或实际定义。

### 优化 6：MCP blocked / unavailable 时增加非致命进度通知

官方 v2.1.165 在 `qH` 中传入了类似 `onMcpServersBlocked` 的回调，用于给父上下文发 notification：

```js
agent MCP server blocked by ...
```

当前代码未搜索到对应逻辑。

建议在 `runAgentParams` 中支持可选回调：

```ts
onMcpServersBlocked: (servers, reason) => {
  onProgress?.({
    type: 'notification',
    notification: {
      key: `agent-mcp-blocked-${earlyAgentId}`,
      text: `${selectedAgent.agentType} agent MCP ...`,
      priority: 'medium',
      color: 'warning',
      timeoutMs: 10_000,
    },
  })
}
```

- 优先级：中
- 收益：当 agent 内部工具受 MCP 阻塞影响时，用户和父 agent 能看到更明确状态。
- 风险：需要检查当前 progress event 类型是否支持 notification。

### 优化 7：后台任务状态应优先完成，再做慢操作

当前代码在 backgrounded continuation 中已有较好处理：

```ts
completeAsyncAgent(agentResult, rootSetAppState)
```

然后再做 classifier / cleanup / notification。

证据：`src/tools/AgentTool/AgentTool.tsx:1323`

这是合理优化，甚至比官方 recover 中看到的顺序更稳，因为官方片段里后台完成路径看起来是先 classifier / cleanup，再通知完成。当前代码注释也提到避免 `TaskOutput(block=true)` 被 classifier / git cleanup 卡住。

建议保持，不要回退。

- 优先级：保持现状
- 收益：避免后台任务实际结束但 UI / TaskOutput 仍阻塞。
- 风险：无。

### 优化 8：sync agent progress 转发可增加 `agentType` / `description`

官方 progress payload 中包含：

- `prompt`
- `agentId`
- `agentType`
- `description`

当前 initial progress 只包含：

```ts
prompt,
agentId,
```

证据：`src/tools/AgentTool/AgentTool.tsx:1115`

后续 progress 也只包含：

```ts
prompt: '',
agentId: syncAgentId,
```

证据：`src/tools/AgentTool/AgentTool.tsx:1527`

建议补充：

```ts
agentType: selectedAgent.agentType,
description,
```

- 优先级：低到中
- 收益：UI / SDK consumer 可以更好展示子 Agent 类型和任务描述。
- 风险：需要确认 `AgentToolProgress` 类型定义是否已有字段。

### 优化 9：`cwd` 与 `worktree` 互斥需要更早校验

schema 描述里说：

```ts
cwd ... Mutually exclusive with isolation: "worktree".
```

证据：`src/tools/AgentTool/AgentTool.tsx:232`

但从当前 `call()` 片段看，后续逻辑是：

```ts
const cwdOverridePath = cwd ?? worktreeInfo?.worktreePath
```

证据：`src/tools/AgentTool/AgentTool.tsx:900`

如果用户同时传 `cwd` 和 `isolation: "worktree"`，实际行为会创建 worktree，但 cwd 覆盖 worktree path，导致：

- 创建了无用 worktree
- cleanup 行为仍可能执行
- agent 实际不在 worktree 中运行
- 用户认知与实际行为不一致

建议在 call 早期加：

```ts
if (cwd && effectiveIsolation === 'worktree') {
  throw new Error('cwd is mutually exclusive with isolation: "worktree".')
}
```

- 优先级：中高
- 收益：避免静默错误和无用 worktree。
- 风险：如果已有调用依赖“cwd 优先”，会变成 breaking change；但 schema 已声明互斥，按错误处理更合理。

## 建议落地顺序

1. 高优先级：
   - 修正 `async_launched` 文案，避免鼓励 `Read` 完整 output file。
   - 增加 `cwd` + `isolation: "worktree"` 早期互斥校验。
   - 增加 `subagent_type` normalized fallback 和 ambiguous 错误。

2. 中优先级：
   - required MCP server 检查合并当前 tool pool。
   - `runAgentParams` 补充 `name` / `toolUseId` / `spawnedBySkill`。
   - 增加 MCP blocked notification hook。

3. 低优先级：
   - progress payload 补充 `agentType` / `description`。
   - 对 one-shot built-in agent result trailer 的 token 优化继续保留并补测试。

## Commands / artifacts

- Local commands used:
  - 使用 `Glob` 定位 recover 文件。
  - 使用 `Grep` / `Read` 阅读当前源码。
  - 使用本地 `python3` 对压缩 bundle 做字符串定位和片段提取。
- Local outputs created:
  - `docs/agent-update-plan.md`
- Code changes:
  - 仅新增分析文档，未修改运行时代码。

## Risks / limits

- `recover/claude-v2.1.165.js` 是压缩 bundle，变量名不可读，部分函数语义来自上下文推断。
- 没有运行测试或 CLI，只做静态对比。
- 真正落地前建议先阅读 `runAgent()` 类型定义和 AgentTool 相关测试，避免传入字段未被支持或破坏现有快照。
