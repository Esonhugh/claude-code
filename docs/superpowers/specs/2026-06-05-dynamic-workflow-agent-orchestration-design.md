# Claude Code Dynamic Workflow and Agent Orchestration Design

## Goal

Design a secondary-development roadmap for understanding and rebuilding Claude Code dynamic workflows and agent orchestration in this recovered codebase.

This spec is not an immediate implementation of the full workflow runtime. It defines the mental model, current repository gap, target architecture, staged delivery path, and verification gates needed before runtime work begins.

## Source Research Summary

Official Claude Code documentation frames agent orchestration as several separate primitives, each with a different coordination model.

- **Skills** are reusable procedures and knowledge bundles. They describe how Claude should perform a recurring workflow, but they do not run parallel workers by themselves.
- **Subagents** are delegated workers inside one Claude Code session. They preserve the main context window by doing focused research, review, or implementation in their own context and returning a summary.
- **Agent view** is a monitoring surface for separate background sessions that the user dispatches and checks later.
- **Agent teams** are coordinated multi-session groups. A lead session creates teammates, maintains a shared task list, and lets teammates message each other directly.
- **Dynamic workflows** move orchestration into a JavaScript script. The script holds the phases, branching, loops, intermediate state, and cross-checking logic while agents execute the actual work.
- **Worktrees** isolate file edits across parallel sessions, but they are not a coordination mechanism.
- **Hooks and permissions** define deterministic safety and policy boundaries around autonomous work.

Official workflow design intent:

1. Move the plan out of turn-by-turn Claude judgment and into a readable script.
2. Keep intermediate results in script variables instead of flooding the main conversation context.
3. Support larger parallel fan-out than a normal conversation can coordinate.
4. Make orchestration reusable by saving successful workflows as commands.
5. Improve quality by supporting cross-check, adversarial review, and multi-angle synthesis patterns.

Official constraints that must shape implementation:

- A workflow script coordinates agents; it should not directly access shell or filesystem primitives.
- Mid-run user input is not available. Human approval points must be modeled as separate workflow runs or pre-run approvals.
- The workflow runtime should bound concurrency and total agent count.
- Workflow agents must inherit the normal permission and tool boundaries instead of bypassing them.
- Costs scale with spawned agents, so specs must define fan-out, retry, and review limits.

Primary sources:

- `https://code.claude.com/docs/en/workflows`
- `https://code.claude.com/docs/en/agents`
- `https://code.claude.com/docs/en/sub-agents`
- `https://code.claude.com/docs/en/agent-teams`
- `https://code.claude.com/docs/en/skills`
- `https://code.claude.com/docs/en/hooks-guide`
- `https://code.claude.com/docs/en/permissions`

## Current Repository State

This repository has strong foundations for agent orchestration and now has a usable workflow inspection and execution layer. It supports declarative JSON workflow files and a JavaScript DSL compatibility layer, while the full official JavaScript workflow runtime remains future work.

Existing foundations:

- `src/commands.ts` uses feature-gated command loading. `WORKFLOW_SCRIPTS` controls loading of the workflow command entry.
- `src/tools.ts` uses feature-gated tool loading. `WORKFLOW_SCRIPTS` controls loading of `WorkflowTool` and bundled workflow initialization.
- `src/tools/AgentTool/AgentTool.tsx` is the existing worker-spawn primitive that future executable workflow phases should reuse.
- `src/tools/TeamCreateTool/TeamCreateTool.ts`, `src/tools/TeamDeleteTool/TeamDeleteTool.ts`, and `src/tools/SendMessageTool/SendMessageTool.ts` provide the team and mailbox primitives for collaborative sessions.
- `src/tools/TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, and `TaskListTool` already provide shared task-list coordination.
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts` is an important orchestration event point because task state changes can trigger hooks and teammate notifications.
- `src/tasks.ts` already conditionally includes `LocalWorkflowTask` when `WORKFLOW_SCRIPTS` is enabled.

Implemented workflow surface:

- `src/tools/WorkflowTool/workflowSpec.ts` defines the declarative workflow spec and dry-run plan types.
- `src/tools/WorkflowTool/workflowDsl.ts` loads `.js` workflow files through a constrained DSL context with `workflow(...)`, `agent(...)`, and `args`.
- `src/tools/WorkflowTool/validateWorkflowSpec.ts` validates phase IDs, dependencies, cycles, fan-out, concurrency, review modes, permission modes, retry count, execution mode, and agent budgets.
- `src/tools/WorkflowTool/formatWorkflowDryRun.ts` formats the validated phase graph and execution budget.
- `src/tools/WorkflowTool/workflowDiscovery.ts` discovers JSON and JavaScript workflow specs from project workflow directories.
- `src/commands/workflows/workflows.ts` implements `/workflows list`, `/workflows show`, `/workflows dry-run`, `/workflows run`, `/workflows status`, `/workflows pause`, and `/workflows resume`.
- `src/tools/WorkflowTool/createWorkflowCommand.ts` exposes valid workflow specs as workflow-backed prompt commands and reloads JavaScript workflows with the current command arguments.
- `src/tools/WorkflowTool/WorkflowTool.ts` exposes inspection actions plus `run`, `status`, `pause`, and `resume`.
- `src/tools/WorkflowTool/runWorkflow.ts` maps validated phases to the existing `Agent` tool and records `LocalWorkflowTask` progress.
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` stores typed phase, agent, retry, token, tool-use, pause/resume, skip, and run-argument state.

Official compatibility boundary:

- Current JavaScript support is a DSL-to-plan bridge, not a full official JavaScript workflow runtime.
- The supported JS shape is declarative: scripts return `workflow({ phases: [agent(...)] })`, and prompt functions may use `args`.
- The not-yet-implemented official runtime shape would let JavaScript orchestration code own arbitrary loops, branches, persistent variables, isolated worker/process execution, and resumable script sessions.

This means secondary development should continue in stages: the current runtime is usable for validated phase graphs, and the next major step is richer official-style JavaScript runtime semantics plus visual/recovery polish.

## Design Principles

### 1. Preserve primitive boundaries

Dynamic workflow is the orchestration layer. It should coordinate existing primitives instead of replacing them.

- Workflow script or spec owns phase order, dependencies, fan-out, retry, and synthesis.
- Agents own actual tool use.
- Task state owns progress reporting.
- Permissions and hooks own safety policy.
- Worktrees own filesystem isolation when file edits must happen in parallel.

### 2. Start with inspectable specifications before execution

The first deliverable should be a workflow specification and dry-run surface. The system should be able to discover, validate, and explain a workflow before it can run one.

This avoids rebuilding a large autonomous runtime before the team agrees on:

- workflow file format
- phase semantics
- agent selection
- output shape
- review mode
- permission model
- cost controls
- failure behavior

### 3. Make workflow execution explicitly staged

The final runtime should be DAG-like but implemented incrementally.

A workflow contains phases. A phase may spawn one or more agents. Later phases may depend on outputs from earlier phases. Review phases can cross-check prior results before synthesis.

### 4. Never bypass permission boundaries

The workflow itself must not become a privileged path to shell, filesystem, MCP, or web operations. Agents spawned by workflow phases should go through the same tool permission system as normal subagents.

### 5. Design for recovery and cancellation from the start

Even a minimal runner must expose task state that can be stopped safely. Later versions can add pause, resume, skip-agent, and retry-agent behavior.

## Target Conceptual Model

A secondary-development workflow should eventually have this shape:

```ts
export type WorkflowSpec = {
  name: string
  description: string
  input?: WorkflowInputSpec
  defaults?: WorkflowDefaults
  phases: WorkflowPhaseSpec[]
}

export type WorkflowPhaseSpec = {
  id: string
  description: string
  prompt: string
  agentType?: string
  model?: string
  dependsOn?: string[]
  fanout?: number
  concurrency?: number
  review?: 'none' | 'cross-check' | 'adversarial' | 'synthesis'
  output?: WorkflowOutputSpec
}

