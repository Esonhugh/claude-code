# Official Dynamic Workflows Binary Analysis

## Scope

This document analyzes the installed official Claude Code binary at `/opt/homebrew/bin/claude`, resolves how its Dynamic Workflow surface appears to work from static evidence, and compares those observations with the launch blog at `https://claude.com/blog/introducing-dynamic-workflows-in-claude-code`.

Analysis date: 2026-06-06.

Installed binary:

```text
/opt/homebrew/bin/claude -> /opt/homebrew/Caskroom/claude-code@latest/2.1.165/claude
/opt/homebrew/Caskroom/claude-code@latest/2.1.165/claude: Mach-O 64-bit executable arm64
```

Code signing summary:

```text
Identifier=com.anthropic.claude-code
Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
Timestamp=Jun 5, 2026 at 12:45:35
CodeDirectory flags=0x10000(runtime)
Entitlements include:
- com.apple.security.cs.allow-jit
- com.apple.security.cs.allow-unsigned-executable-memory
- com.apple.security.cs.disable-library-validation
- com.apple.security.device.audio-input
```

The workflow analysis below is based on read-only static extraction (`strings`, UTF-16LE strings, byte-context extraction) plus the blog text. It does not claim byte-for-byte source recovery.

## Blog claims used as comparison baseline

The official blog describes Dynamic Workflows as an orchestration feature for large, long-running Claude Code tasks:

- Workflows can run tens to hundreds of parallel subagents.
- Claude decomposes a prompt into subtasks, dispatches subagents in parallel, checks results, and combines them.
- Workflows are useful for codebase-wide bug hunts, migrations, audits, optimization reviews, and high-stakes work.
- Workflows can run for hours or days.
- Progress is saved during the run and interrupted work can continue.
- The first workflow trigger asks the user to confirm what will run.
- Users can trigger by directly asking Claude to create/use a workflow.
- `ultracode` enables xhigh effort plus standing workflow orchestration, letting Claude decide when to use workflows.
- On Max/Team/API, workflows are on by default; Enterprise is off by default unless admins enable them.
- The blog does not list workflow file syntax or built-in workflow template names.

## Runtime surface observed in the binary

The 2.1.165 binary contains a hidden `Workflow` tool and workflow runtime strings. Key observed symbols and UI/runtime labels include:

```text
WORKFLOW_TOOL_NAME
WorkflowTool
WorkflowPermissionDialog
WorkflowDetailDialog
workflowNeedsUsageConsentPrompt
recordWorkflowUsageConsent
initBundledWorkflows
loadPluginWorkflows
getWorkflowCommands
createWorkflowCommand
LocalWorkflowTask
registerWorkflowTask
pauseWorkflowTask
killWorkflowTask
skipWorkflowAgent
retryWorkflowAgent
enqueueWorkflowNotification
completeWorkflowTask
workflow_progress
workflow_agent
workflow_phase
workflow_log
task_local_workflow
task_local_workflow_skip_agent
task_local_workflow_retry_agent
remote-workflow
workflow_remote_agent
workflow-abort
WorkflowBudgetExceededError
tengu_workflow_agent_cap_exceeded
tengu_workflow_budget_cap_exceeded
```

This matches the blog's claim that workflows are a long-running, progress-tracked orchestration layer rather than just a normal prompt pattern.

## Feature gates and settings

The binary contains workflow gates and settings strings:

```text
CLAUDE_CODE_DISABLE_WORKFLOWS
CLAUDE_CODE_WORKFLOWS
allow_workflows
tengu_workflows_enabled
disableWorkflows
enableWorkflows
skipWorkflowUsageWarning
ultracodeKeywordTrigger
```

Observed setting descriptions include:

```text
Disable the Workflows feature (also via CLAUDE_CODE_DISABLE_WORKFLOWS).
Enable or disable the Workflows feature for this user. Unset = default by plan once the feature is available.
Enable the "ultracode" keyword trigger: including the keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger. Default: true.
Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration.
@internal Whether the user has accepted the multi-agent workflow usage warning. Until set, auto permission mode prompts before running a workflow.
```

