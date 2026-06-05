# Dynamic Workflow and Agent Orchestration

## Purpose

This document explains how Claude Code dynamic workflows relate to subagents, agent teams, skills, hooks, permissions, and worktrees, then maps those concepts onto this recovered codebase for secondary development.

Dynamic workflows should not be treated as another agent type. They are an orchestration layer: a script or validated spec owns phase ordering, fan-out, cross-checking, retry policy, and synthesis while agents perform the actual work through normal tool permissions.

## Primitive model

| Primitive | Coordinator | State location | Best use |
| --- | --- | --- | --- |
| Skill | Current Claude session following loaded instructions | Main session context while loaded | Reusable procedure, checklist, or domain knowledge |
| Subagent | Current Claude session | Subagent context, summarized back to caller | Focused research, review, or implementation that would flood main context |
| Agent view | User | Separate background sessions | Independent tasks the user wants to monitor manually |
| Agent team | Team lead Claude session | Shared task list and mailbox | Multi-session collaboration where workers need to coordinate |
| Dynamic workflow | Workflow script/runtime | Script variables and workflow task state | Large repeatable fan-out, cross-checking, audits, migrations, or multi-angle planning |
| Worktree | User or orchestration layer | Separate git checkout | Filesystem isolation for parallel edits |
| Hook | Claude Code runtime | Settings and hook process result | Deterministic policy, validation, notification, and guardrails |
| Permission | Claude Code runtime | Permission settings and prompts | Safety boundary for tool use |

## Official design intent

Dynamic workflows exist to move orchestration out of turn-by-turn Claude judgment and into a readable, repeatable script. That matters when a task requires more workers than a single conversation can coordinate, or when intermediate findings need to be cross-checked before they are trusted.

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
- `src/tools/WorkflowTool/validateWorkflowSpec.ts` rejects invalid workflow graphs before any worker can start.
- `src/tools/WorkflowTool/formatWorkflowDryRun.ts` formats the validated phase graph, fan-out, concurrency, review, permission, agent type, and model choices.
- `src/tools/WorkflowTool/workflowDiscovery.ts` discovers workflow specs from `docs/workflows/` and `.claude/workflows/` roots.
- `src/tools/WorkflowTool/createWorkflowCommand.ts` exposes valid workflow specs as workflow-backed prompt commands.
- `src/tools/WorkflowTool/runWorkflow.ts` executes validated phases through the `Agent` tool and records workflow task state.
- `src/tools/WorkflowTool/WorkflowTool.ts` exposes `list`, `show`, `dry-run`, and `run` actions.
- `src/commands/workflows/workflows.ts` implements `/workflows list`, `/workflows show`, `/workflows dry-run`, and `/workflows run`.
- `src/tasks.ts` conditionally registers `LocalWorkflowTask`.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` stores typed workflow phase and agent state plus kill, skip, retry, and retry-cleanup controls.

Current workflow surface:

- Workflow specs are discoverable, validated, dry-runnable, and executable through `WorkflowTool.run`.
- Workflow files can be declarative JSON or JavaScript DSL files ending in `.js` under `docs/workflows/` or `.claude/workflows/`.
- The JavaScript DSL currently exposes `workflow(...)`, `agent(...)`, and `args`; prompt functions are evaluated with the current workflow input for discovery-backed command, `/workflows run`, and `WorkflowTool.run` paths.
- JavaScript workflow plans carry explicit runtime metadata (`javascript-worker`, source path, isolated runtime flag) plus a run script snapshot for persisted run sessions.
- `/workflows` can list specs, show metadata, print dry-run plans, generate a run prompt with saved user input, save/list/reuse workflow run templates, and inspect/control workflow task status.
- Workflow-backed prompt commands reload JavaScript workflow files with the current command arguments before formatting the orchestration prompt.
- `WorkflowTool.run` executes phase work through the existing `Agent` tool, records `LocalWorkflowTask` phase state, and does not directly use shell or filesystem tools.
- `WorkflowTool.run` can launch phase workers as named teammates through the existing Agent/team path when `defaults.execution` is `team` and a team context exists, which lets tmux-backed teams provide an interactive pane experience.
- `scripts/workflow-tmux-e2e-smoke.mjs` creates a tmux workflow session, leader pane, named worker panes, and a captured transcript proving team-mode workflow interaction reaches tmux panes.
- `defaults.maxRetries` controls automatic retry scheduling for failed phase agents.
- Workflow task status renders a compact progress panel with overall progress, per-phase progress bars, retry count, token count, tool-use count, elapsed time, saved user input, execution mode, and team/tmux details when available.
- `pauseWorkflowTask()` and `resumeWorkflowTask()` provide workflow-level pause/resume state transitions exposed through `WorkflowTool` and `/workflows`.
- `killWorkflowTask()`, `skipWorkflowAgent()`, and `retryWorkflowAgent()` update workflow task state for the runtime.

Official compatibility boundary:

- This branch now supports a JavaScript DSL compatibility layer that converts a JS workflow declaration into the existing validated `WorkflowSpec` plan.
- It is not yet a full official JavaScript workflow runtime where arbitrary orchestration code owns loops, branches, persistent script variables, and resumable run state.
- The DSL runs in a constrained in-process VM context and intentionally exposes no shell or filesystem helpers; phase work still goes through normal Agent tool permission boundaries.

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