export type WorkflowDefaults = {
  maxConcurrency: number
  maxAgents: number
  permissionMode: 'default' | 'acceptEdits' | 'plan'
}
```

The concrete format can be JSON, YAML, TypeScript, or JavaScript. The first implementation should prefer a declarative JSON/YAML-compatible shape because it is easier to validate, dry-run, and document. A later implementation can allow executable JavaScript workflows once the runtime boundary is well understood.

## Proposed Staged Roadmap

### Phase 0: Architecture documentation

Create a durable architecture document explaining the official primitives and the local recovered codebase state.

Deliverables:

- A document that compares skills, subagents, agent view, agent teams, worktrees, hooks, permissions, and dynamic workflows.
- A repository map of current local extension points.
- A decision record that full runtime restoration is deferred until dry-run and DSL design are complete.

Success criteria:

- A new contributor can explain why dynamic workflow is different from subagents and agent teams.
- A new contributor can point to the local files where workflow support would be restored.
- The document contains no claims that the current workflow runtime is complete.

### Phase 1: Workflow spec format and dry-run design

Define a workflow spec format and a dry-run command behavior.

Deliverables:

- A documented `WorkflowSpec` schema.
- Validation rules for phase IDs, dependency references, fan-out limits, concurrency limits, and review modes.
- A dry-run output format that explains what agents would run, in what order, with which dependencies.

Success criteria:

- Workflow definitions can be reviewed without executing agents.
- Invalid phase graphs fail before any worker starts.
- Cost and concurrency estimates are visible before execution.

### Phase 2: Local command discovery and dry-run prototype

Restore the smallest useful workflow command surface without executing workflows. This phase is implemented for validated dry-run inspection and workflow-backed prompt commands.

Implemented behavior:

- `/workflows list` lists discovered workflow specs and reports invalid specs.
- `/workflows show <name-or-path>` displays workflow metadata and phase ordering.
- `/workflows dry-run <name-or-path>` validates a workflow and prints the planned phases.
- `WorkflowTool` provides read-only `list`, `show`, and `dry-run` actions.
- `getWorkflowCommands(cwd)` returns workflow-backed prompt commands only when valid definitions exist.

Success criteria:

- Build succeeds with `WORKFLOW_SCRIPTS` enabled.
- External builds do not accidentally include unavailable ant-only bundled workflow code.
- CLI workflow smoke tests prove list/show/dry-run and workflow-backed prompt command recognition.

### Phase 3: Minimal workflow execution runtime

Implement the first runner using existing agent primitives.

Required constraints:

- The runner maps each executable phase to `AgentTool` work.
- The runner stores progress in `LocalWorkflowTaskState`.
- The runner enforces max concurrency and max agent count.
- The runner does not call shell or filesystem APIs directly for workflow work.
- Agents inherit normal tool permissions and prompt constraints.

Success criteria:

- A two-phase research workflow can run locally.
- A failed phase marks workflow state as failed without orphaning active agents.
- Stopping a workflow updates `LocalWorkflowTask` state and stops or detaches active workers according to the documented policy.

### Phase 4: Cross-check and adversarial review

Add the quality pattern that makes workflows more valuable than simple fan-out.

Deliverables:

- Independent research phase.
- Cross-check phase where agents verify or challenge claims from prior agents.
- Synthesis phase that reports only claims that survived review.
- Optional voting or confidence metadata.

Success criteria:

- The workflow can distinguish raw findings from verified findings.
- The synthesis report cites which agent outputs support each claim.
- Failed or disputed claims are either removed or labeled clearly.

### Phase 5: Workflow UI, recovery, and saved commands

Add operational polish after the core runner works.

Deliverables:

- `/workflows` progress view.
- Pause, resume, stop, skip-agent, and retry-agent controls.
- Saved workflow command support with structured args.
- Token and elapsed-time reporting.

Success criteria:

- Users can inspect a running workflow without reading raw task state.
- Users can stop a bad workflow without corrupting the session.
- Saved workflows can be rerun with different args.

## Non-goals

- Do not implement the full dynamic workflow runtime in the first development pass.
- Do not make workflows a privileged path around permissions.
- Do not make agent teams depend on workflows or workflows depend on agent teams.
- Do not introduce nested teams from workflow-spawned agents.
- Do not require workflow execution for normal skills or slash commands.
- Do not move all planning into workflows; small tasks should remain normal Claude Code sessions or subagent dispatches.

## Open Design Decisions

These decisions should be resolved before Phase 2 implementation:

1. Workflow definition format: JSON/YAML-like declarative schema first, or executable JavaScript first.
2. Workflow discovery locations: project `.claude/workflows/`, user `~/.claude/workflows/`, plugin workflows, or all three.
3. Dry-run command syntax: reuse `/workflows`, create workflow-backed slash commands, or expose both.
4. State persistence: keep workflow state only in AppState for the first prototype, or persist resumable state to session files.
5. Agent spawning API: call the existing `AgentTool` path directly, or introduce a small workflow runner adapter around it.
6. Review semantics: whether `cross-check` is a built-in phase mode or an explicit phase template.

## Verification Strategy

Documentation and dry-run phases:

```bash
git diff --check
pnpm exec tsc --noEmit --pretty false
pnpm build
node ./dist/cli.js --help
```

Prototype phases:

```bash
pnpm lint
pnpm audit:missing
pnpm exec tsc --noEmit --pretty false
pnpm build
node ./dist/cli.js --help
```

Workflow-specific verification once a dry-run command exists:

```bash
node ./dist/cli.js --help | grep -i workflow
node ./dist/cli.js workflows --help
node ./dist/cli.js workflows dry-run <fixture-workflow-name>
```

Workflow execution verification once a runner exists:

- Run a one-phase read-only research workflow.
- Run a two-phase research plus synthesis workflow.
- Run a deliberately invalid dependency graph and verify it fails before spawning agents.
- Run a workflow with `maxAgents` lower than requested fan-out and verify it is rejected.
- Stop a running workflow and verify task state becomes killed.
- Retry a failed workflow agent only after retry support is implemented.

## Risks

### Feature-gate and dead-code elimination risk

`WORKFLOW_SCRIPTS` is currently used to guard workflow imports. A careless static import could pull unavailable or internal-only code into external builds.

Mitigation: keep workflow runtime imports behind feature-gated dynamic require patterns until the build strategy is understood.

### Permission bypass risk

A workflow runner could accidentally become a direct executor for shell or filesystem operations.

Mitigation: workflow phases should spawn agents and let agents use tools through normal permission checks.

### State complexity risk

`LocalWorkflowTaskState` is currently minimal. Adding full phase/agent/retry state too early could make the task model hard to reason about.

Mitigation: phase state should be introduced incrementally and typed explicitly.

### Cost explosion risk

Dynamic workflows can spawn many agents. Without limits, a bad spec could consume excessive tokens.

Mitigation: require max concurrency, max agents, dry-run estimates, and explicit review modes before execution.

### UX ambiguity risk

Users may confuse subagents, teams, and workflows.

Mitigation: docs and command help should explain which primitive coordinates the work, where state lives, and when to choose another primitive.

## Implemented Scope and Next Runtime Scope

The implementation delivered:

1. Architecture documentation.
2. Workflow spec schema and normalization.
3. JavaScript DSL loading for `.js` workflow declarations with `workflow(...)`, `agent(...)`, and `args`.
4. JavaScript workflow runtime metadata, isolated VM evidence, source-path tracking, and run script snapshots.
5. Validation for dependency graphs, budgets, review modes, permission modes, retry count, execution mode, and agent budgets.
5. Dry-run formatting.
6. Local fixture workflow examples.
7. `/workflows` list/show/dry-run/run/status/pause/resume commands.
8. Workflow-backed prompt commands generated from valid specs.
9. A `WorkflowTool` inspection and execution surface.
10. Typed `LocalWorkflowTask` phase, agent, retry, skip, pause/resume, token, tool-use, run-argument, execution-mode, and team-name state.
11. A runner adapter that maps validated phases to `AgentTool` work.
12. Stop/failure handling that marks workflow state without directly performing phase work in the main thread.
13. A compact progress panel with overall and per-phase progress bars, retries, tokens, tool uses, elapsed time, input, execution mode, and tmux-backed team details.
14. Project-persistent workflow run templates saved in `.claude/workflow-run-templates.json`.
15. Project-persistent workflow run session files saved in `.claude/workflow-runs/<taskId>.json` with runtime metadata, args, script snapshot, status, and results.
16. `scripts/workflow-tmux-e2e-smoke.mjs`, which captures a tmux leader/worker transcript for team-mode workflow interaction.
17. Workflow-specific tests and CLI smoke verification.

The next implementation pass should focus on deeper official JavaScript workflow runtime semantics:

1. Cross-process JavaScript worker isolation beyond the current constrained VM boundary.
2. Native JavaScript orchestration loops and branches beyond the declarative DSL-to-plan bridge.
3. More advanced resume semantics that continue partially completed JavaScript control flow rather than reusing persisted plan/session metadata.
