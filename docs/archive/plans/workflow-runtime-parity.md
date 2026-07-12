# Workflow Runtime Parity Implementation Plan

## Goal

Align built workflow runtime stream-json behavior and result handling with official `Workflow` behavior while preserving the current built workflow runtime capabilities.

## Non-goals

- Do not make `/workflows` a launcher.
- Do not remove `WorkflowTool` management actions.
- Do not rely on dry-run as final validation.
- Do not change bundled workflow semantics unless needed for event/result parity.

## Phase 1 — Map current event emitters

Read and trace these areas before changing code:

- `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
- stream-json output plumbing for `task_started`, `task_progress`, and `task_notification`

Expected output:

- exact function that emits local agent `task_started`
- exact function that emits workflow task state
- exact place where `Workflow` tool result string is constructed
- exact place where background task notification output file is assigned

## Phase 2 — Add workflow-level parent task events

Implement workflow-level stream-json events for script workflow runs.

Required behavior:

- on `Workflow({scriptPath})`, emit parent `task_started`
- `task_type` must be `local_workflow`
- `prompt` must be the full workflow script
- `workflow_name` should be the workflow name or description
- `description` should be workflow description

Keep existing agent-level lifecycle tracking internally. If agent-level stream events remain visible, ensure they do not break official-compatible consumers.

## Phase 3 — Add official-shaped workflow progress

Map runtime progress to parent workflow `task_progress` events.

Required mapping:

- `phase("Parallel")` + `agent(... label:"alpha")` → `Parallel: alpha`
- `phase("Pipeline")` + `agent(... label:"pipe")` → `Pipeline: pipe`
- child workflow agent → `▸ child-small-workflow: child-small-agent`
- set `last_tool_name` to agent label
- include `workflow_progress` when available
- aggregate usage if available

Watchouts:

- Preserve phase order.
- Do not emit progress after completion.
- Avoid duplicate terminal notifications.

## Phase 4 — Align launch envelope

Change script workflow `Workflow` tool result to official-shaped launch envelope.

Include:

- `Workflow launched in background. Task ID: ...`
- `Summary: ...`
- `Transcript dir: ...`
- `Script file: ...`
- edit/reinvoke instruction
- `Run ID: ...`
- resume prompt using `resumeFromRunId`
- cache warning
- `/workflows` watch hint

Do not include final JSON result in the initial launch envelope when strict parity mode applies.

## Phase 5 — Align completion output

Ensure completion notification includes:

- parent workflow task ID
- top-level `Workflow` tool use ID
- status `completed` or explicit failure state
- summary `Dynamic workflow "..." completed`
- non-empty `output_file`
- final workflow result written to output file

The stream-json run may later include final JSON result, matching official behavior observed in `official-small-workflow-v.jsonl`.

## Phase 6 — Resume/transcript support

Ensure script workflow runs create and expose:

- transcript directory
- script file path
- run ID
- resume prompt
- journal/cache warning

If built already persists run session state, connect that state to the official-shaped envelope rather than adding a parallel persistence model.

## Phase 7 — Preserve built-only WorkflowTool behavior

Verify existing `WorkflowTool` actions still work:

- `list`
- `show`
- `dry-run`
- `run`
- `status`
- `pause`
- `resume`

`WorkflowTool` can remain richer than official, but `Workflow` facade must be official-compatible.

## Phase 8 — Verification and cleanup

Run binary-side real workflow validation with `--print --output-format stream-json --verbose`:

- built small scriptPath workflow
- official small scriptPath workflow
- built `deep-research`
- built `code-review`
- optional ultracode-triggered workflow UX check

Then compare lifecycle invariants:

- no missing notifications
- no orphan notifications
- no duplicate terminal notifications
- no notify-before-start
- phase order respected
- final JSON result preserved
- output files exist and contain expected result

## Rollback strategy

Keep changes localized to workflow runtime/event/result code paths. If parity breaks direct `WorkflowTool run`, revert event-envelope changes independently from runtime script execution.

## Open decisions

1. Whether to hide built agent-level stream events by default or keep them as extra detail.
2. Whether strict official envelope should apply to all `Workflow` calls or only scriptPath/script runs.
3. Whether `WorkflowTool run` should use built-style immediate result or official-style background envelope.
4. Whether official-shaped transcript dirs should reuse existing workflow run session dirs or a new subagents/workflows layout.
