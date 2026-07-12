# Dynamic Workflow and Agent Orchestration

## Purpose

This document explains how Claude Code dynamic workflows relate to subagents, agent teams, skills, hooks, permissions, and worktrees, then maps those concepts onto this recovered codebase for secondary development.

Dynamic workflows should not be treated as another agent type. They are an orchestration layer: a script or validated spec owns phase ordering, fan-out, cross-checking, retry policy, and synthesis while agents perform the actual work through normal tool permissions.

## Primitive model

| Primitive | Coordinator | State location | Best use |
| --- | --- | --- | --- |
| Skill | Current Claude session following loaded instructions | Main session context while loaded | Reusable procedure, checklist, domain knowledge, or hidden bundled teaching for model-side tool usage |
| Subagent | Current Claude session | Subagent context, summarized back to caller | Focused research, review, or implementation that would flood main context |
| Agent view | User | Separate background sessions | Independent tasks the user wants to monitor manually |
| Agent team | Team lead Claude session | Shared task list and mailbox | Multi-session collaboration where workers need to coordinate |
| Dynamic workflow | Workflow script/runtime | Script variables and workflow task state | Large repeatable fan-out, cross-checking, audits, migrations, or multi-angle planning |
| Worktree | User or orchestration layer | Separate git checkout | Filesystem isolation for parallel edits |
| Hook | Claude Code runtime | Settings and hook process result | Deterministic policy, validation, notification, and guardrails |
| Permission | Claude Code runtime | Permission settings and prompts | Safety boundary for tool use |

## Official design intent

Dynamic workflows exist to move orchestration out of turn-by-turn Claude judgment and into a readable, repeatable script. That matters when a task requires more workers than a single conversation can coordinate, or when intermediate findings need to be cross-checked before they are trusted. The official launch blog also emphasizes long-running workflows that run for hours or days, save progress, continue after interruptions, and iterate through build/test/review loops until results converge.

The important design goals are:

1. Keep intermediate results out of the main conversation context.
2. Make the orchestration itself reviewable and reusable.
3. Support bounded fan-out across many agents.
4. Encode quality patterns such as adversarial review and synthesis.
5. Preserve normal tool permission boundaries.

## Local repository map

The recovered repository contains agent, task, workflow inspection, and minimal execution foundations:

- `src/commands.ts` gates workflow commands behind `WORKFLOW_SCRIPTS`.
- `src/tools.ts` gates `WorkflowTool` and bundled workflow initialization behind `WORKFLOW_SCRIPTS`.
- `src/tools/AgentTool/AgentTool.tsx` is the existing worker-spawn primitive used by executable workflow phases.
- `src/tools/TeamCreateTool/TeamCreateTool.ts`, `src/tools/TeamDeleteTool/TeamDeleteTool.ts`, and `src/tools/SendMessageTool/SendMessageTool.ts` provide team and mailbox primitives.
- `src/tools/TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, and `TaskListTool` provide shared task coordination.
- `src/tools/WorkflowTool/workflowSpec.ts` defines the declarative workflow spec and normalized dry-run plan types.
- `src/tools/WorkflowTool/workflowScriptParser.ts` validates official-style JavaScript workflow metadata.
- `src/tools/WorkflowTool/workflowRuntimeGlobals.ts` exposes official-compatible orchestration globals for plan-building scripts.
- `src/tools/WorkflowTool/workflowEvents.ts` centralizes official event names and payload constructors.
- `src/tools/WorkflowTool/workflowResumeCache.ts` implements same-session unchanged-prefix cache reuse for completed agent calls.
- `src/tools/WorkflowTool/validateWorkflowSpec.ts` rejects invalid workflow graphs before any worker can start.
- `src/tools/WorkflowTool/formatWorkflowDryRun.ts` formats the validated phase graph, fan-out, concurrency, review, permission, agent type, and model choices.
- `src/tools/WorkflowTool/workflowDiscovery.ts` discovers workflow specs from `docs/workflows/` and `.claude/workflows/` roots.
- `src/tools/WorkflowTool/createWorkflowCommand.ts` exposes valid workflow specs as workflow-backed prompt commands.
- `src/tools/WorkflowTool/runWorkflow.ts` executes validated phases through the `Agent` tool and records workflow task state.
- `src/tools/WorkflowTool/WorkflowTool.ts` exposes `list`, `show`, `dry-run`, `run`, `status`, `pause`, and `resume` actions.
- `src/commands/workflows/workflowsPage.tsx` opens the Dynamic workflows display and management UI; `src/commands/workflows/workflows.ts` contains legacy text helpers but should not become the interactive `/workflows` routing surface.
- `src/tasks.ts` conditionally registers `LocalWorkflowTask`.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` stores typed workflow phase and agent state plus kill, skip, retry, and retry-cleanup controls.

