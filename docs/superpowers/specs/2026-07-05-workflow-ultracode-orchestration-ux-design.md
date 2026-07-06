# Workflow / Ultracode Orchestration UX Design

Date: 2026-07-05
Updated: 2026-07-06

## Background

当前仓库已经实现 dynamic workflow：`WorkflowTool` / `WorkflowFacadeTool` 负责启动 workflow，workflow script runtime 通过 `AgentTool` 执行子任务。`ultracode` 当前作为 effort / keyword 触发更强的 orchestration 指令，系统提示会要求在 substantive task 上优先使用 Workflow tool。

最近交互中暴露出几个 UX 和调度问题：

- workflow 里启动的 child agents 会被记录在 `LocalWorkflowTask.liveAgents`，并在 `/workflows` / `WorkflowDetailDialog` 中展示；底部 coordinator Agent 列表当前会隐藏同一 workflow `toolUseID` 下的 child `LocalAgentTask`，只显示 workflow task row。用户仍可能因为 workflow row、detail dialog、后续 notification 与普通 Agent/Team teammate 的表现接近而困惑。
- workflow 被中断或 kill 后，`abortController` 和 per-agent `agentControllers` 会被触发，但已经派发或排队的 child agent notification / result 仍可能继续返回；当前缺少清晰的 after-pause / after-kill 归因摘要。
- 多个 workflow / subagent 并发会触发 `Concurrency limit exceeded for user`，但 UI 没有清楚解释来源和处理方式。
- `ultracode` 提示过于强制，容易把普通源码研究任务升级成 workflow 编排，造成不必要的 Agent fan-out。
- `ultracodeKeywordTrigger=false` 当前只影响实际输入处理；`PromptInput` 仍会无条件显示 keyword notification，造成 UI 与真实执行路径不一致。
- 当前仓库相对 `recover/claude-v2.1.201.js` 缺少更完整的 workflow completion diagnostics、per-agent journal、usage summary、resume/re-run 指南和 adopted paused workflow UX。

本设计目标不是重写 workflow，而是在现有架构上增强来源标识、生命周期可见性、并发治理、恢复诊断和 ultracode 触发策略。

## Source-confirmed current behavior

### WorkflowTool 是管理/执行入口

`src/tools/WorkflowTool/WorkflowTool.ts` 定义 action-based workflow tool：

- `list`
- `show`
- `dry-run`
- `run`
- `status`
- `pause`
- `resume`

`WorkflowTool` prompt 明确说明：

- workflow orchestrates multiple subagents。
- workflow 自身不直接执行 shell / filesystem。
- child agents 仍走 normal tool permissions and hooks。
- `/workflows` 不应被当作 launcher；它是 display / management UI。
- `WorkflowTool` 有 explicit opt-in requirement。
- 当前 `Ultracode` section 仍包含 “prefer this tool on every substantive task” 的强路由语义。

Relevant files:

