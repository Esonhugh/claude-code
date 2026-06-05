# Workflow Compatibility Experiments

This matrix compares Claude Code 2.1.150 dynamic workflows with this repository's workflow implementation.

## Official baseline observed

Sources: `https://code.claude.com/docs/en/workflows` and `https://claude.com/blog/introducing-dynamic-workflows-in-claude-code`.

- `/opt/homebrew/bin/claude --version`: `2.1.150 (Claude Code)`.
- Official docs say dynamic workflows require Claude Code v2.1.154 or later and are research preview.
- The installed 2.1.150 binary contains hidden workflow strings and bundled workflow definitions, but `claude -p --bare` did not expose the hidden `Workflow` tool in the init tool list.
- Secondary binary probes found embedded built-in workflow names: `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `deep-research`, `docs`, `investigate`, `plan-hunter`, and `review-branch`; `autopilot` appears in descriptive binary strings as an end-to-end task runner.
- Feature probes with `CLAUDE_CODE_WORKFLOWS`, `tengu_workflows_enabled`, and `CLAUDE_CODE_RECOVER_FEATURES=WORKFLOW_SCRIPTS` exposed some workflow-related slash command names only in this repository context, but did not expose the hidden `Workflow` tool for direct non-interactive use.
- Binary strings show official `Workflow` accepts a workflow name or `{ script, name, scriptPath }`, persists the script under the session directory, and returns `scriptPath` and `workflowRunId` for edit-and-resume flows.
- Binary strings and docs show official workflow runtime state includes `workflow_progress`, `workflow_agent`, `workflow_phase`, `workflow_log`, and `task_local_workflow*` events.
- Official runtime disallows `Date.now()`, `new Date()`, and `Math.random()` in scripts because they break resume.
- The official blog emphasizes long-running workflows that can run for hours or days, save progress, continue after interruptions, and iterate until build/test/review results converge.
- The blog examples emphasize independent solution attempts plus reviewers/refuters, including two-reviewer-per-file migration patterns and build/test repair loops.

## Experiment matrix

| ID | Scenario | Official expected behavior | Local current behavior | Compatibility risk |
| --- | --- | --- | --- | --- |
| W1 | Run bundled `/deep-research <question>` and other built-ins | Built-in workflows such as `deep-research`, `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `docs`, `investigate`, `plan-hunter`, and `review-branch` are embedded in the official binary and can become workflow commands when the preview surface is enabled | Local bundled registry restores clean-room equivalents for all observed official names: `autopilot`, `bugfix`, `bughunt`, `bughunt-lite`, `dashboard`, `deep-research`, `docs`, `investigate`, `plan-hunter`, and `review-branch`; metadata export/compare scripts track coverage | Aligned for bundled workflow name coverage; exact proprietary script bodies are not copied |
| W2 | Ask natural language `use a workflow` / `ultracode` | Claude writes a workflow script and asks approval before launching | No prompt-level ultracode trigger or automatic workflow authoring | Missing orchestration authoring mode |
| W3 | Invoke hidden `Workflow({ script, name })` | Runtime persists script, returns `scriptPath`/`workflowRunId`, executes script in background | Local `Workflow` facade accepts inline `{ script, name, args }`, persists the script, returns `workflowRunId`/`scriptPath`, and delegates phase work to the existing Agent runner | Aligned for practical facade semantics |
| W4 | Re-run with `Workflow({ scriptPath })` after editing script | Reads persisted script and resumes/re-runs without resending script | Local `Workflow` facade accepts `{ scriptPath, args, resumeFromRunId }`, loads the edited script path, and stores resume metadata in run session files | Aligned for edit-and-rerun; arbitrary JS continuation resume remains partial |
| W5 | Saved workflow command from `.claude/workflows/` | Saved script becomes slash command; project workflow shadows personal workflow with same name | Discovers user `~/.claude/workflows/`, project `docs/workflows/`, and project `.claude/workflows/`; project definitions shadow user definitions | Aligned for saved workflow discovery precedence |
| W6 | `args` passed to saved workflow | Global `args` may be structured data; omitted args are `undefined` | JS DSL accepts structured JSON-compatible args and parses JSON CLI strings into objects/arrays when possible | Aligned for JSON-compatible structured args |
| W7 | Arbitrary JS orchestration loop/branch | Script variables hold intermediate results; loops/branches can spawn many agents | JS files may export declarative `workflow(...)` or official-style async orchestration functions using deterministic helpers such as `agent`, `parallel`, `series`, `retry`, and `loopUntil` | Partial: helper-based orchestration exists, but not full arbitrary resumable JS continuation |
| W8 | Deterministic runtime guard | `Date.now()`, `new Date()`, `Math.random()` throw explicit errors | Implemented to throw matching deterministic-runtime errors | Aligned |
| W9 | Workflow script filesystem/shell access | Script itself has no direct FS/shell; agents perform tool work | VM context exposes no `process`/`require`; phase work goes through Agent tool | Mostly aligned, but in-process VM is weaker than process isolation |
| W10 | Concurrency/caps | Up to 16 concurrent agents, 1000 total agents per run | Defaults are much smaller (`maxConcurrency: 4`, `maxAgents: 32`) and configurable in spec | Different limits/defaults |
| W11 | Subagent permission mode | Official docs: spawned workflow agents run in acceptEdits and inherit allowlist | Local phases support per-phase `permissionMode` including `plan` | Permission behavior mismatch |
| W12 | `/workflows` progress UI | Interactive list/detail UI with phase/agent drilldown, pause/resume/stop/restart/save keys | Text status/detail panels show phase progress, recent official events, run identity, and textual controls for pause/resume/retry-agent/skip-agent | Partial UX match; not an interactive TUI drilldown |
| W13 | Stop/restart individual agent | UI key `x` stops selected agent, `r` restarts selected running agent | `/workflows skip-agent` and `/workflows retry-agent` expose textual controls backed by workflow task state helpers | Partial control match; no true running-process restart binding |
| W14 | Resume after pause in same session | Completed agents return cached results; remaining agents run live | Pause/resume toggles task state; no executor continuation loop for partially paused live run | Resume semantics incomplete |
| W15 | Cache/session outputs | Session directory under `~/.claude/projects/` stores persisted script and workflow progress events | Project `.claude/workflow-runs/<taskId>.json` stores run metadata and results | Cache location/schema mismatch |
| W16 | Agent teams/tmux | Workflows orchestrate subagents; teams are separate primitive. UI can show progress; split-pane teams are separate feature | Local team mode can route phase workers as named teammates through Agent/team path and tmux smoke exists | Useful extension, but not official workflow semantics |
| W17 | Long-running repair loop | Blog describes workflows that repeatedly build/test/fix until convergence | Local async JS orchestration helpers support bounded `retry` and `loopUntil` plan generation before phase execution | Partial: convergence plans exist, but live build/test/fix continuation remains static once planned |
| W18 | Independent attempts plus reviewers | Blog describes parallel implementers plus reviewers/refuters, e.g. two reviewers per generated file | Local helpers include `parallel`, `review`, `refute`, `synthesize`, and `vote`, mapping to review modes in the existing runner | Mostly aligned for first-class quality-pattern authoring |
| W19 | Automatic trigger with ultracode | Official ultracode lets Claude decide when a workflow is useful | Local requires explicit `/workflows`, generated prompt command, or `Workflow` facade invocation | Missing auto-orchestration mode |
| W20 | Hours/days interruption recovery | Official progress is saved and interrupted runs can continue | Local persists `workflowRunId`, `scriptPath`, args, events, metadata, and results, and supports scriptPath rerun with `resumeFromRunId` metadata | Partial: no arbitrary JS control-flow checkpoint continuation across process interruption |

