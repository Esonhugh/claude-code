# Detailed workflow and interactive terminal skills design

- Date: 2026-06-29
- Status: draft for implementation planning
- Scope: improve hidden bundled teaching skills for model-side `Workflow`, `WorkflowTool`, and `InteractiveTerminal` usage

## Problem

The current hidden bundled skills are intentionally concise, but they are not detailed enough to reliably teach the model how to handle complex workflow orchestration or persistent terminal interaction.

Runtime verification showed the model does load `Skill(workflow)` and `Skill(interactive-terminal)` for matching prompts, but the loaded content should carry more of the official behavior and failure-mode guidance.

## Goals

1. Expand the hidden `workflow` bundled skill so it teaches official-style workflow usage clearly enough for the model to choose safe structured orchestration.
2. Expand the hidden `interactive-terminal` bundled skill so it teaches robust persistent terminal lifecycle handling and common failure modes.
3. Keep both skills model-internal:
   - `userInvocable: false`
   - `disableModelInvocation: false`
   - `isHidden: true`
4. Preserve `/workflows` as display/management UI only.
5. Add tests that fail if the skills lose the critical detailed guidance.

## Non-goals

- Do not expose `/workflow` or `/interactive-terminal` user-facing skill commands.
- Do not proactively tell users to invoke these hidden skills.
- Do not change `InteractiveTerminal` tool schema or PTY implementation.
- Do not change `/workflows` routing to text subcommands.
- Do not implement official `Workflow` structured output parity in this skill-detailing pass.
- Do not add parser dependencies or remote workflow launch support in this pass.

## Design

### 1. Detailed hidden workflow skill

File: `src/skills/bundled/workflow.ts`

The prompt should be expanded from a short teaching note into a compact but complete model-side operating guide.

Required sections:

1. Core rule
   - Dynamic workflows are structured orchestration.
   - Use `Workflow` for execution.
   - Use `WorkflowTool` for inspection/control when available.
   - Do not manually perform workflow phase work in the main thread.

2. Explicit opt-in
   - Only execute `Workflow` when the user explicitly asks for workflow, dynamic workflow, multi-agent orchestration, fan-out, ultracode-style orchestration, deep research, broad audit, migration, or a named workflow.
   - If a task merely could benefit from workflow but the user did not opt in, use normal tools or explain and ask before running a workflow.

3. Tool selection
   - `Workflow({ name, args })` for saved workflows.
   - `Workflow({ script, name, args })` for official-compatible inline scripts.
   - `Workflow({ scriptPath, args, resumeFromRunId })` for iteration/resume.
   - `WorkflowTool({ action: "list" | "show" | "dry-run" | "status" | "pause" | "resume" })` for inspection/control.
   - `WorkflowTool({ action: "run", selector, runArgs })` remains acceptable for local validated specs when using that surface, but do not treat `/workflows` text args as the launcher.

