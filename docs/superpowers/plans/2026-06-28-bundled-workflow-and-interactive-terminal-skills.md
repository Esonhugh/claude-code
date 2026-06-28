# Bundled Workflow and Interactive Terminal Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hidden bundled teaching skills for workflow orchestration and InteractiveTerminal usage while keeping existing slash commands as display/management surfaces.

**Architecture:** Add two focused bundled skill modules under `src/skills/bundled/` and register them from the bundled skill initializer. Both skills are `userInvocable: false`, so they are model-internal and hidden from user slash command UI. No workflow runtime, InteractiveTerminal runtime, or `/workflows` command behavior changes are included.

**Tech Stack:** TypeScript, existing bundled skill registry, Node `assert`, Bun test execution.

---

## File Structure

- Create: `src/skills/bundled/workflow.ts`
  - Registers hidden bundled skill `workflow`.
  - Contains concise model-facing instructions for `Workflow` / `WorkflowTool` usage.
  - Does not expose a user-facing slash command.

- Create: `src/skills/bundled/interactiveTerminal.ts`
  - Registers hidden bundled skill `interactive-terminal`.
  - Contains concise model-facing instructions for `InteractiveTerminal` lifecycle and when to prefer it over `Bash`.
  - Does not expose a user-facing slash command.

- Modify: `src/skills/bundled/index.ts`
  - Import and register both new bundled skills.
  - Keep registration unconditional unless build constraints require feature gating; these are hidden teaching skills and should not affect visible command UI.

- Create: `src/skills/bundled/modelInternalSkills.test.ts`
  - Verifies both skills are registered, hidden, and model-internal.
  - Verifies workflow prompt contains the required structured runtime guidance.
  - Verifies interactive terminal prompt contains the required action/lifecycle guidance.

- Modify: `docs/dynamic-workflow-agent-orchestration.md`
  - Update current surface / runtime boundary to mention hidden workflow teaching skill.
  - Keep `/workflows` described as display/management UI, not a text command or launch command.

- Modify: `docs/superpowers/specs/2026-06-28-bundled-workflow-and-interactive-terminal-skills-design.md`
  - Only if implementation discovers a naming mismatch or testable detail that should be corrected.

---

### Task 1: Add failing tests for hidden bundled skills

**Files:**
- Create: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Write the failing registration and prompt tests**

Create `src/skills/bundled/modelInternalSkills.test.ts` with this content:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

import { initBundledSkills } from './index.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'

clearBundledSkills()
initBundledSkills()

const bundledSkills = getBundledSkills()

const workflowSkill = bundledSkills.find(skill => skill.name === 'workflow')
assert.ok(workflowSkill, 'workflow bundled skill should be registered')
assert.equal(workflowSkill.type, 'prompt')
assert.equal(workflowSkill.userInvocable, false)
assert.equal(workflowSkill.isHidden, true)
assert.match(workflowSkill.description, /^Use when/)
assert.match(workflowSkill.whenToUse ?? '', /dynamic workflow/i)
assert.match(workflowSkill.whenToUse ?? '', /multi-agent/i)

const workflowPrompt = await workflowSkill.getPromptForCommand('', {} as never)
const workflowText = workflowPrompt
  .map(block => (block.type === 'text' ? block.text : ''))
  .join('\n')

