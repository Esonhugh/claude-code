# Official Dynamic Workflows Runtime Compatibility Design

## Goal

Implement the next compatibility pass for Claude Code Dynamic Workflows so this repository behaves like the installed official `/opt/homebrew/bin/claude` 2.1.165 workflow runtime for user-visible semantics: script invocation, script validation, orchestration globals, progress events, persistence, and same-session resume.

The goal is practical runtime compatibility, not byte-for-byte reconstruction. The implementation must remain clean-room and should use the official binary only as an observable behavioral baseline.

## Background

The current repository already has substantial workflow infrastructure:

- `src/tools/WorkflowTool/WorkflowFacadeTool.ts` exposes an official-shaped `Workflow` facade for saved names, inline scripts, and `scriptPath` runs.
- `src/tools/WorkflowTool/workflowDsl.ts` loads JavaScript workflow files in a constrained VM and blocks `Date.now()` / `Math.random()`.
- `src/tools/WorkflowTool/workflowOrchestrator.ts` provides plan-building helpers such as `agent`, `parallel`, `series`, `retry`, `loopUntil`, `review`, `refute`, `synthesize`, and `vote`.
- `src/tools/WorkflowTool/runWorkflow.ts` executes validated plans through the existing Agent runner.
- `src/tools/WorkflowTool/workflowRunSessions.ts` and `workflowScriptPersistence.ts` persist run metadata and scripts.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` records local workflow task state.
- `src/tools/WorkflowTool/compatibility/*` and `scripts/workflow-binary-compatibility-runner.mjs` provide the start of a binary compatibility harness.

The binary analysis in `docs/official-dynamic-workflows-binary-analysis.md` shows that official Dynamic Workflows use a more specific runtime model than the current DSL-to-plan bridge:

- scripts begin with a first-statement pure-literal `export const meta = {...}`;
- the script body can call `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, and `budget`;
- `pipeline` is streaming by item, while `parallel` is an explicit barrier;
- `Workflow({ script })` persists a script and returns `scriptPath` plus `workflowRunId`;
- `Workflow({ scriptPath, resumeFromRunId })` reuses completed unchanged-prefix `agent()` calls;
- progress is expressed through official-style event names: `workflow_progress`, `workflow_agent`, `workflow_phase`, and `workflow_log`.

## Scope

This spec covers the next runtime compatibility pass:

1. Official-style script parsing and `meta` validation.
2. Official-style runtime globals and semantics.
3. Workflow event model alignment.
4. Script persistence and run session metadata alignment.
5. Same-session prefix-cache resume for completed `agent()` calls.
6. Compatibility tests and documentation for intentional divergences.

This spec does not cover building a full interactive `/workflows` TUI, remote workflow execution, or proprietary built-in workflow source recovery.

## Recommended approach

Use an incremental compatibility layer around the existing implementation rather than replacing the current workflow system.

Alternative approaches considered:

1. **Patch the existing DSL in place.** Fastest, but keeps parsing, execution, persistence, and compatibility semantics tangled in `workflowDsl.ts` and `runWorkflow.ts`.
2. **Replace workflow execution with a new official-style engine immediately.** Cleaner long-term, but high risk because current workflow commands, fixtures, and compatibility harness already depend on the existing spec runner.
3. **Add an official-compatible runtime layer and bridge it to the existing runner.** Recommended. It creates focused modules for official semantics while preserving the working runner and command surfaces.

The recommended path is option 3: introduce small, tested modules for official script parsing, runtime execution planning, events, and resume cache, then adapt `WorkflowFacadeTool` and `runWorkflowPlan` to use them where appropriate.

## Architecture

### Module boundaries

Add or evolve these modules under `src/tools/WorkflowTool/`:

| Module | Responsibility |
| --- | --- |
| `workflowScriptParser.ts` | Parse plain JavaScript workflow scripts, require first-statement `export const meta`, and validate pure-literal metadata. |
| `workflowRuntimeGlobals.ts` | Build the constrained VM globals: `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, `budget`, deterministic `Date`, and deterministic `Math`. |
| `workflowExecutionPlan.ts` | Represent official-style dynamic calls as executable planned work while still allowing the existing runner to dispatch agents. |
| `workflowEvents.ts` | Define official-style progress event types and conversion helpers for `LocalWorkflowTask` and persisted sessions. |
| `workflowResumeCache.ts` | Store and look up completed `agent()` call results for `resumeFromRunId`. |
| `workflowRunSessions.ts` | Extend existing session persistence with official-compatible run IDs, script snapshots, resume metadata, events, and cache indexes. |

Existing modules remain in place:

- `WorkflowFacadeTool.ts` remains the user/model-facing tool.
- `workflowDiscovery.ts` remains the registry for bundled, user, project, and plugin workflows.
- `runWorkflow.ts` remains the bridge to the existing Agent runner.
- `WorkflowTool.ts` and `/workflows` commands remain the inspection/control surface.

### Data flow

Inline script flow:

1. `WorkflowFacadeTool` receives `{ script, name, args }`.
2. `workflowScriptPersistence` creates a `workflowRunId` and persists the script to an editable `scriptPath`.
3. `workflowScriptParser` validates `export const meta = {...}` and extracts `{ meta, scriptBody }`.
4. `workflowRuntimeGlobals` evaluates the script body in a constrained runtime.
5. Calls to `agent()` produce executable agent call records and official-style `workflow_agent` events.
6. `pipeline()` and `parallel()` schedule agent calls according to official semantics and feed results forward.
7. `runWorkflow.ts` dispatches agent records through the existing Agent tool path.
8. `workflowRunSessions` persists progress, events, results, `scriptPath`, and `workflowRunId`.
9. Tool output returns a launched-run summary containing `workflowRunId` and `scriptPath`.

Saved workflow flow:

1. `WorkflowFacadeTool` receives a string or `{ name, args }`.
2. `workflowDiscovery.ts` resolves a built-in, user, project, or plugin workflow to a self-contained script.
3. The flow continues as an inline script run, with provenance recorded in the session.

Script path flow:

1. `WorkflowFacadeTool` receives `{ scriptPath, args, resumeFromRunId }`.
2. `workflowScriptPersistence` resolves and reads the script path.
3. `workflowRunSessions` loads resume metadata when `resumeFromRunId` is present.
4. `workflowResumeCache` returns cached results for unchanged completed `agent()` calls until the first changed or new call.
5. Live execution continues from that point and writes a new run session.

## Script parser design

`workflowScriptParser.ts` should validate the official script contract before runtime execution.

Required behavior:

- Accept plain JavaScript source text.
- Reject TypeScript syntax with a clear parse error.
- Require the first statement to be `export const meta = {...}`.
- Require `meta.name` and `meta.description` as non-empty strings.
- Allow optional `meta.title`, `meta.whenToUse`, and `meta.phases`.
- Require `meta` to be a pure literal: strings, numbers, booleans, null, arrays, plain objects, static template literals without interpolation, and negative numeric literals only.
- Reject computed keys, spreads, methods, accessors, function calls, identifiers, template interpolation, sparse arrays, and reserved keys.
- Return `{ meta, scriptBody }` so the VM evaluates only the body after metadata extraction.

This should replace the current broad `transformModuleSyntax()` behavior for official-compatible runs. The older declarative `workflowSpec` export path can remain as a legacy/local compatibility mode if existing fixtures depend on it.

## Runtime globals design

The official runtime globals should be the narrow interface exposed to workflow scripts.

### `agent(prompt, opts)`

Required behavior:

- Accept `prompt: string` plus optional `{ label, phase, schema, model, isolation, agentType }`.
- Register an agent call with stable identity derived from prompt, normalized options, active phase, schema, and call order context.
- If `schema` is present, request structured output and return the validated object.
- If no `schema` is present, return final text.
- Return `null` when the user skips the agent.
- Emit `workflow_agent` lifecycle events.

### `pipeline(items, stage1, stage2, ...)`

Required behavior:

- Process each item through all stages independently.
- Do not wait for all items to finish a stage before starting the next stage for an item.
- A stage error drops that item to `null` and skips remaining stages for that item.
- Enforce the per-call item cap.

### `parallel(thunks)`

Required behavior:

- Execute thunks concurrently as a barrier.
- Return an array in input order.
- Convert thrown errors or failed agents to `null` for that thunk.
- Enforce the per-call item cap.

### `phase(title)` and `log(message)`

Required behavior:

- `phase(title)` sets the current progress group for subsequent agent calls.
- `log(message)` emits `workflow_log` events and persists them in the run session.
- Phase titles should match `meta.phases[].title` when present but can create ad hoc phase groups.

### `workflow(nameOrRef, args)`

Required behavior:

- Run one child workflow inline by saved name or `{ scriptPath }`.
- Share concurrency cap, agent count, abort signal, and budget with the parent.
- Expose child agents under a child workflow grouping in progress output.
- Reject workflow nesting deeper than one level.

### `args`

Required behavior:

- Pass the tool input verbatim.
- Do not JSON-parse string args automatically in official-compatible mode.
- Preserve arrays and objects as actual JSON-compatible values.

### `budget`

Required behavior:

- Expose `total`, `spent()`, and `remaining()`.
- Count output tokens from the main loop and all workflow agents when token accounting is available.
- Throw a `WorkflowBudgetExceededError`-style error before starting further agents after the budget is exhausted.
- If no budget exists, `remaining()` returns `Infinity`.

### Deterministic built-ins

Required behavior:

- `Date.now()` throws the official deterministic-runtime error.
- bare `Date()` throws the same error.
- argless `new Date()` throws the same error.
- `new Date(value)` can be allowed only if it cannot recover wall-clock time; if that distinction is not implemented, reject all `new Date(...)` forms initially and document the divergence.
- `Math.random()` throws the official deterministic-runtime error.
- No `process`, `require`, Node filesystem APIs, or shell helpers are exposed.

## Resume cache design

Official strings describe same-session resume as unchanged-prefix reuse: completed `agent()` calls with unchanged prompt/options return cached results instantly; the first edited or new call and everything after it runs live.

Implement a minimal same-session cache:

- Each completed agent call writes a cache entry to the workflow run session.
- Each entry records call index, call identity hash, prompt hash, normalized options hash, phase, schema hash, result summary/value, and completion status.
- A resume run loads the prior run's completed entries by `resumeFromRunId`.
- During script execution, compare each `agent()` call against the corresponding prior entry.
- While the prefix matches, return cached results and emit a cache-hit event.
- On the first mismatch, mark the resume prefix as broken and run that call plus all subsequent calls live.
- Same script plus same args should produce 100% cache hit when all prior calls completed.

This first pass is same-session and prefix-based only. It does not need arbitrary JavaScript continuation checkpoints.

## Event and task-state design

Create explicit event types in `workflowEvents.ts` and use them everywhere.

Required event names:

- `workflow_progress`
- `workflow_phase`
- `workflow_agent`
- `workflow_log`

Recommended event payload fields:

```ts
type WorkflowEvent =
  | { type: 'workflow_progress'; workflowRunId: string; status: string; completedAgents: number; totalAgents?: number; timestamp: number }
  | { type: 'workflow_phase'; workflowRunId: string; phase: string; status: string; detail?: string; timestamp: number }
  | { type: 'workflow_agent'; workflowRunId: string; agentId: string; label: string; phase?: string; status: string; cacheHit?: boolean; timestamp: number }
  | { type: 'workflow_log'; workflowRunId: string; message: string; timestamp: number }
```

`LocalWorkflowTask` may keep richer local state, but persisted sessions and compatibility reports should use these official-style event names to avoid string drift.

## Persistence design

Extend the current `.claude/workflow-runs` persistence without breaking existing artifacts.

Each run should persist:

- `workflowRunId`
- `taskId`
- workflow `name`
- `scriptPath`
- `resumeFromRunId`
- `args`
- `meta`
- `runScriptSnapshot`
- `events`
- agent results
- cache entries
- status and error state
- started/updated timestamps

The repo can continue writing both task-indexed and run-indexed files. Compatibility reports should prefer the run-indexed `workflowRunId/session.json` form.

## Permission and safety model

Workflow scripts are orchestration only. They must not become a privileged execution environment.

Rules:

- Direct filesystem, shell, MCP, and network effects happen through spawned agents and normal tool permissions.
- Workflow-spawned agents use explicit permission mode defaults. If local defaults differ from official `acceptEdits`, document the divergence.
- Worktree isolation is available only through `agent(..., { isolation: 'worktree' })` and should be used for parallel file mutation.
- The `Workflow` facade remains non-read-only and should continue to require permission in modes where launching many agents is gated.

## Built-in workflow compatibility

This runtime pass should not attempt to copy proprietary built-in scripts.

Required behavior:

- Keep clean-room templates for confirmed built-ins.
- Treat `code-review` and `deep-research` as the strongest 2.1.165 evidence-backed built-ins.
- Keep 2.1.150-only names version-scoped in metadata and compatibility reports.
- Compare local built-in metadata against observed official evidence using `scripts/export-official-workflow-metadata.mjs` and `scripts/compare-bundled-workflows.mjs`.

## Testing strategy

### Unit tests

Add focused tests for:

- `workflowScriptParser.ts` pure-literal validation.
- deterministic `Date` and `Math.random()` guards.
- `args` pass-through behavior.
- `pipeline` streaming semantics versus `parallel` barrier semantics.
- `workflow()` child nesting rejection.
- budget exhaustion.
- resume cache prefix hits and first-mismatch behavior.
- event creation and conversion helpers.

### Integration tests

Add tests that run the `Workflow` facade against small fixture scripts:

- inline script persists to `scriptPath` and returns `workflowRunId`.
- saved workflow name resolves to a script and launches.
- scriptPath rerun works after editing.
- `resumeFromRunId` returns cached result for unchanged first call and reruns after first changed call.
- structured `agent(..., { schema })` returns object-shaped data.
- logs and phase events appear in the persisted session.

### Compatibility harness tests

Extend `src/tools/WorkflowTool/compatibility/*` and `scripts/workflow-binary-compatibility-runner.mjs` cases for:

- script parser errors,
- deterministic runtime errors,
- args shapes,
- script persistence,
- event names,
- resume metadata,
- built-in metadata coverage.

The harness should classify differences as confirmed, flaky, environmental, unavailable in official binary, or intentional divergence.

## Success criteria

The implementation is complete when:

1. `Workflow({ script, name, args })` persists an official-style script, validates `meta`, launches a run, and returns `workflowRunId` plus `scriptPath`.
2. `Workflow({ scriptPath, args, resumeFromRunId })` loads the persisted script and performs same-session prefix-cache resume for completed unchanged agent calls.
3. Runtime scripts can use `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, and `budget` with documented official-compatible semantics.
4. `Date.now()`, bare `Date()`, argless `new Date()`, and `Math.random()` throw deterministic-runtime errors inside workflow scripts.
5. Persisted sessions include official-style events using `workflow_progress`, `workflow_phase`, `workflow_agent`, and `workflow_log`.
6. Unit and integration tests cover parser validation, runtime globals, persistence, events, and resume cache behavior.
7. Compatibility reports can identify which gaps remain versus `/opt/homebrew/bin/claude` 2.1.165.

## Non-goals

- Do not copy private official workflow script source.
- Do not implement remote workflow execution.
- Do not build a full interactive WorkflowDetailDialog clone.
- Do not expose Node.js APIs to workflow scripts.
- Do not force every existing declarative workflow fixture to migrate in this pass.
- Do not implement arbitrary cross-process JavaScript continuation checkpoints beyond prefix-cache resume.

## Risks and mitigations

### Runtime semantics may conflict with existing DSL fixtures

Mitigation: keep a legacy/local DSL mode if required, but make official-compatible mode the path used by `Workflow` facade and new tests.

### Prefix-cache identity may be too fragile

Mitigation: hash normalized prompt, options, phase, schema, and call index. Store enough debug fields in the session to explain misses.

### `pipeline` streaming semantics may be hard to express through the current plan runner

Mitigation: implement official runtime execution as a scheduler over agent calls rather than forcing all scripts through the old static phase graph.

### Token budget accounting may be incomplete

Mitigation: implement the budget API with best available local accounting first. If exact official token accounting is unavailable, document the divergence and still enforce explicit `budget.total` where provided.

### Permission defaults may differ from official behavior

Mitigation: make local defaults explicit in code and documentation. Treat safer local defaults as intentional divergence when necessary.

## Implementation checkpoint

After this spec is accepted, use `/writing-plans` to create the implementation plan. The plan should sequence work in this order:

1. parser and metadata validation,
2. official event types,
3. runtime globals and scheduler,
4. script persistence/session schema updates,
5. resume cache,
6. facade integration,
7. tests and compatibility cases,
8. documentation updates.