4. Script rules
   - Inline scripts must start with `export const meta = { name, description, phases }`.
   - `meta` must be a pure literal in the official AST-parser sense:
     - allowed values: string/number/boolean/null literals, arrays, plain objects, negative numeric literals, and no-expression template literals;
     - rejected constructs: identifiers, function calls, spread, sparse arrays, computed keys, methods, accessors, template interpolation, TypeScript syntax, and reserved keys `__proto__`, `constructor`, `prototype`.
   - `meta.name` and `meta.description` must be non-empty strings.
   - Optional `meta.phases` entries should be objects with string `title`, and optional string `detail` / `model`.
   - Script body uses `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, and child `workflow()` if available.
   - Scripts orchestrate agents only; no direct shell/filesystem work.
   - Scripts should not rely on Node globals, filesystem, shell, dynamic `import()`, random numbers, current time, or deep child workflow nesting.
   - Use actual JSON values in `args`, not JSON-encoded strings.

5. `pipeline()` vs `parallel()` guidance
   - Default to `pipeline()` for multi-stage per-item work.
   - `pipeline(items, ...stages)` should be taught as item-wise progression: each item advances independently through all stages.
   - Use `parallel()` barriers only when a later stage needs all prior results together.
   - `parallel(thunks)` should be taught as requiring an array of functions, not already-started promises.
   - Avoid barriers for simple flatten/map/filter transforms.
   - Teach synthesis stages to handle `null` branch results because failed budget-limited branches can preserve partial workflow results instead of failing the whole workflow.

6. Runtime boundaries and resume-aware behavior
   - Agent calls are the unit of cached resume. Completed unchanged `agent()` calls may be reused when resuming with `scriptPath` and `resumeFromRunId`.
   - Agent loops must include explicit hard caps; `budget.remaining()` may be infinite when no token budget exists.
   - `agent({ schema })` means the subagent must return structured output through the schema tool, not ordinary prose.
   - `phase()` and `log()` should be used for progress visibility.
   - The prompt should not imply that workflows can directly use local filesystem, shell, Node APIs, randomness, current time, or dynamic import.

7. Quality patterns
   - adversarial verify,
   - perspective-diverse verify,
   - judge panel,
   - loop-until-dry,
   - multi-modal sweep,
   - completeness critic,
   - no silent caps.

8. Resume and iteration
   - Every run should return or expose `scriptPath` and run ID when supported.
   - Edit persisted script and rerun with `scriptPath` and `resumeFromRunId`.
   - Completed unchanged agents should use cached results when runtime supports resume.

9. Boundaries
   - Preserve permissions and hooks.
   - Let workflow phases launch agents through workflow runtime.
   - Do not narrow child agents to parent orchestration tool scope.
   - Do not promote `/workflow` or `/workflows run` as user command guidance.

### 2. Detailed hidden interactive terminal skill

File: `src/skills/bundled/interactiveTerminal.ts`

The prompt should be expanded into a robust model-side guide for persistent terminal sessions.

Required sections:

1. Core rule
   - Use `InteractiveTerminal` for persistent interactive sessions.
   - Use `Bash` for one-shot commands.
   - Use dedicated file tools for file reads, edits, writes, searches, and globs.

2. When to use
   - REPLs,
   - TUIs/curses programs,
   - CLI programs needing multiple inputs,
   - special keys,
   - terminal-size-sensitive programs,
   - long-lived processes needing status/signal/cleanup,
   - interactive verification of local CLI behavior.

3. Lifecycle
   - `open`: start and capture `sessionId`.
   - `read`: inspect visible screen before acting.
   - `write`: send normal text.
   - `send_key`: send Enter, Tab, Escape, arrows, Ctrl+C, Ctrl+D.
   - `resize`: adjust layout.
   - `status`: verify running/exited state.
   - `signal`: send SIGINT/SIGTERM when needed.
   - `list`: recover unreaped sessions.
   - `close`: cleanup when finished.

4. Operating rules
   - Always read before deciding what to type next.
   - Use `send_key` for special keys instead of control characters in text.
   - Track `sessionId` explicitly.
   - Prefer `read`/`status` checks over sleep loops.
   - Close sessions when finished.
   - If nested Claude or a complex TUI stalls, report the stall and avoid blind retries.

5. Failure modes without the skill
   - Bash can block and cannot preserve multi-step interaction reliably.
   - TUI layout can break without real PTY dimensions.
   - Direction keys/Escape/Ctrl+C encoded as text can be misinterpreted.
   - Acting without a fresh `read` can target the wrong menu/focus.
   - Lost `sessionId` loses control of the process.
   - Missing `status` writes to exited process.
   - Missing `close` leaves sessions or child processes around.

### 3. Tests

Update `src/skills/bundled/modelInternalSkills.test.ts` to assert that both skills include the detailed guidance.

Workflow assertions should include:

- `explicitly opted into` or `explicit opt-in`.
- `Workflow({ name`.
- `Workflow({ script`.
- `Workflow({ scriptPath`.
- `resumeFromRunId`.
- `export const meta`.
- `pure literal`.
- `computed keys`.
- `template interpolation`.
- `__proto__`.
- `Date.now` or `Math.random`.
- `dynamic import`.
- `parallel(thunks)`.
- `not promises`.
- `pipeline()`.
- `failed branches` or `null`.
- `hard cap`.
- `agent({ schema })`.
- `adversarial`.
- `loop-until-dry`.
- `Do not manually perform phase work`.
- No `run /workflow` or `ask the user to run` language.

Interactive terminal assertions should include:

- `persistent terminal sessions`.
- `Use Bash for one-shot commands`.
- all actions: `open`, `list`, `write`, `read`, `send_key`, `resize`, `signal`, `status`, `close`.
- `read before`.
- `sessionId`.
- `special keys`.
- `Close sessions when finished`.
- `Bash can block` or `Bash is not suitable for multi-step interaction`.
- `Do not use InteractiveTerminal for file reads, edits, or searches`.
- No `run /interactive-terminal` or `ask the user to run` language.

### 4. Verification

Run:

- `bun src/skills/bundled/modelInternalSkills.test.ts`
- `bun src/commands/workflows/workflowsPage.behavior.test.ts`
- `bun src/commands/workflows/workflowsPage.test.ts`
- `make build`

Optionally run an interactive smoke with `InteractiveTerminal` and `./built-claude --dangerously-skip-permissions` to verify the model still loads both skills for matching prompts.

## Risks

- Overly long skill prompts can add context cost. Keep them detailed but concise.
- If the workflow skill says too much about `WorkflowTool.run`, the model may overuse the local management tool instead of `Workflow`. Word tool selection carefully.
- If the interactive terminal skill overgeneralizes, the model may use `InteractiveTerminal` for one-shot commands. Keep Bash boundary explicit.

## Decisions

- Expand hidden skills first; do not change runtime behavior in the same pass.
- Preserve `/workflows` UI-only behavior.
- Treat official structured output, AST parser, policy gates, and per-workflow permission as separate parity work.