- `src/tools/WorkflowTool/WorkflowTool.ts`
- `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- `src/commands/workflows/index.ts`

### WorkflowFacadeTool 是更简化的执行 facade

`WorkflowFacadeTool` 工具名为 `Workflow`，可接收 saved workflow name、`{ script, name }`、`{ scriptPath }`、`{ plan }` 或 dry-run plan。它不像 `WorkflowTool` 一样提供 action-based `status/pause/resume/list/show/dry-run` 管理面。

Current gap:

- `WorkflowTool` prompt 已有 explicit opt-in / ultracode 规则。
- `WorkflowFacadeTool` prompt 对“用户明确不要 workflow”与“focused source research 不应自动升级 workflow”的 guard 较弱。

### Workflow runtime 复用 AgentTool

`src/tools/WorkflowTool/workflowScriptRuntime.ts` 中：

- `AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])`。
- `findAgentTool(context.options.tools)` 查找 `Agent` / `Task` tool。
- `realAgent(...)` 构造 `AgentToolInput`。
- `agentTool.call(...)` 真正启动 child agent。

因此 workflow child agent 基于正常 `AgentTool` 生命周期和权限模型运行，这是架构设计，不是偶发 UI bug。

Relevant lines / concepts:

- `workflowScriptRuntime.ts`: `findAgentTool(...)`
- `workflowScriptRuntime.ts`: `realAgent(...)`
- `workflowScriptRuntime.ts`: `agentTool.call(...)`

### LocalWorkflowTask 记录 workflow agents

`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` 中：

- `WorkflowAgentResult.status` 当前主要是 `completed | failed | skipped | running`。
- `WorkflowLiveAgentState` 当前包含 `tokenCount`、`toolUseCount`、`prompt`、`activity`、`recentActivities` 等运行态字段。
- `recordWorkflowAgentStarted(...)` 会向 `liveAgents` 写入 entry，并有注释说明：

```ts
// Register a liveAgents entry so the agent shows as 'running' in UI
```

- `recordWorkflowAgentProgress(...)` 更新 activity / prompt / recent activities。
- `completeWorkflowAgent(...)` / `failWorkflowAgent(...)` 会移除 live state。
- `pauseWorkflowTask(...)` / `endWorkflowTask(...)` / `failWorkflowTask(...)` 会 abort workflow controller 和 agent controllers。

Important correction:

- child agent 不应被描述为“直接混入底部普通 Agent 列表”。`src/components/CoordinatorAgentStatusRows.ts` 会收集 workflow `toolUseID` 并过滤对应 child `LocalAgentTask`，底部主要显示 workflow row 本身；child progress 主要在 `WorkflowDetailDialog` / `LocalWorkflowTask.liveAgents` 中展示。

Relevant files:

- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- `src/components/CoordinatorAgentStatusRows.ts`
- `src/components/tasks/WorkflowDetailDialog.tsx`

### WorkflowDetailDialog 已经有分层 UI

`WorkflowDetailDialog` 已实现 workflow → phases → agents → agent detail 的导航与展示，并会读取 `workflow.liveAgents` activity。因此“把 workflow child agents 放到 workflow UI 下”不是从无到有的新功能；真正待改进的是：

- 显示 origin / phase / run identity 更清楚。
- pause / kill 后显示 child-agent outcome summary。
- concurrency-limit / stalled / permission-denied 等错误归因更清楚。
- completed / failed / skipped / live / after-pause result 的状态更可解释。

Relevant files:

- `src/components/tasks/WorkflowDetailDialog.tsx`
- `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`

### Runtime semaphore 不代表 API/user concurrency

`workflowScriptRuntime.ts` 定义 local runtime concurrency：

```ts
const MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
```

This controls local dispatch concurrency only. It does not reflect upstream API account concurrency or Agent tool concurrency.

Impact:

- Workflow may dispatch agents that fail with `Concurrency limit exceeded for user`.
- Such failures currently look like normal child agent failures instead of scheduler/backpressure.

### Ultracode 当前触发逻辑

`src/utils/effort.ts` 将 `ultracode` 作为 effort level 之一，但 API 层会映射：

- OpenAI provider: `ultracode` -> `xhigh`
- non-OpenAI provider: `ultracode` -> `high`
- OpenAI compat adapter 还有 raw fallback：`ultracode` -> `xhigh`
- `ultracode` 是 session-scoped，不持久化到 settings。

`src/utils/ultracodeOrchestration.ts` 负责：

- keyword matching / trigger position detection。
- keyword enabled helper。
- notification text。
- 一个 `shouldInjectUltracodeOrchestration(effortValue)` helper。

Important correction:

- 实际模型可见注入路径不主要由 `shouldInjectUltracodeOrchestration(...)` 完成。
- keyword prompt attachment 由 `src/utils/processUserInput/processUserInput.ts` 添加。
- session-level ultracode reminders 由 `src/utils/attachments.ts` 周期性添加，并由 `src/utils/messages.ts` 转成 system reminder。
- `ultra_effort_enter` reminder 当前有节流：大约每 5 turns 注入一次，且每 5 次 reminder 使用 full reminder。

Current model-visible prompt text includes:

- keyword 触发 multi-agent orchestration。
- ultracode on 时使用 Workflow tool。
- ultracode off 时恢复标准 Workflow opt-in 规则。

Relevant files:

- `src/utils/effort.ts`
- `src/services/api/openai-compat.ts`
- `src/utils/ultracodeOrchestration.ts`
- `src/utils/processUserInput/processUserInput.ts`
- `src/utils/attachments.ts`
- `src/utils/messages.ts`
- `src/utils/ultracodeOrchestration.test.ts`

### PromptInput notification 与实际 keyword trigger 不一致

Current behavior:

- `processUserInput` 会尊重 `settings.ultracodeKeywordTrigger === false`，不添加 `workflow_keyword_request`，也不设置 turn effort 为 `ultracode`。
- `PromptInput` 的 notification 直接使用 `findUltracodeTriggerPositions(displayedValue)`，没有同步检查 `settings.ultracodeKeywordTrigger`。

Impact:

- 用户关闭 keyword trigger 后，仍可能看到 “Dynamic workflow requested...” UI 提示，但提交后不会触发实际 orchestration reminder。

### Recover v2.1.201 observed behavior

`recover/claude-v2.1.201.js` 是压缩/混淆后的单文件 bundle，仅作为本地参考，不直接复制实现。

Recover 中可观察到的相关能力：

1. Workflow / ultracode settings 更完整：
   - `disableWorkflows`
   - `enableWorkflows`
   - `workflowKeywordTriggerEnabled`
   - `skipWorkflowUsageWarning`
   - session-scoped `ultracode` boolean

2. Recover 的 ultracode 更像“xhigh effort + session orchestration flag”组合，而不是仅一个 `EffortValue`。

3. Recover 有强 system reminder 注入：
   - `workflow_keyword_request`
   - `ultra_effort_enter`
   - `ultra_effort_exit`

4. Recover 的 workflow prompt 强调：
   - 首次 inline script 会自动持久化。
   - 后续迭代用 `scriptPath`。
   - resume 使用 `resumeFromRunId`。
   - completed agents can replay from cache。

5. Recover 的 workflow completion notification 包含：
   - structured task notification。
   - output file。
   - result / diagnostics / failures。
   - per-agent `journal.jsonl` 指引。
   - empty result 统计。
   - usage：agent count、done/error/skipped/empty、tokens、tool uses、duration。
   - recovery / resume / rerun instructions。

6. Recover 有 `registerAdoptedWorkflowTask`，用于恢复/接管 paused workflow run。

7. Recover 的 progress model 有 batch merge、log cap 和 aggregate metrics。当前 TS state 更结构化，不建议回退，但可以吸收这些 UX 和 metrics 思路。

## Problems

### P0. Ultracode instruction over-orchestrates ordinary tasks

Current behavior:

- Keyword reminder、session reminder 和 `WorkflowTool` prompt 都含强 workflow 路由语义。
- `WorkflowTool` prompt 当前强调 “every substantive task”。
- 这会把 focused source investigation 也推向 workflow。

Impact:

- Accidental workflow launch。
- Excessive child agents。
- Concurrency exhaustion。
- UI noise。

### P0. WorkflowFacadeTool lacks the same avoid-workflow guard

Current behavior:

- `WorkflowTool` 有较完整 opt-in prompt。
- `WorkflowFacadeTool` 是更简洁的 official-compatible execution facade，但 guard 弱。

Impact:

- Model may choose the `Workflow` facade even when user explicitly asks not to use workflow orchestration.
- Focused source research may route through facade without the clearer `WorkflowTool` opt-in semantics.

### P0. Workflow pause / kill does not clearly communicate child-agent aftermath

Current behavior:

- `LocalWorkflowTask` has `abortController` and per-agent `agentControllers`.
- `abortWorkflowControllers(...)` can abort children.
- Many completion/failure update paths guard against non-running task state.
- But user-visible notifications may still arrive later from already-dispatched or failed child agents.

Impact:

- User believes workflow was killed, yet agent notifications continue.
- It is unclear whether agents were cancelled, completed, failed, blocked by concurrency, or completed after pause.

### P1. Runtime semaphore does not represent API/user concurrency

Current behavior:

- Local runtime semaphore does not know upstream account concurrency.
- AgentTool/API may fail with `Concurrency limit exceeded for user`.

Impact:

- Backpressure looks like generic child-agent failure.
- User does not know to retry later, lower fanout, or pause competing agents.

### P1. Workflow status and notification diagnostics are weaker than recover

Current behavior:

- `formatWorkflowStatus(...)` shows task status, phases, progress, and controls.
- `WorkflowDetailDialog` shows agents and live activity.
- Completion/failure UX lacks recover-style diagnostics: per-agent journal pointer, empty result count, structured failures, usage summary, resume/re-run guidance.

Impact:

- Harder to debug empty or unexpected workflow result.
- Harder to decide whether to resume, retry, or inspect agent transcripts.

### P1. PromptInput keyword notification ignores keyword trigger setting

Current behavior:

- Actual input processing respects `settings.ultracodeKeywordTrigger`.
- UI notification does not.

Impact:

- Misleading “Dynamic workflow requested...” notification when feature is disabled.

### P2. Ultracode state is mixed with effort value

Current behavior:

- Current code models `ultracode` as an `EffortValue`.
- Recover models it more like xhigh effort plus a separate session-scoped orchestration flag.

Impact:

- Harder to express workflow orchestration on/off independently from model effort support.
- Harder to give precise errors for workflow disabled, xhigh unsupported, organization restriction.

This is a larger architectural improvement and should not block the first UX fix.

## Design goals

1. Preserve existing workflow architecture: workflow runtime should continue to reuse `AgentTool`.
2. Preserve current TS structured state (`phases`, `results`, `events`, `liveAgents`) rather than replacing it with recover’s mixed progress event list.
3. Make workflow child agents visibly attributable to their workflow, phase and run where currently ambiguous.
4. Make pause / kill / stop semantics observable and explain child-agent state.
5. Make ultracode mean “deeper, more rigorous execution,” not “always launch workflow.”
6. Reduce accidental fan-out and concurrency-limit failures.
7. Improve workflow completion diagnostics and recovery guidance.
8. Keep changes small, source-testable, and compatible with official dynamic workflow semantics.

## Proposed design

### 1. Soften ultracode orchestration instruction

Current tested text in `src/utils/ultracodeOrchestration.test.ts` expects strong phrasing.

Replacement semantics:

- Ultracode means maximize correctness, verification and completeness.
- Prefer WorkflowTool / Workflow facade only when task is broad, independent, and benefits from workflow-scale orchestration.
- If user explicitly says “不要 workflow”, “只用 subagent”, “不要编排”, “no workflow”, “do not orchestrate”, do not call WorkflowTool / WorkflowFacadeTool.
- For focused source research, direct `Read/Grep` or at most a small number of explicit subagents is acceptable.
- Token cost is not the primary constraint, but concurrency and user intent still matter.

Suggested keyword reminder:

```text
The user included the keyword "ultracode", opting this turn into deeper verification and, when the task warrants it, workflow-scale orchestration. Use Workflow only for broad/fan-out work; for focused tasks, use direct tools or a small number of subagents. If the user asks to avoid workflows, do not call Workflow.
```

Suggested full session reminder:

```text
Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Prefer Workflow for broad, workflow-scale tasks such as audits, migrations, deep research, cross-checking, or independent fan-out. For focused tasks, use direct tools or a small number of subagents. Do not run Workflow when the user asks to avoid workflow orchestration.
```

Suggested sparse reminder:

```text
Ultracode is still on — use deeper verification; prefer Workflow only for workflow-scale tasks and respect requests to avoid workflows.
```

Update locations:

- `src/utils/messages.ts`
- `src/tools/WorkflowTool/WorkflowTool.ts`
- `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- `src/utils/ultracodeOrchestration.test.ts`
- `src/tools/WorkflowTool/WorkflowTool.test.ts`
- add/update `WorkflowFacadeTool` prompt test if absent.