Current workflow surface:

- Workflow specs are discoverable, validated, dry-runnable, and executable through `WorkflowTool.run`; clean-room bundled workflows currently cover all observed official names: `autopilot`, `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `deep-research`, `docs`, `investigate`, `plan-hunter`, and `review-branch`. The bundled `deep-research` follows the strongest 2.1.165 evidence pattern: Scope → Search → URL dedup → Fetch+Extract → 3-vote Verify → Synthesize.
- Workflow files can be declarative JSON or JavaScript DSL files ending in `.js` under user `~/.claude/workflows/`, project `docs/workflows/`, or project `.claude/workflows/`; project definitions shadow user definitions with the same command name.
- The JavaScript DSL exposes declarative `workflow(...)`, shape-aware `agent(...)`, structured `args`, and official-style async orchestration helpers including `parallel`, `series`, `retry`, `loopUntil`, `review`, `refute`, `synthesize`, `vote`, and `log`.
- JavaScript workflow plans carry explicit runtime metadata (`javascript-worker`, source path, isolated runtime flag) plus a run script snapshot for persisted run sessions.
- A local `Workflow` facade accepts saved workflow names, inline `{ script, name, args }`, and `{ scriptPath, args, resumeFromRunId }` inputs, then delegates execution to the existing workflow runner.
- The `ultracode` keyword sets per-turn ultracode effort, shows the tmux-verified official prompt indicator `Dynamic workflow requested for this turn · opt+w to ignore`, and injects model-facing dynamic workflow orchestration guidance so complex prompts can route through `Workflow` without an explicit slash command. Official strings say the keyword opts that turn into the `Workflow` tool; local behavior implements that as model-visible orchestration guidance rather than a hardcoded forced tool call.
- The `Workflow` permission dialog uses saved workflow `export const meta` previews for both facade and internal tool calls, including description, phase details, script excerpts, args, consent options, `/workflows` usage-control text, and `ctrl+g` script editing guidance.
- A hidden bundled `workflow` skill teaches the model when and how to call `Workflow` / `WorkflowTool`; it is not user-invocable and should not be promoted as a user-facing slash command.
- `/workflows` is the Dynamic workflows display and management UI; it should not grow `list`, `show`, `dry-run`, `run`, or similar text-command semantics.
- Workflow-backed prompt commands reload JavaScript workflow files with the current command arguments before formatting the orchestration prompt.
- `WorkflowTool.run` executes phase work through the existing `Agent` tool, records `LocalWorkflowTask` phase state, and does not directly use shell or filesystem tools.
- `WorkflowTool.run` can launch phase workers as named teammates through the existing Agent/team path when `defaults.execution` is `team` and a team context exists, which lets tmux-backed teams provide an interactive pane experience.
- `scripts/workflow-tmux-e2e-smoke.mjs` creates a tmux workflow session, leader pane, named worker panes, and a captured transcript proving team-mode workflow interaction reaches tmux panes.
- `scripts/workflow-official-running-probe.mjs` launches an official saved workflow in tmux and captures real official running-detail phase/agent views under `.claude/workflow-official-running-probe/` for comparison.
- `scripts/workflow-running-detail-capture.mjs` creates a deterministic tmux transcript for the local running workflow detail surface, now using the official-style two-column phase/agent layout and running controls.
- `defaults.maxRetries` controls automatic retry scheduling for failed phase agents.
- Workflow task status renders a compact progress panel with `workflowRunId`, `scriptPath`, `progressVersion`, `defaultModel`, overall progress, per-phase progress bars, skipped/retry counts, official event count, token count, tool-use count, elapsed time, saved user input, execution mode, and team/tmux details when available.
- `WorkflowDetailDialog` renders a deterministic workflow detail snapshot with run identity, progress, phase rows, recent events, and official-style controls; `workflowDetailSnapshot.test.ts` locks this local UI text byte-for-byte.
- `pauseWorkflowTask()` and `resumeWorkflowTask()` provide workflow-level pause/resume state transitions exposed through `WorkflowTool` and `/workflows`; `WorkflowTool.pause` also persists official-style paused session state and resume prompt text under `.claude/workflow-runs/<workflowRunId>/session.json`.
- `killWorkflowTask()`, `skipWorkflowAgent()`, and `retryWorkflowAgent()` update workflow task state for the runtime; skip and retry controls now append official-style `workflow_agent` events in local task state.

InteractiveTerminal has its own hidden bundled teaching skill for model-side tool usage. The existing interactive terminal slash command remains a display/management surface; the teaching skill explains the `InteractiveTerminal` lifecycle and when to prefer it over `Bash`.

Official compatibility boundary from `/opt/homebrew/bin/claude` 2.1.150 experiments:

A detailed experiment matrix is maintained in `docs/workflow-compatibility-experiments.md`.

- The installed official binary contains a hidden `Workflow` tool and embedded built-in workflow names including `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `deep-research`, `docs`, `investigate`, `plan-hunter`, and `review-branch`; `autopilot` appears in descriptive binary strings as an end-to-end task runner.
- Official `Workflow` accepts a workflow name or `{ script, name, scriptPath }`; strings in the binary state that every invocation persists its script under the session directory and returns `scriptPath` for edit-and-rerun.
- Official workflow state includes `workflowRunId`, `workflow_progress`, `workflow_agent`, `workflow_phase`, `workflow_log`, and local task events such as `task_local_workflow`, `task_local_workflow_skip_agent`, and `task_local_workflow_retry_agent`.
- Official scripts intentionally disable `Date.now()`, `new Date()`, and `Math.random()` because they break resumability; this branch now mirrors those deterministic-runtime restrictions while exposing deterministic web-platform `URL` for official-style script helpers such as deep-research URL normalization.
- In `--print --bare` experiments, even with `CLAUDE_CODE_WORKFLOWS`, `tengu_workflows_enabled`, and `CLAUDE_CODE_RECOVER_FEATURES=WORKFLOW_SCRIPTS`, the hidden `Workflow` tool was not exposed in the init tool list, so direct tool execution could not be completed through non-interactive print mode.
- This branch supports a JavaScript DSL compatibility layer that converts a JS workflow declaration into the existing validated `WorkflowSpec` plan, persists run templates, and writes `.claude/workflow-runs/<taskId>.json` session metadata.
- The DSL runs in a constrained in-process VM context and intentionally exposes no shell or filesystem helpers; phase work still goes through normal Agent tool permission boundaries.