These strings align closely with the blog's plan/admin gating, `ultracode`, and first-use confirmation descriptions.

## Tool invocation shape

The binary's Workflow input schema describes this shape:

```text
script: Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().
name: Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.
description: Ignored — set the workflow description in the script's `meta` block.
title: Ignored — set the workflow title in the script's `meta` block.
args: Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string.
scriptPath: Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result.
resumeFromRunId: Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only.
```

The schema requires one of `script`, `name`, or `scriptPath`.

This is more detailed than the blog: the blog does not disclose file syntax, but the binary does. The implementation appears to support all three modes:

1. inline self-contained script,
2. predefined workflow name,
3. persisted script path with optional resume ID.

## Workflow script format

The binary tool prompt says every script must begin with a pure-literal `meta` export:

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
```

Validation strings show the parser enforces:

- `export const meta = { name, description, phases }` must be the first statement.
- `meta.name` must be a non-empty string.
- `meta.description` must be a non-empty string.
- `meta` must be a pure literal: no computed keys, spread, function calls, methods, accessors, or template interpolation.
- scripts must be plain JavaScript, not TypeScript; type annotations, interfaces, and generics fail to parse.

Optional metadata observed:

- `title`
- `whenToUse`
- `phases`
- phase `detail`
- phase `model`

The blog does not document this syntax, so this is a binary-derived detail rather than a blog-confirmed claim.

## Script runtime API

The Workflow tool prompt embedded in the binary documents these globals:

### `agent(prompt, opts)`

Spawns a subagent. Options include:

```text
label
phase
schema
model
isolation: 'worktree'
agentType
```

Without `schema`, the return value is final text. With JSON Schema, the subagent is forced through structured output and the script receives the validated object. A skipped agent returns `null`.

### `pipeline(items, stage1, stage2, ...)`

Runs each item through all stages independently with no barrier between stages. This is described as the default for multi-stage work because it avoids waiting for every item to finish stage N before any item can enter stage N+1.

### `parallel(thunks)`

Runs tasks concurrently as a barrier. Throws inside thunks or agent errors resolve to `null` in the result array; the call itself does not reject.

### `phase(title)` and `log(message)`

Emit progress grouping and narrator/progress messages.

### `workflow(nameOrRef, args)`

Runs another workflow inline as a child using either a saved workflow name or `{ scriptPath }`. It shares concurrency cap, agent counter, abort signal, and token budget with the parent. Nesting is one level only; `workflow()` inside a child workflow throws.

### `args`

The value passed by the tool call, verbatim. The prompt explicitly warns not to pass JSON-compatible arrays/objects as stringified JSON.

### `budget`

A token-budget object:

```text
total: number | null
spent(): number
remaining(): number
```

The budget is shared across the main loop and all workflows. Once spent reaches total, further `agent()` calls throw.

## Determinism and resume behavior

The binary includes explicit restrictions:

```text
Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.
Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.
```

The tool prompt explains resume semantics:

```text
The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args = 100% cache hit.
```

This strongly supports the blog's statement that progress is saved and interrupted work can continue. The implementation detail is prefix-based caching of completed `agent()` calls, which the blog does not expose.

## Concurrency and caps

The workflow prompt states:

```text
Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow.
Total agent count across a workflow's lifetime is capped at 1000.
A single parallel()/pipeline() call accepts at most 4096 items.
```

This is consistent with the blog's “tens to hundreds of parallel subagents” framing, with the nuance that actual simultaneous concurrency is capped while large item sets are queued.

## Safety and permissions

The binary prompt says the model must only call Workflow after explicit opt-in to multi-agent orchestration. Opt-in examples include:

- user includes `ultracode`,
- ultracode is on for the session,
- user directly asks to run a workflow / use multi-agent orchestration / fan out agents,
- a skill or slash command instructs Workflow use,
- user asks for a specific named or saved workflow.

For other tasks, even if they would benefit from parallelism, the prompt says to use ordinary Agent calls or ask whether to run a workflow.

This aligns with the blog's first-run confirmation and token-cost warning. The binary is more conservative and explicit than the blog: it treats workflow use as a user opt-in because workflows can spawn dozens of agents and consume substantial tokens.

## Built-in workflows observed

The blog does not enumerate built-in workflows. The current 2.1.165 binary contains clear embedded evidence for at least these workflow definitions:

### `code-review`

Observed description:

```text
Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.
Launched by the /code-review skill at high, xhigh, or max effort when workflows are enabled. Pass args as "<level> [target]".
```

The embedded script comments describe:

```text
code-review: Scope → pipeline(per-angle Find → dedup → Verify) → Sweep (xhigh/max) → Synthesize
high   → 3 correctness + 4 cleanup angles × 6 → ≤10 findings
xhigh  → 5 correctness + 4 cleanup angles × 8 → sweep → ≤15 findings
max    → same structure as xhigh; API reasoning effort differs, not fan-out
MAX_VERIFY = 25
SWEEP_MAX = 8
```

This matches the blog's quality-control framing: independent agents, verifier/refuter passes, and capped synthesis.

### `deep-research`

Observed description:

```text
Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.
When the user wants a deep, multi-source, fact-checked research report on any topic.
```

Embedded script comments and constants show:

```text
deep-research: Scope → pipeline(Search → URL-dedup → Fetch+Extract) → 3-vote Verify → Synthesize
Workflow({name: 'deep-research', args: '<question>'})
VOTES_PER_CLAIM = 3
REFUTATIONS_REQUIRED = 2
MAX_FETCH = 15
MAX_VERIFY_CLAIMS = 25
```

The script uses schemas for scope, search results, source extraction, verdicts, and report synthesis.

### Other workflow-like names

The binary includes command/workflow-related name evidence for these names, but static strings alone are weaker because some words are common or may be command names rather than fully embedded scripts:

```text
autopilot
bugfix
bughunt
dashboard
docs
investigate
```

Earlier repository notes for 2.1.150 also observed:

```text
bughunt-lite
plan-hunter
review-branch
```

In the 2.1.165 static pass, `bughunt-lite`, `plan-hunter`, and `review-branch` were not strongly re-confirmed. Treat built-in name coverage as version-scoped. The strongest 2.1.165 built-in workflow evidence is for `code-review` and `deep-research`, because their descriptions and script bodies are visible.

## Saved and plugin workflows

The binary contains strings for loading workflows from plugins and local workflow directories:

```text
loadPluginWorkflows
clearPluginWorkflowCache
Plugin workflow
Failed to load workflow from
/workflows
workflows/
Path to a workflows directory or .js file, relative to the plugin root. When set, the workflows/ directory is not auto-loaded
Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.
```

This implies the official implementation supports:

- built-in workflows,
- user/project saved workflows under `.claude/workflows/`,
- plugin-provided workflows.

The blog's user-facing text does not mention these details.

## UI and task model

Observed UI/task strings include:

```text
/workflows to view dynamic workflow runs
Dynamic workflow
Dynamic workflow cancelled
Loading dynamic workflow history
WorkflowDetailDialog
WorkflowPermissionDialog
pendingWorkflows
pendingWorkflowCount
hasPendingWorkflows
1 background dynamic workflow
background dynamic workflows
1 remote dynamic workflow
remote dynamic workflows
```

The binary distinguishes local and remote workflow execution:

```text
local_workflow
remote-workflow
workflow_remote_agent
workflow-remote-agent
Remote dynamic workflow completed
```

This aligns with the blog's long-running progress model and suggests the product has both local background workflow tasks and remote/CCR-launched workflow sessions.

## Comparison matrix against the blog

| Blog description | Binary observation | Assessment |
| --- | --- | --- |
| Workflows orchestrate many parallel subagents | `agent()`, `pipeline()`, `parallel()`, concurrency cap, 1000-agent lifetime cap | Matches |
| Claude decomposes a prompt into subtasks | Workflow tool prompt tells model to author scripts that fan out, verify, synthesize; built-ins include scope/decompose phases | Matches |
| Results are checked before combining | Built-in `code-review` and `deep-research` have verifier/refuter/voting stages | Matches |
| Useful for audits, migrations, research, reviews | Tool prompt examples include Understand, Design, Review, Research, Migrate; built-ins include code review and deep research | Matches |
| First run asks for confirmation | `WorkflowPermissionDialog`, `workflowNeedsUsageConsentPrompt`, `recordWorkflowUsageConsent`, `skipWorkflowUsageWarning` | Matches |
| Admin/user feature gates | `CLAUDE_CODE_DISABLE_WORKFLOWS`, `allow_workflows`, `enableWorkflows`, `disableWorkflows`, `tengu_workflows_enabled` | Matches |
| `ultracode` lets Claude decide when to use workflows | `ultracodeKeywordTrigger`, session ultracode setting, prompt text requiring Workflow for substantive tasks when ultracode is on | Matches |
| Long-running progress is saved and resumable | `workflowRunId`, `resumeFromRunId`, persisted `scriptPath`, workflow journal strings, deterministic guards | Matches, with implementation detail |
| Blog says workflows can run hours/days | Binary has local/background/remote workflow task model and history/progress UI strings | Consistent, not independently time-tested |
| Blog lists built-in workflows | Blog does not list them | Not applicable |
| Blog documents script syntax | Blog does not document it | Binary reveals extra detail |

## Implementation goals

The local implementation goal is practical compatibility with the official Dynamic Workflows runtime, not source-level or byte-for-byte reproduction. The recovered codebase should provide the same user-visible workflow semantics wherever those semantics can be inferred from the official binary and blog.

### Local implementation status

The next runtime compatibility pass implements parser-level and run-session compatibility for official-style scripts: first-statement `export const meta`, official event helpers, runtime globals, persisted metadata, and same-session unchanged-prefix resume for completed agent calls. It remains a clean-room compatibility layer and does not copy proprietary built-in workflow source.

Priority goals:

1. Provide a hidden-compatible `Workflow` facade that accepts `script`, predefined `name`, and persisted `scriptPath` inputs, with `args` passed verbatim and `resumeFromRunId` supported for reruns.
2. Validate workflow scripts as plain JavaScript modules whose first statement is a pure-literal `export const meta = {...}` block with required `name` and `description` fields.
3. Implement the official runtime globals: `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, and `budget`.
4. Preserve deterministic replay by rejecting `Date.now()`, argless `new Date()`, and `Math.random()` inside workflow scripts.
5. Persist every inline workflow script to an editable `scriptPath` and return both `scriptPath` and `workflowRunId` from launched runs.
6. Store progress in official-style event categories: `workflow_progress`, `workflow_agent`, `workflow_phase`, and `workflow_log`.
7. Support prefix-cache resume semantics: unchanged completed `agent()` calls should return cached results, while the first edited or new call and all following calls run live.
8. Mirror the official concurrency model closely enough for compatibility testing: queue large `pipeline`/`parallel` inputs, enforce a per-run agent cap, and make cap differences explicit when local defaults are intentionally lower.
9. Restore clean-room equivalents for confirmed built-ins, especially `code-review` and `deep-research`, using the same high-level quality patterns: fan-out, deduplication, adversarial verification, voting, and synthesis.
10. Keep workflow scripts as orchestration only: direct filesystem, shell, and external side effects should happen through spawned agents under normal tool permissions and hooks.