### 2. Gate PromptInput ultracode notification by settings

Desired behavior:

- If `settings.ultracodeKeywordTrigger === false`, do not show ultracode keyword notification.
- If enabled or unset, keep current detection behavior.
- Continue not showing notification for slash commands, `what is ultracode?`, `ultracode.foo`, `/ultracode`, `--ultracode` and similar excluded forms.

Candidate implementation:

- In `PromptInput`, combine `findUltracodeTriggerPositions(displayedValue)` with `isUltracodeKeywordTriggerEnabled(settings)` or equivalent local predicate.
- Prefer extracting a small pure helper if existing component tests are hard to target.

### 3. Add workflow child-agent error classification

Add minimal structured classification while keeping status compatible.

Suggested type extension:

```ts
export type WorkflowAgentErrorKind =
  | 'concurrency_limit'
  | 'stalled'
  | 'permission_denied'
  | 'agent_failed'

export type WorkflowAgentResult = {
  // existing fields
  errorKind?: WorkflowAgentErrorKind
}
```

Suggested classifier:

```ts
export function classifyWorkflowAgentError(error: unknown): WorkflowAgentErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/Concurrency limit exceeded for user/i.test(message)) return 'concurrency_limit'
  if (/stalled/i.test(message)) return 'stalled'
  if (/permission denied|not allowed|denied by permission/i.test(message)) return 'permission_denied'
  return 'agent_failed'
}
```