Additional recovered-source observations from `recover/claude-v2.1.165.js`:

- The official model-facing execution tool is named `Workflow` and has alias `RunWorkflow`; the recovered module export may be called `WorkflowTool`, but the tool object uses `name: "Workflow"` and `userFacingName(): "Workflow"`.
- Official `Workflow` has a long model-facing prompt that teaches explicit opt-in rules, inline script usage, `export const meta`, `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, child `workflow()`, pipeline-first guidance, concurrency caps, quality patterns, and resume behavior. The local `Workflow` facade prompt is intentionally much shorter; hidden bundled teaching skills now cover part of this gap.
- Official `Workflow` input accepts `script`, `name`, `args`, `scriptPath`, and `resumeFromRunId`; `description` and `title` are accepted but ignored in favor of script `meta`. `scriptPath` takes precedence over `script` and `name`, and `resumeFromRunId` is validated as `wf_[a-z0-9-]{6,}`. The local facade additionally accepts direct `plan` input and currently validates `resumeFromRunId` more loosely.
- Official output is structured: `status`, `taskId`, optional `runId`, `summary`, `transcriptDir`, `scriptPath`, `sessionUrl`, `warning`, and `error`. The local facade currently returns a text result, so task IDs, run IDs, and script paths are model-readable but not schema-addressable.
- Official workflow validation checks managed `disableWorkflows`, session/org/config enablement, script parse errors, deterministic-script violations such as `Date.now()`, `Math.random()`, and argless `new Date()`, plus still-running resume targets. Local tools are currently always enabled and rely more on runtime validation.
- Official permission handling supports per-workflow allow/ask/deny rules and can suggest adding an allow rule for a named workflow. Local `Workflow` and `WorkflowTool.run` currently ask every time instead of matching per-workflow rules.
- Official `meta` parsing uses an AST parser and pure-literal extraction; local parsing uses a lightweight scanner plus guarded object-literal evaluation. This is a parity and hardening gap if the goal is closer official compatibility.
- Official has a `remote_launched` result path for CCR sessions. Local workflow execution is currently local `LocalWorkflowTask` / workflow-run-session based.

Remaining workflow runtime gaps:

- Arbitrary JavaScript orchestration branches/loops beyond the declarative DSL-to-plan bridge remain a future enhancement.
- Cross-process JavaScript worker isolation can further harden the current constrained in-process VM boundary.
- `retryWorkflowAgent()` updates state for manual retries, while automatic retries during a run are handled by `defaults.maxRetries`.

## Secondary-development roadmap

### Phase 0: Documentation and boundaries

Document the primitive model, local extension points, and non-goals. This phase is complete.

### Phase 1: Declarative workflow spec

Define a reviewable workflow spec with phases, dependencies, fan-out, concurrency, review mode, permission mode, model, agent type, and output expectations. This phase is complete for the declarative dry-run format.

### Phase 2: Dry-run and command surfaces

Discover and validate workflow specs, then print the execution graph without spawning agents. This phase is complete for `/workflows`, workflow-backed prompt commands, and read-only `WorkflowTool` inspection.

### Phase 3: Minimal execution runtime

Map workflow phases to existing agent-spawn primitives. Store progress in `LocalWorkflowTaskState`. Enforce max concurrency, max agent count, and max retry count. This phase is complete for sequential phase execution with per-phase fan-out batches and automatic failed-agent retries.

### Phase 4: Cross-check and synthesis runtime

Execute review phases that compare independent findings and synthesize only verified claims. This phase is complete for declarative review phases executed through the same phase runner; richer confidence/voting metadata remains future work.

### Phase 5: UI and recovery

Add running workflow progress details, pause/resume/stop, saved run input, and cost visibility. This phase is complete for text status/control surfaces; richer visual panels and persistent run templates remain future work.

## Runtime integration points

Implemented dry-run, inspection, and minimal execution integration:

1. `src/tools/WorkflowTool/workflowSpec.ts` defines the stable declarative spec shape.
2. `src/tools/WorkflowTool/validateWorkflowSpec.ts` rejects invalid workflow graphs before any agent starts.
3. `src/tools/WorkflowTool/formatWorkflowDryRun.ts` powers dry-run output.
4. `src/tools/WorkflowTool/workflowDiscovery.ts` discovers valid local specs from project workflow directories.
5. `src/tools/WorkflowTool/createWorkflowCommand.ts` exposes workflow-backed prompt commands when `WORKFLOW_SCRIPTS` is enabled and valid definitions exist.
6. `src/tools/WorkflowTool/runWorkflow.ts` maps validated phases to the existing `Agent` tool.
7. `src/tools/WorkflowTool/runWorkflow.ts` can pass stable teammate names and `team_name` to the Agent tool for tmux-backed team execution.
8. `src/tools/WorkflowTool/WorkflowTool.ts` provides `list`, `show`, `dry-run`, `run`, `status`, `pause`, and `resume` actions.
9. `src/commands/workflows/workflows.ts` provides the local `/workflows` inspection, run, status, pause, and resume commands.
10. `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` stores typed phase and agent progress state.
11. Skip and retry controls update `LocalWorkflowTask` phase state after phase state is explicit.
12. `defaults.maxRetries` reruns failed agents inside a workflow run.
13. Workflow run input is captured in task state and included in status output.

Future runtime integration:

1. Running workflow UI exposes a richer visual progress panel.
2. Persistent saved workflow run templates make repeated execution easier.

Runtime implementation should preserve the current feature-gated import pattern. Do not introduce static imports that defeat dead-code elimination for workflow-only code.

## Implementation rule

Workflow execution must not directly call shell or filesystem operations. Workflow phases should spawn agents, and those agents must use normal Claude Code tools under existing permission and hook rules.
