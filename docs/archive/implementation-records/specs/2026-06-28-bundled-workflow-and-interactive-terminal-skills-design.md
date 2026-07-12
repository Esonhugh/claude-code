# Bundled workflow and interactive terminal skills design

- Date: 2026-06-28
- Status: draft for review
- Scope: bundled skills that teach model-side tool usage for dynamic workflows and interactive terminal sessions

## Goals

Add two bundled skills that help the model choose and use existing structured tools correctly:

1. A model-internal workflow teaching skill that explains when and how to use `Workflow` / `WorkflowTool` without exposing a user-facing slash command.
2. A model-internal interactive terminal teaching skill that explains when and how to use `InteractiveTerminal` instead of `Bash` for persistent terminal sessions.

The skills should improve model behavior without changing the workflow runtime, `InteractiveTerminal` runtime, or `/workflows` UI command semantics.

## Non-goals

- Do not add `list`, `show`, `dry-run`, `run`, or similar subcommand semantics to `/workflows`.
- Do not make the workflow skill user-invocable.
- Do not proactively tell users to run a workflow skill slash command.
- Do not replace `Workflow`, `WorkflowTool`, `runWorkflowPlan`, `runWorkflowScript`, or `LocalWorkflowTask` with prompt-only orchestration.
- Do not make the interactive terminal skill user-invocable.
- Do not change `InteractiveTerminal` action schemas or PTY behavior.
- Do not add new dependencies.

## Current evidence

Source-confirmed:

- `/workflows` is currently registered as a `local-jsx` command and opens the workflows UI through `src/commands/workflows/index.ts` and `src/commands/workflows/workflowsPage.tsx`.
- `Workflow` facade accepts saved workflow names, inline scripts, script paths, and direct plans in `src/tools/WorkflowTool/WorkflowFacadeTool.ts`.
- `WorkflowTool` supports inspection and execution actions in `src/tools/WorkflowTool/WorkflowTool.ts`.
- `runWorkflowScript` executes official-style workflow scripts with `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, resume cache, and `LocalWorkflowTask` recording in `src/tools/WorkflowTool/workflowScriptRuntime.ts`.
- `InteractiveTerminal` is already a single action-based tool with `open`, `list`, `write`, `read`, `send_key`, `resize`, `signal`, `status`, and `close` in `src/tools/InteractiveTerminalTool/prompt.ts` and `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`.
- Bundled skills can be hidden from users via `userInvocable: false`; `registerBundledSkill` maps that to `isHidden` in `src/skills/bundledSkills.ts`.

Binary-observed:

- `./official-claude` strings include `WorkflowTool`, `getWorkflowCommands`, `createWorkflowCommand`, `Workflow({scriptPath`, `resumeFromRunId`, `export const meta`, `parallel()`, `pipeline()`, and `/workflows to view dynamic workflow runs`.
- These strings support keeping `/workflows` as a workflow run display/management surface while using `Workflow` as the execution primitive.

Runtime-observed:

- Local `/workflows list` currently opens the Dynamic workflows UI, confirming `/workflows` is display-oriented in the current branch.
- Official interactive tmux verification was inconclusive because the local `./official-claude` binary did not render or respond in the test pane during this session; do not base implementation on that failed run.

## Design

### 1. Model-internal workflow skill

Create a bundled skill module, for example `src/skills/bundled/workflow.ts`, registered from `src/skills/bundled/index.ts`.

Registration requirements:

- `name`: `workflow`.
- `userInvocable: false` so it is hidden from slash command UI and cannot be directly invoked by users.
- `description`: start with `Use when...` and describe trigger conditions only, not the workflow process.
- `whenToUse`: cover large multi-agent tasks, deep research, broad codebase audits, migrations, cross-checking, and requests that mention workflows or ultracode-style orchestration.
- `allowedTools`: no special expansion unless needed; the skill should teach calls to existing tools rather than bypass permissions.

Prompt content should teach:

- Prefer `Workflow({ name, args })` for saved/bundled workflows.
- Use `Workflow({ script, name, args })` or `Workflow({ scriptPath, args, resumeFromRunId })` for official-compatible script workflows.
- Use `WorkflowTool({ action: "list" | "show" | "dry-run" | "status" | "pause" | "resume", ... })` for runtime inspection and control when the tool is available.
- Do not manually perform phase work in the main thread.
- Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector or script path exists.
- Workflow scripts must start with `export const meta = { name, description, phases }` when using inline/script-path mode.
- Workflow scripts orchestrate agents only; they must not directly do shell or filesystem work.
- Preserve tool permissions, hooks, and normal `Agent` boundaries.
- For long-running workflow resumes, use `scriptPath` and `resumeFromRunId` from prior workflow output.

The skill must not include user-facing language such as “ask the user to run `/workflow`”. Since the skill is model-internal, it should describe what the assistant should do after it is invoked by model-side skill selection.

### 2. Interactive terminal skill

Create a bundled skill module, for example `src/skills/bundled/interactiveTerminal.ts`, registered from `src/skills/bundled/index.ts`.

Registration requirements:

- `userInvocable: false` so it is hidden from slash command UI and cannot be directly invoked by users.
- Keep the existing interactive terminal slash command as the display/management entry point only.
- The skill exists so the model can understand `InteractiveTerminal` principles, lifecycle, and correct tool usage.

Prompt content should teach:

- Use `InteractiveTerminal` for persistent CLI, REPL, TUI, curses-style, and multi-step terminal sessions.
- Use `Bash` for one-shot commands that do not require persistent state.
- Use dedicated tools instead of terminal commands for file reads, edits, searches, and globbing.
- Standard sequence: `open` → `read` → `write` / `send_key` → `read` / `status` → `close`.
- Use `send_key` for special keys and signals rather than embedding control characters in text.
- Use `resize` when the program depends on terminal dimensions.
- Use `status` before assuming a process is still running.
- Close sessions when finished.
- Avoid arbitrary sleep loops; wait by reading/status checks or by allowing background completion notifications where applicable.

### 3. `/workflows` stays UI-only

Keep `/workflows` as the Dynamic workflows display command.

Implementation must not add new text-mode workflow management or execution semantics to `/workflows`. Existing implementation details can remain, but this feature should not expand them. If cleanup is needed later, prefer reducing `/workflows` toward UI-only rather than adding subcommands.

### 4. Documentation updates

Update workflow docs that still describe script runtime as missing or future work. The docs should state the current boundary:

- Workflow execution uses structured runtime tools and `LocalWorkflowTask` state.
- Official-compatible script runtime exists locally for `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, and resume cache.
- `/workflows` is the UI display surface.
- The workflow bundled skill is model-internal teaching, not a user-visible command.

## Testing plan

### Unit tests

Add or update tests for bundled skill registration:

- Initializing bundled skills registers the workflow teaching skill.
- The workflow teaching skill has `userInvocable: false` and is hidden.
- The workflow skill prompt contains `Workflow(`, `WorkflowTool`, `scriptPath`, `resumeFromRunId`, and the rule not to manually perform phase work.
- The interactive terminal teaching skill has `userInvocable: false` and is hidden.
- The interactive terminal skill prompt contains the action names `open`, `write`, `read`, `send_key`, `resize`, `signal`, `status`, and `close`.
- `/workflows` behavior tests continue to assert display UI behavior for args if intentionally preserved.

### Manual verification

After implementation:

1. Run focused tests for bundled skills and workflows command behavior.
2. Run typecheck or the project’s relevant build command if touched files participate in the binary bundle.
3. Optionally run local CLI smoke only if the change affects command registration or visible command lists.

## Risks and mitigations

- Risk: A hidden workflow skill is not discoverable by the model.
  - Mitigation: Use a strong `description` and `whenToUse` with concrete triggers: dynamic workflow, Workflow, ultracode, deep research, fanout, cross-check, multi-agent orchestration.

- Risk: Skill prompt encourages prompt-only orchestration.
  - Mitigation: Explicitly require `Workflow` / `WorkflowTool` and forbid main-thread phase work.

- Risk: Users see or try to invoke the workflow skill.
  - Mitigation: Set `userInvocable: false`; do not mention a slash command in user-facing docs.

- Risk: `/workflows` accidentally grows into a mixed UI/command surface.
  - Mitigation: Keep this spec’s non-goal explicit and preserve tests around UI-only behavior.

## Decisions

- Hidden workflow skill name: `workflow`.
- Workflow skill is model-internal only and must not be promoted as a user-facing slash command.
- Interactive terminal skill is model-internal only.
- Existing workflow and interactive terminal slash command surfaces remain display/management entries, not teaching or execution skill entries.