UI/status wording:

```text
blocked by concurrency limit; retry later or lower workflow fanout
```

### 4. Make workflow pause / kill child-agent summary explicit

Add a reusable child-agent summary helper over `LocalWorkflowTaskState`:

- `live`: number of `liveAgents` entries.
- `completed`: results with status `completed`.
- `failed`: results with status `failed`.
- `skipped`: results with status `skipped`.
- `running`: results with status `running` plus live count if needed.
- `concurrencyBlocked`: failed results with `errorKind === 'concurrency_limit'`.

Show in `formatWorkflowStatus(...)`, especially for paused/killed/failed states:

```text
Child agents: 3 completed, 1 failed, 2 live/aborting, 1 blocked by concurrency limit
```

For pause/kill tool result text, include a short summary:

```text
Workflow paused.
Child agents: 2 live/aborting, 3 completed, 1 failed.
Some notifications may still arrive from agents that were already finalizing; they are part of this workflow run.
```

### 5. Add workflow origin metadata only where it helps

Current child agents already belong to `LocalWorkflowTask`, so full origin metadata is not a P0 requirement. Add minimal metadata when useful for cross-surface attribution.

Suggested fields on `WorkflowLiveAgentState`:

```ts
origin?: 'workflow'
workflowTaskId?: string
workflowRunId?: string
workflowName?: string
phaseId?: string
label?: string
```

