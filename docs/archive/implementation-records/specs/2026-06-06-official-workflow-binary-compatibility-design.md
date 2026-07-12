# Official Workflow Binary Compatibility Design

## Goal

Build a repeatable compatibility workflow that exports, analyzes, and reconstructs the current official Claude Code workflow behavior from `/opt/homebrew/bin/claude`, then compares it against this repository's local workflow implementation across 100–200 full-run cases.

The target is 90% practical execution compatibility with the current installed binary for workflow execution behavior, saved workflow discovery, script persistence, progress events, control commands, and bundled workflow templates. Official documentation may explain intent, but the primary baseline is observable behavior from the installed binary.

## Scope

This design covers:

- Exporting official workflow names, snippets, metadata, runtime traces, generated artifacts, and observable state.
- Running 100–200 workflow cases against both the official binary and the local implementation.
- Confirming all differences through repeated runs before classifying them.
- Producing both a per-case evidence matrix and a prioritized development/integration guide.
- Reconstructing official workflow structures at a source-level design granularity for clean-room internal templates.

This design does not copy unverifiable private source code from the official binary. Source-level reconstruction means producing implementable internal templates from verified observable behavior, binary strings, runtime traces, and generated artifacts.

## Current project context

The repository already has a substantial local workflow implementation:

- `src/tools/WorkflowTool/WorkflowFacadeTool.ts` exposes an official-compatible `Workflow` facade.
- `src/tools/WorkflowTool/workflowDsl.ts` loads constrained JavaScript workflow scripts and blocks nondeterministic APIs.
- `src/tools/WorkflowTool/workflowOrchestrator.ts` provides helpers such as `agent`, `parallel`, `series`, `retry`, `loopUntil`, `review`, `refute`, `synthesize`, and `vote`.
- `src/tools/WorkflowTool/runWorkflow.ts` executes workflow plans through the existing Agent runner.
- `src/tools/WorkflowTool/workflowRunSessions.ts` and `workflowScriptPersistence.ts` persist run metadata and scripts.
- `src/tools/WorkflowTool/workflowDiscovery.ts` discovers bundled, user, and project workflows.
- `src/tasks/LocalWorkflowTask/*` stores local workflow task state and progress.
- `src/commands/workflows/workflows.ts` exposes the `/workflows` command surface.
- `scripts/export-official-workflow-metadata.mjs`, `scripts/compare-bundled-workflows.mjs`, and `scripts/workflow-compatibility-benchmark.mjs` provide early export and benchmark support.
- `.claude/official-workflow-metadata.json` currently records observed bundled workflow names: `autopilot`, `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `deep-research`, `docs`, `investigate`, `plan-hunter`, and `review-branch`.

The missing pieces are a large case corpus, a dual-runner harness, per-case artifacts, repeated confirmation of small differences, and documentation that converts confirmed differences into implementation priorities.

## Architecture

Use a matrix-driven black-box compatibility harness with four layers.

### 1. Case matrix generator

The generator creates structured workflow cases with stable IDs, inputs, fixture files, env overrides, expected probes, and comparison rules. Cases are grouped by behavior family so results can be summarized by compatibility area rather than only by pass/fail count.

Each case defines:

- `id`
- `title`
- `category`
- `officialCommand`
- `localCommand`
- `cwdFixture`
- `env`
- `inputPrompt` or workflow args
- expected artifact paths
- normalization rules
- retry/confirmation policy
- timeout and max output size

### 2. Dual executor

The official executor runs `/opt/homebrew/bin/claude` in isolated per-case workspaces. The local executor runs the repository implementation with equivalent inputs, cwd, and feature flags.

Both executors capture:

- command and env
- stdin/input prompt
- stdout and stderr
- exit code and signal
- wall-clock duration
- generated files in the case workspace
- `.claude` artifacts created by the run
- workflow run metadata, if present
- event type names and event payload shapes
- script paths and workflow run IDs
- slash command/help/status output where applicable

The harness never writes into the user's working tree except under controlled output directories. It does not push, commit, delete user files, or overwrite unrelated state.

### 3. Artifact diff and normalization

The diff layer compares observable behavior while avoiding false positives from model-generated prose. It uses different comparison modes:

- exact match for exit codes, event type names, stable JSON fields, file existence, workflow discovery precedence, and deterministic error categories
- schema match for event payloads, metadata, run session records, and generated script descriptors
- semantic bucket match for model prose such as agent summaries, research text, and code review wording
- fuzzy/manual-review required for outputs that are expected to vary by model response

Every difference receives:

- `same`, `different`, `missing-official`, `missing-local`, `flaky`, or `environmental`
- severity: P0, P1, P2, or intentional divergence
- evidence file links
- rerun count
- likely implementation area

### 4. Confirmation loop

Any difference, including small text or schema differences, is confirmed before it becomes a documented compatibility gap.

The default confirmation policy is:

- run each case once against official and local
- rerun any differing case at least twice
- if the difference persists with equivalent inputs, mark it `confirmed`
- if it changes across runs, mark it `flaky` and include all artifacts
- if it depends on auth, network, model availability, or environment, mark it `environmental`

This is required because model text can vary even when workflow mechanics match.

## Official workflow export and source-level reconstruction

Official workflow export has three layers.

### Observable export

Record the current official binary state:

- binary path and version
- binary hash
- known workflow names from strings and command surfaces
- extracted strings snippets around workflow names
- slash command availability and hidden command exposure
- workflow tool or command schema if observable
- official runtime event names
- official-generated script/session artifacts
- per-workflow runtime traces from representative prompts

### Behavioral reconstruction

For each observed official workflow, run multiple prompts and infer a structured template:

- purpose
- accepted argument shapes
- phase sequence
- agent roles
- prompts or prompt intent, where inferable
- review/refute/synthesis behavior
- retry/convergence behavior
- generated file behavior
- progress event behavior
- resume/scriptPath behavior
- failure behavior

The reconstruction is evidence-backed. Each inferred field links back to official run artifacts, binary snippets, or repeated behavior observations.

### Clean-room internal integration

The internal implementation uses reconstructed behavior to create local templates and runtime behavior. It must not depend on unverifiable private script text.

Each integrated workflow template must include:

- source-level local implementation
- mapped official evidence cases
- known differences
- compatibility score for that workflow
- follow-up issues or implementation tasks

## Case matrix

Target around 160 cases, with room to expand to 200 if coverage gaps remain.

### Official workflow export and metadata: 20 cases

Cover:

- binary version and hash
- workflow name extraction
- strings context extraction
- command exposure under default env
- command exposure under workflow-related env flags
- bundled workflow coverage against local templates
- metadata export stability across repeated runs
- unknown workflow behavior
- workflow help/status/list surfaces

### General workflow task behavior: 25 cases

Cover representative user tasks:

- write a small JavaScript utility
- write a JavaScript test spec
- debug a failing JS snippet
- write a TypeScript type helper
- produce a code review plan
- research a repo concept
- summarize docs
- plan a bugfix
- generate implementation steps
- compare alternatives
- produce a small spec document in an isolated fixture

### Args and invocation shapes: 25 cases

Cover:

- omitted args
- string args
- object args
- array args
- number args
- boolean args
- null args
- nested JSON args
- malformed JSON CLI args
- long args
- non-ASCII args
- shell-sensitive characters
- args passed through saved workflow commands
- args passed through inline `Workflow({ script, name, args })`
- args passed through `Workflow({ scriptPath, args })`

### Workflow discovery and shadowing: 20 cases

Cover:

- user workflow discovery from `~/.claude/workflows`
- project `.claude/workflows`
- project `docs/workflows`
- project shadows user
- local duplicate names
- invalid file extension
- invalid JS file
- deleted workflow after discovery
- nested workflow files
- workflow with same name as bundled workflow

### JavaScript runtime and orchestration: 20 cases

Cover:

- declarative `workflow(...)`
- default async function export
- `agent`
- `parallel`
- `series`
- `retry`
- `loopUntil`
- `review`
- `refute`
- `synthesize`
- `vote`
- deterministic errors for `Date.now()`
- deterministic errors for `new Date()`
- deterministic errors for `Math.random()`
- missing `process`
- missing `require`
- helper error reporting
- max concurrency behavior
- max agents behavior

### Control surface and persistence: 15 cases

Cover:

- status after run
- list runs
- show run detail
- pause
- resume
- retry agent
- skip agent
- scriptPath rerun
- script edit and rerun
- resumeFromRunId metadata
- workflowRunId stability
- session artifact layout
- official event names
- local task state mapping

### Error behavior: 15 cases

Cover:

- missing workflow
- invalid workflow script syntax
- valid JS but invalid workflow shape
- bad args
- permission denied
- agent failure
- timeout
- output too large
- interrupted run
- missing scriptPath
- unreadable scriptPath
- duplicate phase ID
- duplicate agent ID
- invalid phase dependency
- deterministic runtime violation

### Long-running and multi-agent behavior: 20 cases

Cover:

- independent implementer agents
- reviewer/refuter loops
- synthesis after parallel attempts
- build/test/repair convergence pattern
- two reviewers per generated file
- multi-phase research plan
- multi-phase spec writing
- dashboard-style monitoring
- bughunt-lite-style scan
- full bughunt-style scan
- review-branch-style review
- docs workflow behavior
- investigate workflow behavior
- plan-hunter workflow behavior
- autopilot-style end-to-end task runner behavior

## Documentation outputs

### Per-case evidence matrix

Write a machine-readable JSON report and a human-readable Markdown report.

Each row includes:

- case ID and category
- scenario
- official command/env/input
- local command/env/input
- official artifacts
- local artifacts
- same points
- confirmed differences
- rerun count
- severity
- confidence
- likely source area
- recommended action

### Development and integration guide

Write a prioritized guide organized by implementation area:

- `WorkflowFacadeTool`
- `workflowDsl`
- `workflowOrchestrator`
- `workflowDiscovery`
- `workflowScriptPersistence`
- `workflowRunSessions`
- `runWorkflow`
- `LocalWorkflowTask`
- `/workflows` command
- bundled workflow templates
- benchmark/export scripts

Each section lists confirmed differences, evidence case IDs, expected official behavior, local current behavior, and proposed internal changes.

## Compatibility scoring

Use practical compatibility, not byte-for-byte equality.

Suggested scoring weights:

- 20% workflow discovery and invocation
- 20% script persistence, `scriptPath`, and `workflowRunId`
- 20% JS workflow runtime and orchestration
- 15% progress events and task state
- 10% control surface behavior
- 10% bundled workflow template behavior
- 5% error messages and UI text

A local result can count as compatible when the user-observable behavior and continuation affordances match, even if internal storage paths or exact prose differ. Storage/schema differences remain documented if they could affect future integration.

## Execution plan constraints

The harness must be resumable and artifact-first:

- every case gets an isolated workspace
- every command is logged before execution
- every run writes artifacts before comparison
- completed cases are skipped unless `--force` is set
- differing cases can be rerun independently
- official and local artifacts are never overwritten without archiving prior attempts
- long-running cases have explicit timeouts
- model-output-heavy cases use semantic comparison buckets

## Risks and mitigations

### Official binary may not expose hidden workflow surfaces

Mitigation: treat command output, strings, session artifacts, and generated files as the official observable baseline. Document unavailable surfaces as official-binary-limited rather than local failures.

### Model output variability may create false differences

Mitigation: normalize prose, compare mechanics separately from content, and require repeated confirmation for differences.

### Full-run testing may consume significant tokens and time

Mitigation: make runs resumable, isolate artifacts, order cases from low-cost to high-cost, and allow category filters.

### Source-level reconstruction may overfit to limited prompts

Mitigation: require multiple prompts per official workflow and link every inferred structure to evidence.

### Local implementation may intentionally diverge for safety

Mitigation: document intentional divergences separately from compatibility gaps. Examples may include lower default concurrency or safer permission modes.

## Success criteria

The effort succeeds when:

1. A 100–200 case matrix exists and can run official and local executors.
2. Each completed case has official artifacts, local artifacts, normalized comparison output, and rerun evidence for differences.
3. Official workflow structures are reconstructed into evidence-backed internal design templates.
4. A Markdown evidence report and development/integration guide exist.
5. The guide identifies the smallest implementation changes needed to reach roughly 90% practical compatibility with `/opt/homebrew/bin/claude`.
6. Remaining incompatibilities are classified as P0/P1/P2, flaky, environmental, unavailable in the current binary, or intentional divergence.

## Approval checkpoint

After this design is accepted, the next step is to create an implementation plan that builds the harness, case corpus, export improvements, comparison reports, and integration guide in testable increments.