Compatibility success criteria:

- A saved or inline workflow can be launched, inspected, interrupted, edited, and relaunched from `scriptPath`.
- Structured `agent(..., { schema })` calls return validated objects rather than requiring string parsing.
- `pipeline` starts later stages per item without waiting for a global barrier, while `parallel` behaves as an explicit barrier.
- The workflow run state is readable enough to power `/workflows` status/detail views and binary-compatibility reports.
- Built-in workflow metadata and user-facing behavior remain version-scoped, so 2.1.150-only names are not treated as guaranteed 2.1.165 built-ins.

## Code improvement goals

The codebase should evolve toward a small, testable workflow runtime with clear separation between parsing, execution, persistence, progress rendering, and built-in workflow registration.

Recommended code improvements:

1. Split workflow concerns into focused modules: script parsing/validation, registry/discovery, runtime execution, event persistence, resume cache, and UI/status formatting.
2. Make workflow event types explicit and shared across runner, task state, `/workflows`, and compatibility tooling to avoid string drift.
3. Centralize cap enforcement for concurrent agents, total agents, `pipeline`/`parallel` item counts, and token budget exhaustion.
4. Replace ad hoc script execution paths with one deterministic VM boundary that exposes only documented workflow globals.
5. Add unit tests for `meta` validation edge cases: non-first export, computed keys, spreads, template interpolation, TypeScript syntax, missing fields, and reserved keys.
6. Add runtime tests for deterministic guards, especially `Date.now()`, `new Date()`, bare `Date()`, `new Date(value)`, and `Math.random()` behavior.
7. Add behavior tests that distinguish `pipeline` streaming-stage semantics from `parallel` barrier semantics.
8. Persist workflow run metadata in a schema that can be migrated as official compatibility findings change.
9. Keep built-in workflow definitions clean-room and data-driven, with metadata export tests comparing local names and descriptions against the observed official binary evidence.
10. Improve resume implementation with stable `agent()` call identity based on prompt, options, phase, schema, and argument context rather than fragile array position alone.
11. Make permission behavior explicit for workflow-spawned agents, including any intentional divergence from official defaults.
12. Keep the compatibility runner as the regression gate for workflow work, with stable artifacts for official stdout/stderr, local stdout/stderr, manifests, and confirmed differences.
13. Prefer concise textual `/workflows` status first, then layer richer interactive UI on top of the same typed state model.
14. Document every intentional mismatch with the official runtime so future work can distinguish missing compatibility from deliberate safety choices.