## Suggested implementation priorities

1. Add a hidden-compatible `Workflow` tool facade accepting `{script, name, scriptPath, resumeFromRunId}` while keeping `WorkflowTool` as inspection/control surface.
2. Persist runnable workflow scripts under the Claude session directory shape used by official Claude Code, not only project `.claude/workflow-runs` metadata.
3. Add `scriptPath` edit-and-rerun behavior and expose `workflowRunId` in tool results.
4. Support global `args` as structured data, not only strings.
5. Implement arbitrary JS orchestration primitives (`agent`, `phase`, `pipeline`, logs/progress) instead of only declarative `workflow({ phases })` plans.
6. Add loop/convergence primitives for build/test/fix workflows and iterative review repair.
7. Add first-class reviewer/refuter/voting helpers for independent attempts plus adversarial validation.
8. Align default caps with official limits or document why local recovery defaults are lower.
7. Align spawned agent permission defaults with official `acceptEdits` semantics, or intentionally expose this as a safer local divergence.
8. Add user-level `~/.claude/workflows/` discovery with project workflow precedence.
9. Build an interactive `/workflows` detail view or a closer textual equivalent with phase/agent drilldown and restart/stop/save controls.
10. Mirror official progress event schema names (`workflow_progress`, `workflow_agent`, `workflow_phase`, `workflow_log`) in persisted run output for easier compatibility tooling.
