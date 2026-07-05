# Workflow / Ultracode Orchestration UX Design

Date: 2026-07-05

## Background

当前仓库已经实现 dynamic workflow：`WorkflowTool` / `WorkflowFacadeTool` 负责启动 workflow，workflow script runtime 通过 `AgentTool` 执行子任务。`ultracode` 当前作为 effort / keyword 触发更强的 orchestration 指令，系统提示会要求在 substantive task 上优先使用 Workflow tool。

最近交互中暴露出几个 UX 和调度问题：

- workflow 里启动的 child agents 会出现在底部 Agent 列表，用户容易误以为是普通手动 Agent 或“乱冒出来的 Agent”。
- workflow 被中断或 kill 后，已经派发或排队的 child agent notification 仍可能继续返回。
- 多个 workflow / subagent 并发会触发 `Concurrency limit exceeded for user`，但 UI 没有清楚解释来源和处理方式。
- `ultracode` 提示过于强制，容易把普通源码研究任务升级成 workflow 编排，造成不必要的 Agent fan-out。

本设计目标不是重写 workflow，而是在现有架构上增强来源标识、生命周期可见性、并发治理和 ultracode 触发策略。

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

Relevant files:

- `src/tools/WorkflowTool/WorkflowTool.ts`
- `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- `src/commands/workflows/index.ts`

### Workflow runtime 复用 AgentTool

`src/tools/WorkflowTool/workflowScriptRuntime.ts` 中：

- `findAgentTool(context.options.tools)` 查找 `Agent` / `Task` tool。
- `realAgent(...)` 构造 `AgentToolInput`。
- `agentTool.call(...)` 真正启动 child agent。

因此 workflow child agent 出现在 Agent 列表是架构必然结果，不是偶发 UI bug。

Relevant lines / concepts:

- `workflowScriptRuntime.ts`: `findAgentTool(...)`
- `workflowScriptRuntime.ts`: `realAgent(...)`
- `workflowScriptRuntime.ts`: `agentTool.call(...)`

### LocalWorkflowTask 明确让 workflow agents 显示在 UI

`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` 中 `recordWorkflowAgentStarted(...)` 会向 `liveAgents` 写入 entry，并有注释说明：

```ts
// Register a liveAgents entry so the agent shows as 'running' in UI
```

这说明 child agent 出现在 workflow / agent UI 是当前设计的一部分。

Relevant file:

- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`

### Ultracode 当前触发逻辑

`src/utils/effort.ts` 将 `ultracode` 作为 effort level 之一，但 API 层会映射：

- OpenAI provider: `ultracode` -> `xhigh`
- non-OpenAI provider: `ultracode` -> `high`

`src/utils/ultracodeOrchestration.ts` 负责 keyword detection / notification / injection decision：

- `findUltracodeTriggerPositions(...)`
- `hasUltracodeKeyword(...)`
- `shouldInjectUltracodeOrchestration(...)`
- `getUltracodeNotificationText(...)`

`src/utils/ultracodeOrchestration.test.ts` 检查系统提示文本存在，包括：

- keyword 触发 multi-agent orchestration。
- ultracode on 时使用 Workflow tool。
- ultracode off 时恢复标准 Workflow opt-in 规则。

Relevant files:

- `src/utils/effort.ts`
- `src/utils/ultracodeOrchestration.ts`
- `src/utils/ultracodeOrchestration.test.ts`
- `src/utils/messages.ts`

## Problems

### P0. Workflow child agents lack clear origin in UI

Current behavior:

- child agents are recorded under `LocalWorkflowTask.liveAgents`.
- UI can show them as running agents.
- User cannot easily tell whether an Agent was manually started, spawned by Workflow, or is a Team teammate.

Impact:

- User confusion: “为什么 workflow 的 agent 也会出现在下面的 agent 列表里？”
- Hard to know which workflow owns which agent.
- Hard to understand whether an Agent can be safely stopped independently.

### P0. Ultracode instruction over-orchestrates ordinary tasks

Current behavior:

- Ultracode system reminder says to use Workflow tool on every substantive task.
- This can overrule reasonable lightweight behavior, especially for focused source investigation.

Impact:

- Accidental workflow launch.
- Excessive child agents.
- Concurrency exhaustion.
- UI noise.

### P0. Workflow stop / kill does not clearly communicate child-agent aftermath

Current behavior:

- `LocalWorkflowTask` has `abortController` and per-agent `agentControllers`.
- `abortWorkflowControllers(...)` can abort children.
- But user-visible notifications may still arrive later from already-dispatched or failed child agents.

Impact:

- User believes workflow was killed, yet agent notifications continue.
- It is unclear whether agents were cancelled, completed, failed, or blocked by concurrency.

### P1. Runtime semaphore does not represent API/user concurrency

Current behavior:

`workflowScriptRuntime.ts` defines local runtime concurrency:

```ts
const MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
```