Non-goals:

- Do not copy proprietary workflow source from the official binary.
- Do not make workflow scripts a general Node.js execution environment.
- Do not bypass existing Claude Code permission, hook, or worktree safety boundaries.
- Do not treat weak string hits for generic names such as `docs` or `dashboard` as definitive built-in workflow proof without metadata/script context.

## Conclusions

The installed 2.1.165 official Claude Code binary is consistent with the blog's Dynamic Workflows description. Static evidence shows a substantial hidden workflow runtime: a `Workflow` tool, workflow permission dialog, progress/task events, background and remote workflow modes, saved script paths, resume IDs, deterministic script restrictions, and a JavaScript orchestration DSL around `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, and `budget`.

The binary goes beyond the blog in several important implementation details:

1. Workflow scripts are plain JavaScript modules beginning with a pure-literal `export const meta = {...}`.
2. Workflow invocations can use inline `script`, predefined `name`, or persisted `scriptPath`.
3. Resume is implemented by caching unchanged-prefix `agent()` calls keyed by script/args/run state.
4. `Date.now()`, argless `new Date()`, and `Math.random()` are intentionally blocked to preserve replayability.
5. Concurrency is capped at `min(16, cpu cores - 2)` while total lifetime agent count is capped at 1000.
6. Built-in workflow bodies for at least `code-review` and `deep-research` are embedded and use adversarial verification/voting before synthesis.

For this repository's compatibility work, the most important official behaviors to mirror are:

- `Workflow({ script })`, `Workflow({ name })`, and `Workflow({ scriptPath, resumeFromRunId })` input semantics,
- pure-literal `meta` validation,
- plain-JavaScript-only parsing,
- structured `agent(..., { schema })` returns,
- `pipeline` default semantics versus `parallel` barrier semantics,
- progress events using `workflow_progress`, `workflow_agent`, `workflow_phase`, and `workflow_log`,
- deterministic runtime guards,
- persisted `scriptPath` and `workflowRunId`,
- prefix-cache resume behavior,
- built-in `code-review` and `deep-research` quality patterns.
