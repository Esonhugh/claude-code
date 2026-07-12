# Workflow Runtime Parity Spec

## Scope

Target: align `built-claude` workflow runtime behavior with `official-claude` for binary-side `Workflow` execution, agent flow events, result handling, and stream-json observability.

Out of scope:

- `/workflows` as a launcher. It remains display/status UI.
- Dry-run-only validation as final evidence.
- Changing workflow script DSL semantics unless required for official parity.

## Evidence baseline

### Source-confirmed

- `Workflow` facade accepts saved workflow, inline script, scriptPath, and plan inputs.
- Script runtime injects `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, and `budget`.
- Script runtime calls the `Agent` tool for `agent()` execution.
- Bundled workflows include `code-review` and `deep-research`.

### Runtime-observed

Artifacts under `/tmp/claude-workflow-deep-20260706-222935/`:

- `built-stream-small-workflow-v.jsonl`
- `official-small-workflow-v.jsonl`
- `built-forced-deep-research-v.jsonl`
- `built-forced-code-review-workflow.out`
- `built-forced-code-review-workflow-debug.log`

Observed built custom workflow result:

```json
{
  "before": null,
  "after": null,
  "pair": ["alpha-ok", "beta-ok"],
  "piped": ["pipe-ok"],
  "child": { "child": "child-small-ok" }
}
```

Observed official custom workflow result matched the same JSON.

Observed built `deep-research` real run:

- `task_started`: 62
- `task_progress`: 90
- `task_notification`: 62
- non-completed notifications: 0
- phases covered: Scope, Search, Fetch, Verify, Synthesize

## Required parity behavior

### 1. Workflow facade availability

`Workflow` must remain available in binary-side tool lists and support:

- `{ name, args }`
- `{ scriptPath, args }`
- `{ script, name, args }`
- `{ plan, args }`
- `resumeFromRunId`

`WorkflowTool` may exist in built as the management/execution surface, but parity with official must not depend on `WorkflowTool` being available.

### 2. Workflow task model

For scriptPath workflow runs, built should emit a workflow-level task matching official shape:

```json
{
  "type": "system",
  "subtype": "task_started",
  "task_type": "local_workflow",
  "task_id": "...",
  "tool_use_id": "...",
  "workflow_name": "...",
  "description": "<workflow description>",
  "prompt": "<full workflow script>"
}
```

Agent-level events may remain as additional detail, but they must not replace the workflow-level parent task.

### 3. Workflow progress model

During execution, built should emit workflow-level `task_progress` events with:

- `task_id` equal to the workflow parent task ID
- `tool_use_id` equal to the top-level `Workflow` tool use ID
- `description` shaped like official phase/agent progress, for example:
  - `Parallel: alpha`
  - `Parallel: beta`
  - `Pipeline: pipe`
  - `▸ child-small-workflow: child-small-agent`
- `last_tool_name` set to the active agent label
- `workflow_progress` when available
- accumulated `usage` where available

### 4. Result envelope

Official first returns a launch envelope, then separately emits completion/final output. Built should align its `Workflow` tool result envelope for scriptPath runs:

```text
Workflow launched in background. Task ID: <taskId>
Summary: <workflow description>
Transcript dir: <path>
Script file: <scriptPath>
(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "..."} to iterate without resending the script.)
Run ID: <runId>
To resume after editing the script: Workflow({scriptPath: "...", resumeFromRunId: "..."}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).

You will be notified when it completes. Use /workflows to watch live progress.
```

Built may include final result in a later completion output or result artifact, but should avoid mixing immediate launch envelope with final synchronous result when strict official parity is required.

### 5. Completion handling

Workflow completion should emit:

```json
{
  "type": "system",
  "subtype": "task_notification",
  "task_id": "<workflow task id>",
  "tool_use_id": "<workflow tool use id>",
  "status": "completed",
  "summary": "Dynamic workflow \"<description>\" completed",
  "output_file": "<non-empty path>",
  "usage": { ... }
}
```

The final workflow result must be retrievable from the output path and/or appear as a later stream-json assistant/result output.

### 6. Agent lifecycle correctness

For all workflow agent tasks/events:

- every started agent must complete or fail exactly once
- no orphan notification without start
- no notification before start
- no duplicate terminal notifications
- phase dependencies must be respected
- failed/stalled agents must be reflected in workflow status and logs

### 7. Prompt handling

Prompt differences that are acceptable:

- different test args, e.g. `stream-json-proof` vs `official-small-real-run`
- model-specific formatting of assistant final summaries

Prompt differences that must be fixed for parity:

- official workflow-level `task_started.prompt` contains full workflow script; built must expose equivalent workflow-level prompt
- child workflow progress should preserve child workflow identity in descriptions

## Known observed gaps

1. built currently exposes child local agent task events directly for custom small workflow, while official exposes workflow-level progress.
2. built immediate `Workflow` tool result includes final JSON result; official first returns launch/resume envelope.
3. built launch envelope lacks official fields: `Summary`, `Transcript dir`, `Script file`, edit/reinvoke instruction, resume prompt, cache warning.
4. built small workflow stream had no workflow-level `task_progress` events.
5. built local agent notifications used empty `output_file`; official workflow completion uses a concrete output file path.

## Acceptance criteria

A parity pass requires:

- built and official both run the same `parent-small-workflow.js` through `Workflow({scriptPath,args})`
- both produce identical final JSON result
- built stream-json includes a workflow-level parent task matching official fields
- built stream-json includes workflow-level progress for alpha, beta, pipe, and child-small-agent
- built completion notification has no lifecycle anomalies
- built launch envelope includes official resume/transcript fields
- built `deep-research` real run completes Scope/Search/Fetch/Verify/Synthesize without orphan/missing/duplicate terminal events