Use cases:

- Agent detail view can show workflow name / run / phase.
- Future notifications can distinguish manual Agent vs workflow child.
- Debug logs and status summaries can include run identity.

Do not use this to duplicate all workflow state into each child record.

### 6. Improve workflow completion diagnostics and recovery guidance

Borrow recover UX concepts without changing runtime architecture.

Add completion / failure summary fields or formatted output including:

- task id
- workflow name / run id
- script path if available
- output path if available
- agent counts: total, completed, failed, skipped, empty result
- tokens and tool uses
- failures summary with `errorKind`
- pointer to per-agent results / transcripts if available
- resume / retry instructions

Suggested text for empty result handling:

```text
If the workflow result is empty or unexpected, inspect the per-agent results before assuming agents returned nothing.
```

Candidate files:

- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
- `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- `src/components/tasks/WorkflowDetailDialog.tsx`

### 7. Keep recover-inspired larger architecture as follow-up, not first patch

Do not bundle these with the initial UX patch unless explicitly scoped:

- Split `ultracode` into separate effort + orchestration flag.
- Add `skipWorkflowUsageWarning` setting.
- Add adopted paused workflow registration.
- Add recover-style `resumeFromRunId` API to facade if current action-based resume remains sufficient.
- Add per-agent `journal.jsonl` persistence if current transcript/output paths are not enough.

These should be separate specs/plans because they affect state shape, settings migration, tool schema and recovery semantics.

## Implementation plan outline

Detailed implementation plan should be saved separately under `docs/superpowers/plans/`.

Recommended phased implementation:

1. Tests for softened ultracode and Workflow prompt guard.
2. Prompt text changes in `messages.ts`, `WorkflowTool.ts`, `WorkflowFacadeTool.ts`.
3. PromptInput keyword notification setting gate.
4. Workflow error classification with `errorKind`.
5. Workflow child-agent summary formatting.
6. Minimal origin metadata if UI surfaces need it.
7. Optional completion diagnostics enhancement.

## Verification plan

### Source-level focused tests

Run focused tests first:

```sh
bun src/utils/ultracodeOrchestration.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
bun src/utils/processUserInput/processUserInput.test.ts
bun src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts
bun src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
```

If effort description changes:

```sh
bun src/utils/effort.test.ts
bun src/commands/effort/effort.test.ts
bun src/services/api/openai-compat.test.ts
```

Standard checks:

```sh
bunx tsc --noEmit
bun run lint
git diff --check
make build
```

### Binary-side interactive

Use tmux and debug logs when validating runtime behavior.

Cases:

1. Focused ultracode task with explicit “不要 workflow”
   - Expected: no WorkflowTool / WorkflowFacadeTool call.

2. Broad ultracode audit request
   - Expected: Workflow may be used, with permission preview.

3. Keyword trigger setting disabled
   - Expected: no PromptInput notification and no keyword workflow attachment.

4. Workflow child agent UI
   - Expected: child agents show under workflow detail; workflow row remains distinct from manual Agent rows.

5. Kill/pause workflow with running child agents
   - Expected: status reports completed/failed/live/aborting counts and explains late notifications.

6. Artificial concurrency pressure if feasible
   - Expected: concurrency-limit failures classified and explained.

Required evidence:

- tmux pane captures under `/tmp`.
- debug logs under `/tmp`, preserved.
- focused log excerpts only.

## Risks

- Changing ultracode prompt can affect model behavior; needs binary-side validation.
- Adding fields to `LocalWorkflowTaskState` may affect UI snapshots or serialized task state assumptions.
- Message-string classification for concurrency limit is brittle; prefer structured upstream errors if available later.
- Over-grouping workflow child agents may hide useful progress if not designed carefully.
- If `WorkflowFacadeTool` guard diverges from `WorkflowTool`, model routing can remain inconsistent.

## Non-goals

- Do not replace `AgentTool` with a separate workflow-only executor.
- Do not remove workflow child agents from observability entirely.
- Do not fully port recover’s workflow runtime.
- Do not make `ultracode` a new external API effort value.
- Do not implement official docs parity beyond current local workflow runtime scope in this change.
- Do not add settings migration for separate `ultracode` session flag in the first patch.

## Summary

The current architecture is fundamentally reasonable: workflow scripts orchestrate normal `AgentTool` subagents, and `LocalWorkflowTask` records progress in structured TS state. The main defects are UX clarity, over-aggressive ultracode routing, inconsistent keyword notification gating, weak concurrency/lifecycle classification, and limited diagnostics/recovery guidance. The recommended near-term fix is to soften ultracode from “always WorkflowTool” to “workflow-scale orchestration when task shape warrants it,” align both workflow tool prompts, gate keyword notification by setting, classify workflow agent failures, and add clear child-agent summaries for pause/kill/status. Recover v2.1.201 provides useful UX inspiration—especially diagnostics, journal pointers, usage summaries and resume guidance—but should be absorbed incrementally rather than copied wholesale.