This controls local dispatch concurrency only. It does not reflect upstream API account concurrency or Agent tool concurrency.

Impact:

- Workflow may dispatch agents that fail with `Concurrency limit exceeded for user`.
- Such failures look like normal child agent failures instead of scheduler/backpressure.

### P1. WorkflowTool and WorkflowFacadeTool semantics overlap

Current behavior:

- `WorkflowTool` is action-based and supports management actions.
- `WorkflowFacadeTool` is a simpler official-compatible execution facade.

Impact:

- Model may choose the wrong tool.
- Tool prompt does not sufficiently distinguish management vs execution path.

## Design goals

1. Preserve existing workflow architecture: workflow runtime should continue to reuse `AgentTool`.
2. Make workflow child agents visibly attributable to their workflow.
3. Make pause / kill / stop semantics observable and explain child-agent state.
4. Make ultracode mean “deeper, more rigorous execution,” not “always launch workflow.”
5. Reduce accidental fan-out and concurrency-limit failures.
6. Keep changes small, source-testable, and compatible with official dynamic workflow semantics.

## Proposed design

### 1. Add workflow origin metadata to liveAgents and results

Extend workflow agent state types:

```ts
type WorkflowAgentOrigin = {
  origin: 'workflow'
  workflowTaskId: string
  workflowRunId?: string
  workflowName?: string
  phaseId: string
  label: string
}
```

Candidate locations:

- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- `WorkflowLiveAgentState`
- `WorkflowAgentResult`

Example extension:

```ts
export type WorkflowLiveAgentState = {
  tokenCount: number
  toolUseCount: number
  prompt?: string
  activity?: string
  recentActivities?: string[]
  origin?: 'workflow'
  workflowTaskId?: string
  workflowRunId?: string
  workflowName?: string
  phaseId?: string
  label?: string
}
```

Update `recordWorkflowAgentStarted(...)` and `recordWorkflowAgentProgress(...)` to preserve these fields.

Expected UI affordance:

```text
Workflow: codebase-audit (wf_xxx)
  phase: scan
    agent: scan-1 running
```

or in compact Agent list:

```text
Agent scan-1 · workflow codebase-audit / phase scan
```

### 2. Group workflow children under Workflow UI

Update workflow/task UI components to display child agents under the owning workflow instead of blending them with manually spawned agents.

Candidate files to inspect/modify:

- `src/components/tasks/WorkflowDetailDialog.tsx`
- `src/components/CoordinatorAgentStatusRows.ts`
- `src/components/CoordinatorAgentStatus.test.ts`
- `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`

Desired behavior:

- `/workflows` / WorkflowDetailDialog shows child agents tree.
- General Agent list can still show workflow children, but with a visible `workflow` origin label.
- Completed workflow child agents should be collapsed by default.

### 3. Make workflow pause / kill child-agent status explicit

Enhance pause / stop result text and status events.

Current relevant code:

- `WorkflowTool.ts`: `pause` action
- `LocalWorkflowTask.ts`: `pauseWorkflowTask(...)`, `abortWorkflowControllers(...)`
- `formatWorkflowStatus.ts`

Add a status summary after abort:

```text
Workflow paused.
Child agents:
- aborted: 2
- already completed: 3
- still finalizing: 1
```

If a child notification arrives after workflow pause/kill, mark it as:

- `cancelled_by_workflow_pause`
- `cancelled_by_workflow_kill`
- `completed_after_pause`
- `failed_after_pause`

Do not present it as a surprising standalone agent completion.

### 4. Classify concurrency-limit failures

Add helper classification near workflow runtime error handling:

```ts
function classifyWorkflowAgentError(error: unknown):
  | 'concurrency_limit'
  | 'stalled'
  | 'permission_denied'
  | 'agent_failed'
```

Detect known messages such as:

```text
Concurrency limit exceeded for user
```

Then represent result as a distinct status. Options:

- Extend `WorkflowAgentResult.status` with `blocked` / `queued` / `skipped` reason.
- Or keep status `failed`, but add `errorKind: 'concurrency_limit'`.

Preferred minimal change:

```ts
errorKind?: 'concurrency_limit' | 'stalled' | 'permission_denied' | 'agent_failed'
```

This avoids broad UI type churn.

UI should show:

```text
blocked by concurrency limit; retry later or lower workflow fanout
```

rather than generic failure.

### 5. Soften ultracode orchestration instruction

Current tested text in `src/utils/ultracodeOrchestration.test.ts` expects very strong phrasing.

Proposed replacement semantics:

- Ultracode means maximize correctness and verification.
- Prefer WorkflowTool only when task is broad, independent, and benefits from workflow-scale orchestration.
- If user explicitly says “不要 workflow”, “只用 subagent”, “不要编排”, do not call WorkflowTool.
- For focused source research, direct `Read/Grep` or at most 1-2 explicit subagents is acceptable.

Suggested prompt wording:

```text
Ultracode is on: optimize for the most exhaustive, correct answer, not the fastest or cheapest. Prefer WorkflowTool for broad, workflow-scale orchestration such as audits, migrations, multi-perspective verification, or fan-out research. For focused tasks, use direct tools or a small number of subagents. Do not run WorkflowTool when the user asks to avoid workflow orchestration.
```

Update tests in:

- `src/utils/ultracodeOrchestration.test.ts`
- likely `src/utils/messages.ts` snapshot/string checks

### 6. Distinguish WorkflowTool vs WorkflowFacadeTool in prompts

Update prompt text:

- `WorkflowTool`: inspect/manage/run validated workflow specs; status/pause/resume/dry-run/list.
- `WorkflowFacadeTool`: official-compatible concise execution surface for saved workflow/script/scriptPath/plan.

Add explicit instruction:

```text
If the user asks not to use workflows, do not call this tool. If the user only asks for focused code research, prefer normal source tools unless workflow-scale orchestration is explicitly useful and accepted.
```

Candidate files:

- `src/tools/WorkflowTool/WorkflowTool.ts`
- `src/tools/WorkflowTool/WorkflowFacadeTool.ts`

## Implementation plan

### Phase 0: Tests first

Add/update source-level tests before production changes.

Suggested tests:

1. Workflow live agent origin metadata
   - File: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts`
   - Given a workflow task and `recordWorkflowAgentStarted(...)`, assert `liveAgents[agentId]` contains workflow origin metadata.

2. Workflow status includes child-agent summary after pause
   - File: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts` or existing status tests.
   - Simulate running task with live agents and paused state.
   - Assert formatted status contains child agent counts.

3. Concurrency error classification
   - File: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts` or new focused unit test.
   - Mock AgentTool throwing `Concurrency limit exceeded for user`.
   - Assert result records `errorKind: 'concurrency_limit'`.

4. Ultracode softened prompt
   - File: `src/utils/ultracodeOrchestration.test.ts`
   - Update string assertions to require broad/focused distinction and “do not run WorkflowTool when user asks to avoid workflow orchestration”.

5. WorkflowFacadeTool prompt guard
   - File: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`
   - Assert prompt includes “do not call when user asks to avoid workflows” or equivalent.

### Phase 1: Metadata and UI clarity

- Extend `WorkflowLiveAgentState` and `WorkflowAgentResult` metadata.
- Update `recordWorkflowAgentStarted` / progress / complete / fail paths to preserve metadata.
- Update WorkflowDetailDialog / status formatting to show origin and phase.

### Phase 2: Lifecycle and concurrency classification

- Add error classification helper.
- Annotate workflow child agent failures.
- Add status summary for pause/kill.
- Ensure workflow stop/pause aborts controllers and reports counts.

### Phase 3: Ultracode trigger refinement

- Update ultracode system reminder text.
- Update tests.
- Verify binary-side behavior with a focused task containing `ultracode` no longer automatically causes unwanted workflow if user explicitly says no workflow.

## Verification plan

### Source-level

Run focused tests first:

```sh
bun src/utils/ultracodeOrchestration.test.ts
bun src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Then broader workflow suite:

```sh
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts
bun src/tools/WorkflowTool/workflowEvents.test.ts
bun src/tools/WorkflowTool/workflowResumeCache.test.ts
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
   - Expected: no WorkflowTool call.

2. Broad ultracode audit request
   - Expected: WorkflowTool may be used, with permission preview.

3. Workflow child agent UI
   - Expected: child agents show workflow origin / phase.

4. Kill/pause workflow with running child agents
   - Expected: status reports aborted/still-running/completed child counts.

5. Artificial concurrency pressure if feasible
   - Expected: concurrency-limit failures classified and explained.

Required evidence:

- tmux pane captures under `/tmp`.
- debug logs under `/tmp`, preserved.
- focused log excerpts only.

## Risks

- Adding fields to `LocalWorkflowTaskState` may affect UI snapshots or serialized task state assumptions.
- Changing ultracode prompt can affect model behavior; needs binary-side validation.
- Over-grouping workflow child agents may hide useful progress if not designed carefully.
- Concurrency-limit detection by message string is brittle; if possible, prefer structured error classification from Agent/API layer.

## Non-goals

- Do not replace `AgentTool` with a separate workflow-only executor.
- Do not remove workflow child agents from observability entirely.
- Do not make ultracode a new API effort value; it remains orchestration UX + mapped effort.
- Do not implement official docs parity beyond current local workflow runtime scope in this change.

## Summary

The current architecture is fundamentally reasonable: workflow scripts orchestrate normal `AgentTool` subagents, and `LocalWorkflowTask` records progress. The main defect is UX clarity and over-aggressive ultracode routing. The recommended fix is to add workflow origin metadata, group child agents under workflow UI, classify concurrency/lifecycle outcomes, and soften ultracode from “always WorkflowTool” to “use workflow-scale orchestration only when task shape warrants it or user opts in”.
