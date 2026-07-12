# Detailed Workflow and Interactive Terminal Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the hidden bundled `workflow` and `interactive-terminal` skills so they teach model-side tool usage with enough detail to handle official-style workflow orchestration and persistent terminal sessions reliably.

**Architecture:** Keep both skills as hidden bundled prompt skills under `src/skills/bundled/` and do not change runtime behavior. Strengthen `modelInternalSkills.test.ts` so detailed model guidance becomes a regression-tested contract. Preserve `/workflows` as display/management UI only.

**Tech Stack:** TypeScript, existing bundled skill registry, Node `assert`, Bun test execution, Makefile build.

---

## File Structure

- Modify: `src/skills/bundled/modelInternalSkills.test.ts`
  - Expand assertions for detailed workflow and InteractiveTerminal guidance.
  - Preserve hidden/model-internal assertions.

- Modify: `src/skills/bundled/workflow.ts`
  - Replace the concise prompt with a detailed model-facing operating guide.
  - Keep `name: 'workflow'`, `userInvocable: false`, and existing trigger-oriented description/whenToUse.

- Modify: `src/skills/bundled/interactiveTerminal.ts`
  - Replace the concise prompt with a detailed model-facing operating guide.
  - Keep `name: 'interactive-terminal'`, `userInvocable: false`, and existing trigger-oriented description/whenToUse.

- Modify: `docs/superpowers/specs/2026-06-29-workflow-tool-parity-improvement-recommendations.md`
  - Record official Workflow AST meta parser, VM/runtime, and agent orchestration evidence for future parity work.

- Modify: `docs/superpowers/specs/2026-06-29-detailed-workflow-and-interactive-terminal-skills-design.md`
  - Make hidden skill requirements precise enough to cover official AST literal rules, constrained runtime boundaries, `parallel(thunks)`, nullable failed branches, and loop hard caps.

- Verify unchanged behavior: `src/commands/workflows/workflowsPage.behavior.test.ts`
  - Ensure `/workflows` still opens UI for all workflow-looking args.

---

### Task 1: Expand failing tests for detailed hidden skill guidance

**Files:**
- Modify: `src/skills/bundled/modelInternalSkills.test.ts`
- Test: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Update workflow prompt assertions**

In `src/skills/bundled/modelInternalSkills.test.ts`, replace the workflow prompt assertion block after `workflowText` is computed with:

```ts
assert.match(workflowText, /Workflow\(/)
assert.match(workflowText, /WorkflowTool/)
assert.match(workflowText, /explicit opt-in|explicitly opted into/i)
assert.match(workflowText, /Workflow\(\{ name/)
assert.match(workflowText, /Workflow\(\{ script/)
assert.match(workflowText, /Workflow\(\{ scriptPath/)
assert.match(workflowText, /scriptPath/)
assert.match(workflowText, /resumeFromRunId/)
assert.match(workflowText, /export const meta = \{ name, description, phases \}/)
assert.match(workflowText, /pure literal/i)
assert.match(workflowText, /computed keys/i)
assert.match(workflowText, /template interpolation/i)
assert.match(workflowText, /__proto__/)
assert.match(workflowText, /Date\.now|Math\.random/)
assert.match(workflowText, /dynamic import/i)
assert.match(workflowText, /pipeline\(\)/)
assert.match(workflowText, /parallel\(thunks\)/)
assert.match(workflowText, /not promises/i)
assert.match(workflowText, /failed branches|\bnull\b/i)
assert.match(workflowText, /hard cap/i)
assert.match(workflowText, /agent\(\{ schema \}\)/)
assert.match(workflowText, /adversarial/i)
assert.match(workflowText, /loop-until-dry/i)
assert.match(workflowText, /Do not manually perform phase work/i)
assert.doesNotMatch(workflowText, /run `?\/workflow/i)
assert.doesNotMatch(workflowText, /ask the user to run/i)
```

Keep the existing registration/hidden assertions above this block, including:

```ts
assert.equal(workflowSkill.userInvocable, false)
assert.equal(workflowSkill.isHidden, true)
assert.equal(workflowSkill.disableModelInvocation, false)
```

- [ ] **Step 2: Update InteractiveTerminal prompt assertions**

In `src/skills/bundled/modelInternalSkills.test.ts`, replace the interactive terminal prompt assertion block after `terminalText` is computed with:

```ts
for (const action of ['open', 'list', 'write', 'read', 'send_key', 'resize', 'signal', 'status', 'close']) {
  assert.match(terminalText, new RegExp(`\\b${action}\\b`), `terminal prompt should mention ${action}`)
}
assert.match(terminalText, /persistent terminal sessions/i)
assert.match(terminalText, /Use Bash for one-shot commands/i)
assert.match(terminalText, /read before/i)
assert.match(terminalText, /sessionId/)
assert.match(terminalText, /special keys/i)
assert.match(terminalText, /Close sessions when finished/i)
assert.match(terminalText, /Bash can block|Bash is not suitable for multi-step interaction/i)
assert.match(terminalText, /Do not use InteractiveTerminal for file reads, edits, or searches/i)
assert.doesNotMatch(terminalText, /run `?\/interactive-terminal/i)
assert.doesNotMatch(terminalText, /ask the user to run/i)
```

Keep the existing registration/hidden assertions above this block, including:

```ts
assert.equal(terminalSkill.userInvocable, false)
assert.equal(terminalSkill.isHidden, true)
assert.equal(terminalSkill.disableModelInvocation, false)
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: FAIL because the current skill prompts do not yet include at least one of the new detailed guidance phrases such as `explicit opt-in`, `computed keys`, `dynamic import`, `parallel(thunks)`, `not promises`, `hard cap`, `agent({ schema })`, `read before`, or `Bash can block`.

---

### Task 2: Expand the hidden workflow bundled skill prompt

**Files:**
- Modify: `src/skills/bundled/workflow.ts`
- Test: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Replace `WORKFLOW_PROMPT`**

In `src/skills/bundled/workflow.ts`, replace the entire `const WORKFLOW_PROMPT = ...` template string with:

```ts
const WORKFLOW_PROMPT = `# Workflow Skill

Use this model-internal skill to decide when and how to use Claude Code dynamic workflows.

## Core rule

Dynamic workflows are structured orchestration. Use Workflow for execution. Use WorkflowTool for inspection and control when it is available. Do not manually perform phase work in the main thread.

## Explicit opt-in requirement

Only execute Workflow when the user has explicitly opted into workflow-scale orchestration. Explicit opt-in includes:

- The user asks for dynamic workflow, workflow, ultracode-style orchestration, multi-agent orchestration, fan-out, broad audit, migration, deep research, or cross-checking.
- The user asks to run a named or saved workflow.
- A loaded skill or command instruction explicitly tells you to call Workflow.
- A system reminder says ultracode or dynamic workflow mode is active for the turn.

If a task merely could benefit from a workflow but the user did not opt in, do not silently call Workflow. Use normal tools or briefly explain what a workflow would do and ask before running one.

## Tool selection

Use Workflow for execution:

```ts
Workflow({ name: 'deep-research', args: userInput })
```

Use official-compatible inline scripts only when a saved workflow is not enough:

```ts
Workflow({ script, name, args })
```

Use persisted script paths for edits and resumes:

```ts
Workflow({ scriptPath, args, resumeFromRunId })
```

Use WorkflowTool for inspection and control when available:

- list: discover saved workflow specs.
- show: inspect metadata.
- dry-run: inspect the phase graph.
- status: inspect a workflow task.
- pause: pause a running workflow.
- resume: print the resume prompt for a paused workflow.
- run: execute a validated local spec when using the local WorkflowTool surface.

Do not treat /workflows text arguments as the launcher. /workflows is display and management UI.

## Script rules

Every inline or scriptPath workflow script must start with:

```js
export const meta = { name, description, phases }
```

The meta object must be a pure literal, matching official AST-parser expectations:

- Allowed values: string/number/boolean/null literals, arrays, plain objects, negative numeric literals, and template literals without expressions.
- Rejected values: variables, identifiers, function calls, spread, sparse arrays, computed keys, methods, accessors, template interpolation, TypeScript syntax, and reserved keys such as __proto__, constructor, and prototype.
- Required fields are non-empty string name and description.
- Use phases to preview progress groups; phase entries should use string title, and optional string detail/model.

The script body orchestrates agents with workflow runtime globals:

- agent(prompt, opts): spawn a subagent. Use agent({ schema }) when structured output is needed, and expect the subagent to return via the structured output tool rather than prose.
- pipeline(items, stage1, stage2, ...): run each item through all stages independently.
- parallel(thunks): run independent tasks concurrently and wait for all results. Pass thunks/functions, not promises.
- phase(title): group later agent calls under a progress phase.
- log(message): emit progress.
- args: user input passed to Workflow. Pass arrays/objects as real JSON values, not JSON-encoded strings.
- budget: token budget helper when available.
- workflow(nameOrRef, args): call a child workflow when available; avoid deep nesting.

Scripts orchestrate agents only. They must not directly perform shell or filesystem work. Agents perform the actual work under normal tool permissions and hooks.

Workflow scripts run in a constrained official-style JavaScript environment. Do not depend on Node filesystem or shell APIs, dynamic import, Date.now(), bare Date(), argless new Date(), Math.random(), eval, Function, WebAssembly, or deep child workflow nesting. Pass time, random seeds, and external data through args when needed.

## pipeline() vs parallel()

Default to pipeline() for multi-stage per-item work. It avoids unnecessary barriers because item A can advance while item B is still in an earlier stage.

Use parallel() as a barrier only when the next step genuinely needs all previous results together, such as deduping across all findings, comparing all candidates, or deciding whether the total count is zero.

parallel(thunks) expects an array of functions, not promises. Write () => agent(...) entries so the workflow runtime controls launch timing.

Failed branches or budget-limited branches can produce null results while preserving partial workflow progress. Synthesis stages must handle null or missing branch outputs.

Do not add a barrier just to flatten, map, filter, or make code look cleaner. Put simple transforms inside a pipeline stage.

## Loop and budget safety

Loop-until-dry patterns must include a hard cap such as max rounds or max new findings. budget.remaining() may be Infinity when no token budget is configured, so do not rely on it as the only loop bound.

## Quality patterns

Use these patterns when they fit the task:

- Adversarial verify: ask independent skeptics to refute each finding before accepting it.
- Perspective-diverse verify: use distinct lenses such as correctness, security, performance, and reproducibility.
- Judge panel: generate multiple independent approaches, score them, then synthesize the best parts.
- Loop-until-dry: keep discovering until consecutive rounds find nothing new, with an explicit hard cap.
- Multi-modal sweep: search by different modalities such as file structure, content, ownership, time, or runtime behavior.
- Completeness critic: run a final agent asking what evidence, modality, or verification is missing.
- No silent caps: if coverage is bounded or sampled, log what was skipped.

Scale to what the user asked for. A broad audit or migration deserves stronger fan-out and verification than a quick check.

## Resume and iteration

Workflow runs should expose a scriptPath and run id when supported. To iterate, edit the persisted script and call Workflow with scriptPath and resumeFromRunId. Completed unchanged agent calls should return cached results when the runtime supports resume.

Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector, name, or scriptPath exists. Reload by selector/scriptPath so validation, task state, permission previews, hooks, resume, and LocalWorkflowTask progress stay intact.

## Permission and execution boundaries

- Preserve normal tool permissions and hooks.
- Let workflow phases launch agents through the workflow runtime.
- Do not narrow child agents to the parent orchestration tool scope.
- Do not promote /workflow or /workflows run as user-facing command guidance.
- Do not manually perform phase work in the main thread.
`
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: FAIL only if the interactive-terminal prompt assertions are not yet satisfied. Workflow assertions should pass.

---

### Task 3: Expand the hidden InteractiveTerminal bundled skill prompt

**Files:**
- Modify: `src/skills/bundled/interactiveTerminal.ts`
- Test: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Replace `INTERACTIVE_TERMINAL_PROMPT`**

In `src/skills/bundled/interactiveTerminal.ts`, replace the entire `const INTERACTIVE_TERMINAL_PROMPT = ...` template string with:

```ts
const INTERACTIVE_TERMINAL_PROMPT = `# InteractiveTerminal Skill

Use this model-internal skill to decide when and how to use the InteractiveTerminal tool.

## Core rule

Use InteractiveTerminal for persistent terminal sessions. Use Bash for one-shot commands. Do not use InteractiveTerminal for file reads, edits, or searches; use Read, Edit, Write, Grep, or Glob instead.

## Use InteractiveTerminal for

- REPL sessions.
- TUI or curses-style programs.
- CLI programs that need multiple inputs over time.
- Processes where you must send special keys.
- Programs that depend on terminal size.
- Long-lived sessions where you need status, signals, or cleanup.
- Interactive verification of local CLI behavior.

## Do not use InteractiveTerminal for

Do not use InteractiveTerminal for file reads, edits, or searches. Use Read, Edit, Write, Grep, or Glob instead.

Use Bash for one-shot commands that simply run and exit. Bash is not suitable for multi-step interaction because Bash can block, lose interactive state, or fail to represent a real TTY/TUI screen.

## Lifecycle

1. open: create a session and capture the returned sessionId.
2. read: inspect the visible terminal screen before deciding what to type.
3. write: send normal text input.
4. send_key: send Enter, Tab, Escape, arrows, Ctrl+C, Ctrl+D, and other supported special keys.
5. resize: change rows and columns when layout matters.
6. status: check whether the process is still running before assuming it can receive input.
7. signal: send SIGINT or SIGTERM when the running process needs a signal.
8. list: enumerate unreaped sessions when you need to recover a sessionId.
9. close: Close sessions when finished.

## Operating guidance

- Always read before deciding what to type next.
- Use write for ordinary text and send_key for special keys.
- Do not embed control characters in write text when send_key can express the key.
- Track sessionId explicitly; losing it means losing control of the process.
- Use resize before interacting with layout-sensitive TUIs.
- Prefer read/status checks over arbitrary sleep loops.
- Use signal for interruption or termination instead of sending text that looks like a signal.
- Close sessions when finished.
- If a nested Claude session or complex TUI stalls, report the stall and avoid blind retries.

## Common failure modes without this skill

- Bash can block on a program that expects ongoing input.
- Bash is not suitable for multi-step interaction with changing screen state.
- TUI layout can break when the terminal size is wrong.
- Direction keys, Escape, Ctrl+C, and Ctrl+D can be misinterpreted if sent as plain text.
- Acting without a fresh read can target the wrong prompt, menu item, or focused control.
- Writing after the process exits silently fails or sends input to the wrong place.
- Forgetting close can leave sessions or child processes running.
`
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: PASS with:

```text
modelInternalSkills.test.ts passed
```

---

### Task 4: Preserve workflow UI-only boundary tests

**Files:**
- Test: `src/commands/workflows/workflowsPage.behavior.test.ts`
- Test: `src/commands/workflows/workflowsPage.test.ts`

- [ ] **Step 1: Run workflows behavior test**

Run:

```bash
bun src/commands/workflows/workflowsPage.behavior.test.ts
```

Expected: PASS with:

```text
workflowsPage.behavior.test.ts passed
```

This confirms workflow-looking args such as `list`, `show`, `dry-run`, `run`, `status`, `pause`, `resume`, `retry-agent`, and `skip-agent` still open the UI.

- [ ] **Step 2: Run workflows page smoke test**

Run:

```bash
bun src/commands/workflows/workflowsPage.test.ts
```

Expected: PASS with:

```text
workflowsPage.test.ts passed
```

---

### Task 5: Build verification

**Files:**
- Build: bundled CLI binary

- [ ] **Step 1: Run build**

Run:

```bash
make build
```

Expected: build completes and produces `./built-claude`.

If the build fails, read the first TypeScript/build error and fix only the root cause introduced by this prompt/test change.

---

### Task 6: Optional interactive smoke

**Files:**
- Runtime: `./built-claude`

- [ ] **Step 1: Open built CLI with InteractiveTerminal**

Use InteractiveTerminal:

```ts
InteractiveTerminal({
  action: 'open',
  command: '/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/built-claude',
  args: ['--dangerously-skip-permissions'],
  cwd: '/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code',
  rows: 30,
  cols: 120,
})
```

Expected: CLI opens and returns a `sessionId`.

- [ ] **Step 2: Verify workflow skill loading**

Send this prompt:

```text
我需要做大型代码库迁移审计，请使用 dynamic workflow / workflow orchestration 进行多代理交叉检查。不要实际执行审计，只说明你会调用什么结构化工具。
```

Expected: the model loads `Skill(workflow)` and describes `Workflow` / `WorkflowTool` structured usage without directly doing the audit.

- [ ] **Step 3: Verify InteractiveTerminal skill loading**

Send this prompt:

```text
我需要操作一个 REPL/TUI，会多次输入、发送方向键、读取屏幕并最后关闭会话。不要执行命令，只说明你会调用什么结构化工具和动作。
```

Expected: the model loads `Skill(interactive-terminal)` and describes the InteractiveTerminal lifecycle.

- [ ] **Step 4: Close the terminal session**

Use:

```ts
InteractiveTerminal({ action: 'close', sessionId, force: true })
```

Expected: session closes.

---

### Task 7: Documentation evidence hardening

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-workflow-tool-parity-improvement-recommendations.md`
- Modify: `docs/superpowers/specs/2026-06-29-detailed-workflow-and-interactive-terminal-skills-design.md`
- Modify: `docs/superpowers/plans/2026-06-29-detailed-workflow-and-interactive-terminal-skills.md`

- [ ] **Step 1: Verify recommendation spec includes official AST parser evidence**

Open `docs/superpowers/specs/2026-06-29-workflow-tool-parity-improvement-recommendations.md` and confirm section `Parser hardening` states all of these official-source facts:

```text
kZ parses the script as an ECMAScript module
first statement must be export const meta = object literal
meta is extracted by AST walking, not JavaScript evaluation
accepted: Literal, ArrayExpression, ObjectExpression, no-expression TemplateLiteral, negative-number UnaryExpression
rejected: sparse arrays, spread, computed keys, methods/accessors, template interpolation, non-literal nodes
reserved keys rejected: __proto__, constructor, prototype
meta.name and meta.description are required non-empty strings
phases keep title/detail/model string fields only
```

Expected: all facts are present. If any are missing, add them before continuing.

- [ ] **Step 2: Verify recommendation spec includes official VM/runtime evidence**

In the same file, confirm section `Workflow script VM/runtime parity` states all of these official-source facts:

```text
workflow body is compiled as vm.Script with filename workflow.js
dynamic import is disabled
codeGeneration strings and wasm are disabled
hardened globals delete WebAssembly, WeakRef, SharedArrayBuffer, queueMicrotask, readFile-like globals
constructors/prototypes are frozen
Math.random, Date.now, bare Date, and argless new Date are unavailable
host functions are wrapped across the VM boundary
values are cloned across the VM boundary
args is injected by JSON serialization/parsing
timers are tied to abort signal
child workflow nesting is limited
```

Expected: all facts are present. If any are missing, add them before continuing.

- [ ] **Step 3: Verify hidden skill design spec includes prompt requirements derived from official evidence**

Open `docs/superpowers/specs/2026-06-29-detailed-workflow-and-interactive-terminal-skills-design.md` and confirm the workflow skill requirements include:

```text
pure literal in the AST-parser sense
computed keys, spread, methods/accessors, template interpolation, TypeScript syntax, and reserved keys are rejected
scripts should not rely on Node globals, filesystem, shell, dynamic import, Date.now, Math.random, eval, Function, or WebAssembly
parallel(thunks) requires functions, not promises
pipeline is item-wise and should be default for multi-stage per-item work
failed branches may become null
loop-until-dry requires hard caps
agent({ schema }) returns structured output rather than prose
```

Expected: all requirements are present. If any are missing, add them before continuing.

- [ ] **Step 4: Verify this implementation plan tests the fragile guidance**

Open this plan and confirm Task 1 workflow assertions include:

```text
computed keys
template interpolation
__proto__
Date.now or Math.random
dynamic import
parallel(thunks)
not promises
failed branches or null
hard cap
agent({ schema })
```

Expected: all assertions are present so the plan will fail if future prompt edits become too vague.

---

### Task 8: Inspect diff and prepare handoff

**Files:**
- Inspect all changed files.

- [ ] **Step 1: Review git diff**

Run:

```bash
git diff -- src/skills/bundled/workflow.ts src/skills/bundled/interactiveTerminal.ts src/skills/bundled/modelInternalSkills.test.ts src/commands/workflows/workflowsPage.behavior.test.ts docs/architecture/workflow-orchestration.md docs/superpowers/specs/2026-06-29-workflow-tool-parity-improvement-recommendations.md docs/superpowers/specs/2026-06-29-detailed-workflow-and-interactive-terminal-skills-design.md docs/superpowers/plans/2026-06-29-detailed-workflow-and-interactive-terminal-skills.md
```

Expected: diff includes only detailed hidden skill prompt updates, focused tests, and docs/spec/plan additions.

- [ ] **Step 2: Confirm invariants**

Check the diff manually for these invariants:

```text
workflow skill: userInvocable: false
workflow skill: disableModelInvocation is not true
interactive-terminal skill: userInvocable: false
interactive-terminal skill: disableModelInvocation is not true
no user-facing /workflow docs
no user-facing /interactive-terminal docs
no /workflows list/show/dry-run/run routing
/workflows behavior tests still expect UI opening for args
```

- [ ] **Step 3: Do not commit unless explicitly asked**

Stop after reporting changed files and verification results. Do not create a git commit unless the user explicitly asks.

---

## Self-Review

Spec coverage:

- Detailed workflow skill prompt: Task 2.
- Detailed InteractiveTerminal skill prompt: Task 3.
- Hidden/model-internal invariants: Task 1 and Task 8.
- Official AST parser and VM/runtime evidence: Task 7.
- `/workflows` UI-only boundary: Task 4 and Task 8.
- Build verification: Task 5.
- Optional runtime smoke: Task 6.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation steps remain.
- Every changed prompt block is fully specified.
- Every verification command includes expected output.

Type consistency:

- Skill names remain `workflow` and `interactive-terminal`.
- Registration function names remain `registerWorkflowSkill` and `registerInteractiveTerminalSkill`.
- Test file remains `src/skills/bundled/modelInternalSkills.test.ts`.