assert.match(workflowText, /Workflow\(/)
assert.match(workflowText, /WorkflowTool/)
assert.match(workflowText, /scriptPath/)
assert.match(workflowText, /resumeFromRunId/)
assert.match(workflowText, /export const meta = \{ name, description, phases \}/)
assert.match(workflowText, /Do not manually perform phase work/i)
assert.doesNotMatch(workflowText, /run `?\/workflow/i)
assert.doesNotMatch(workflowText, /ask the user to run/i)

const terminalSkill = bundledSkills.find(skill => skill.name === 'interactive-terminal')
assert.ok(terminalSkill, 'interactive-terminal bundled skill should be registered')
assert.equal(terminalSkill.type, 'prompt')
assert.equal(terminalSkill.userInvocable, false)
assert.equal(terminalSkill.isHidden, true)
assert.match(terminalSkill.description, /^Use when/)
assert.match(terminalSkill.whenToUse ?? '', /persistent/i)
assert.match(terminalSkill.whenToUse ?? '', /REPL/i)

const terminalPrompt = await terminalSkill.getPromptForCommand('', {} as never)
const terminalText = terminalPrompt
  .map(block => (block.type === 'text' ? block.text : ''))
  .join('\n')

for (const action of ['open', 'list', 'write', 'read', 'send_key', 'resize', 'signal', 'status', 'close']) {
  assert.match(terminalText, new RegExp(`\\b${action}\\b`), `terminal prompt should mention ${action}`)
}
assert.match(terminalText, /Use Bash for one-shot commands/i)
assert.match(terminalText, /Close sessions when finished/i)
assert.match(terminalText, /Do not use InteractiveTerminal for file reads, edits, or searches/i)
assert.doesNotMatch(terminalText, /run `?\/interactive-terminal/i)
assert.doesNotMatch(terminalText, /ask the user to run/i)

console.log('modelInternalSkills.test.ts passed')
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: FAIL because `workflow bundled skill should be registered` is not satisfied.

---

### Task 2: Implement hidden workflow bundled skill

**Files:**
- Create: `src/skills/bundled/workflow.ts`
- Modify: `src/skills/bundled/index.ts`
- Test: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Create the workflow skill module**

Create `src/skills/bundled/workflow.ts`:

```ts
import { registerBundledSkill } from '../bundledSkills.js'

const WORKFLOW_PROMPT = `# Workflow Skill

Use this model-internal skill to decide when and how to use Claude Code dynamic workflows.

## Core rule

Dynamic workflows are structured orchestration. Use the Workflow or WorkflowTool tools to run or inspect them. Do not manually perform phase work in the main thread.

## When to use Workflow

Use Workflow for large multi-agent work, deep research, broad codebase audits, migrations, cross-checking, fanout, synthesis, or when the user asks for dynamic workflow / workflow / ultracode-style orchestration.

Prefer saved workflows when one exists:

\`\`\`ts
Workflow({ name: 'deep-research', args: userInput })
\`\`\`

Use official-compatible inline scripts only when a saved workflow is not enough. Workflow scripts must start with:

\`\`\`js
export const meta = { name, description, phases }
\`\`\`

Then orchestrate with workflow runtime globals such as agent(), parallel(), pipeline(), phase(), and log(). Scripts orchestrate agents only; they must not directly perform shell or filesystem work.

Use persisted script paths for edits and resumes:

\`\`\`ts
Workflow({ scriptPath, args, resumeFromRunId })
\`\`\`

## When to use WorkflowTool

Use WorkflowTool for inspection and control when the tool is available:

- list: discover saved workflow specs
- show: inspect metadata
- dry-run: inspect the phase graph
- run: execute a validated workflow spec through the workflow runtime
- status: inspect a workflow task
- pause: pause a running workflow
- resume: print the resume prompt for a paused workflow

Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector, name, or scriptPath exists. Reload by selector/scriptPath so validation, task state, permission previews, hooks, resume, and LocalWorkflowTask progress stay intact.

## Permission and execution boundaries

- Preserve normal tool permissions and hooks.
- Let workflow phases launch agents through the workflow runtime.
- Do not narrow child agents to the parent orchestration tool scope.
- For long-running resumes, use the scriptPath and resumeFromRunId returned by prior workflow output.
`

export function registerWorkflowSkill(): void {
  registerBundledSkill({
    name: 'workflow',
    description:
      'Use when dynamic workflow, Workflow, ultracode-style orchestration, deep research, fanout, multi-agent cross-checking, migration, audit, or synthesis work is needed',
    whenToUse:
      'Use for dynamic workflow, Workflow, ultracode-style orchestration, deep research, fanout, multi-agent cross-checking, large codebase migration, broad audit, or synthesis tasks. Do not use for simple one-step tasks.',
    userInvocable: false,
    async getPromptForCommand() {
      return [{ type: 'text', text: WORKFLOW_PROMPT }]
    },
  })
}
```

- [ ] **Step 2: Register the workflow skill**

Modify `src/skills/bundled/index.ts` imports near the other bundled skill imports:

```ts
import { registerWorkflowSkill } from './workflow.js'
```

Then call it in `initBundledSkills()` after the always-registered core skills:

```ts
  registerWorkflowSkill()
```

Place it after `registerStuckSkill()` so the core skill block remains grouped:

```ts
  registerBatchSkill()
  registerStuckSkill()
  registerWorkflowSkill()
```

- [ ] **Step 3: Run the focused test to confirm the next failure**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: FAIL because `interactive-terminal bundled skill should be registered` is not satisfied. The workflow assertions should now pass.

---

### Task 3: Implement hidden InteractiveTerminal bundled skill

**Files:**
- Create: `src/skills/bundled/interactiveTerminal.ts`
- Modify: `src/skills/bundled/index.ts`
- Test: `src/skills/bundled/modelInternalSkills.test.ts`

- [ ] **Step 1: Create the InteractiveTerminal skill module**

Create `src/skills/bundled/interactiveTerminal.ts`:

```ts
import { registerBundledSkill } from '../bundledSkills.js'

const INTERACTIVE_TERMINAL_PROMPT = `# InteractiveTerminal Skill

Use this model-internal skill to decide when and how to use the InteractiveTerminal tool.

## Core rule

Use InteractiveTerminal for persistent terminal sessions. Use Bash for one-shot commands.

## Use InteractiveTerminal for

- REPL sessions
- TUI or curses-style programs
- CLI programs that need multiple inputs over time
- Processes where you must send special keys
- Programs that depend on terminal size
- Long-lived sessions where you need status, signals, or cleanup

## Do not use InteractiveTerminal for

Do not use InteractiveTerminal for file reads, edits, or searches. Use Read, Edit, Write, Grep, or Glob instead. For one-shot shell commands that simply run and exit, use Bash.

## Lifecycle

1. open: create a session and capture the returned sessionId.
2. read: inspect the visible terminal screen before deciding what to type.
3. write: send normal text input.
4. send_key: send Enter, Tab, Escape, arrows, Ctrl+C, Ctrl+D, and other supported special keys.
5. resize: change rows and columns when layout matters.
6. status: check whether the process is still running.
7. signal: send SIGINT or SIGTERM when the running process needs a signal.
8. list: enumerate unreaped sessions when you need to recover a sessionId.
9. close: close sessions when finished.

## Operating guidance

- Prefer read/status checks over arbitrary sleep loops.
- Use send_key for special keys instead of embedding control characters in write text.
- Keep track of sessionId explicitly.
- Close sessions when finished.
- If a nested Claude session stalls, report the stall and avoid blind retries.
`

export function registerInteractiveTerminalSkill(): void {
  registerBundledSkill({
    name: 'interactive-terminal',
    description:
      'Use when a persistent terminal, REPL, TUI, curses-style program, multi-step CLI session, special key input, resize, signal, status, or close lifecycle is needed',
    whenToUse:
      'Use for persistent terminal sessions, REPLs, TUIs, curses-style programs, multi-step CLI interaction, special keys, resize-sensitive programs, process status checks, signals, or terminal cleanup. Do not use for one-shot commands or file read/edit/search tasks.',
    userInvocable: false,
    async getPromptForCommand() {
      return [{ type: 'text', text: INTERACTIVE_TERMINAL_PROMPT }]
    },
  })
}
```

- [ ] **Step 2: Register the InteractiveTerminal skill**

Modify `src/skills/bundled/index.ts` imports:

```ts
import { registerInteractiveTerminalSkill } from './interactiveTerminal.js'
```

Call it immediately after `registerWorkflowSkill()`:

```ts
  registerWorkflowSkill()
  registerInteractiveTerminalSkill()
```

- [ ] **Step 3: Run focused test to verify both skills pass**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: PASS with:

```text
modelInternalSkills.test.ts passed
```

---

### Task 4: Preserve `/workflows` display-only behavior in tests

**Files:**
- Modify: `src/commands/workflows/workflowsPage.behavior.test.ts`
- Test: `src/commands/workflows/workflowsPage.behavior.test.ts`

- [ ] **Step 1: Expand the existing behavior test**

Modify `src/commands/workflows/workflowsPage.behavior.test.ts` so it explicitly asserts that all known workflow-looking args still open the UI:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  shouldOpenWorkflowsPageForArgs,
  workflowDialogDismissedMessage,
} from './workflowsMessages.js'

assert.equal(workflowDialogDismissedMessage, 'Dynamic workflows dialog dismissed')
assert.equal(shouldOpenWorkflowsPageForArgs(undefined), true)
assert.equal(shouldOpenWorkflowsPageForArgs(''), true)
assert.equal(shouldOpenWorkflowsPageForArgs('list'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('show compatibility-smoke'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('dry-run compatibility-smoke'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('run deep-research -- topic'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('templates'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('status workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('detail workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('pause workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('resume workflow-task-id'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('retry-agent workflow-task-id phase agent'), true)
assert.equal(shouldOpenWorkflowsPageForArgs('skip-agent workflow-task-id phase agent'), true)

console.log('workflowsPage.behavior.test.ts passed')
```

- [ ] **Step 2: Run the behavior test**

Run:

```bash
bun src/commands/workflows/workflowsPage.behavior.test.ts
```

Expected: PASS with:

```text
workflowsPage.behavior.test.ts passed
```

---

### Task 5: Update workflow documentation boundary

**Files:**
- Modify: `docs/dynamic-workflow-agent-orchestration.md`

- [ ] **Step 1: Update the primitive model section**

In `docs/dynamic-workflow-agent-orchestration.md`, update the `Skill` row in the primitive model table to clarify hidden bundled teaching skills. Replace the `Skill` row with:

```markdown
| Skill | Current Claude session following loaded instructions | Main session context while loaded | Reusable procedure, checklist, domain knowledge, or hidden bundled teaching for model-side tool usage |
```

- [ ] **Step 2: Add a local surface bullet for hidden teaching skills**

In the `Current workflow surface:` bullet list, add this bullet near the existing workflow command/tool bullets:

```markdown
- A hidden bundled `workflow` skill teaches the model when and how to call `Workflow` / `WorkflowTool`; it is not user-invocable and should not be promoted as a user-facing slash command.
```

- [ ] **Step 3: Clarify `/workflows` display boundary**

In the `Current workflow surface:` bullet list, ensure the `/workflows` bullet says this exact sentence:

```markdown
- `/workflows` is the Dynamic workflows display and management UI; it should not grow `list`, `show`, `dry-run`, `run`, or similar text-command semantics.
```

If an existing `/workflows` bullet conflicts, replace the conflicting sentence rather than adding a duplicate.

- [ ] **Step 4: Add InteractiveTerminal boundary note**

Add this short paragraph after the workflow surface list:

```markdown
InteractiveTerminal has its own hidden bundled teaching skill for model-side tool usage. The existing interactive terminal slash command remains a display/management surface; the teaching skill explains the `InteractiveTerminal` lifecycle and when to prefer it over `Bash`.
```

---

### Task 6: Run focused verification

**Files:**
- Test: `src/skills/bundled/modelInternalSkills.test.ts`
- Test: `src/commands/workflows/workflowsPage.behavior.test.ts`
- Test: `src/commands/workflows/workflowsPage.test.ts`

- [ ] **Step 1: Run bundled skill tests**

Run:

```bash
bun src/skills/bundled/modelInternalSkills.test.ts
```

Expected: PASS with:

```text
modelInternalSkills.test.ts passed
```

- [ ] **Step 2: Run workflows display behavior tests**

Run:

```bash
bun src/commands/workflows/workflowsPage.behavior.test.ts
```

Expected: PASS with:

```text
workflowsPage.behavior.test.ts passed
```

- [ ] **Step 3: Run workflows page module smoke test**

Run:

```bash
bun src/commands/workflows/workflowsPage.test.ts
```

Expected: PASS with:

```text
workflowsPage.test.ts passed
```

- [ ] **Step 4: Run TypeScript/build verification if required by touched files**

Because this change touches files included in the binary bundle, run the project build check:

```bash
make build
```

Expected: build completes and produces `./built-claude`.

If `make build` fails, read the first TypeScript/build error and fix only the root cause introduced by these changes.

---

### Task 7: Inspect diff and prepare handoff

**Files:**
- Inspect all changed files.

- [ ] **Step 1: Review git diff**

Run:

```bash
git diff -- src/skills/bundled/workflow.ts src/skills/bundled/interactiveTerminal.ts src/skills/bundled/index.ts src/skills/bundled/modelInternalSkills.test.ts src/commands/workflows/workflowsPage.behavior.test.ts docs/dynamic-workflow-agent-orchestration.md docs/superpowers/specs/2026-06-28-bundled-workflow-and-interactive-terminal-skills-design.md docs/superpowers/plans/2026-06-28-bundled-workflow-and-interactive-terminal-skills.md
```

Expected: diff only includes the hidden bundled skills, registration, focused tests, and documentation/plan updates.

- [ ] **Step 2: Confirm no accidental slash command exposure**

Check the diff manually for these invariants:

```text
workflow skill: userInvocable: false
interactive-terminal skill: userInvocable: false
no new /workflow user-facing command docs
no new /workflows list/show/dry-run/run routing
/workflows behavior tests still expect UI opening for args
```

- [ ] **Step 3: Do not commit unless the user explicitly asks**

Project instructions require user approval before commits. Stop after reporting changed files and verification results unless the user asks for a commit.

---

## Self-Review

Spec coverage:

- Hidden workflow skill: Task 2.
- Hidden InteractiveTerminal skill: Task 3.
- `/workflows` UI-only boundary: Task 4 and Task 5.
- Documentation update: Task 5.
- Tests and build verification: Task 1, Task 4, Task 6.
- No user-facing workflow skill promotion: Task 1 assertions and Task 7 invariants.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation steps remain.
- Each code-writing step includes exact file paths and code blocks.
- Each verification step includes exact `bun` or `make` commands and expected output.

Type consistency:

- Registration function names are `registerWorkflowSkill` and `registerInteractiveTerminalSkill` throughout.
- Skill names are `workflow` and `interactive-terminal` throughout.
- Both skills use existing `registerBundledSkill` fields: `name`, `description`, `whenToUse`, `userInvocable`, and `getPromptForCommand`.
