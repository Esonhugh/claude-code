# Workflow Ultracode UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce accidental workflow fan-out, make workflow child-agent lifecycle/errors easier to understand, and align ultracode UX with focused vs workflow-scale task shape.

**Architecture:** Keep the existing architecture: workflow scripts continue to launch normal `AgentTool` subagents, and `LocalWorkflowTask` remains the state owner for workflow progress. Make small source-tested changes: soften prompt text, align the `Workflow` facade guard, gate PromptInput notification by settings, classify workflow child-agent errors, and add child-agent status summaries without replacing current TS state.

**Tech Stack:** TypeScript, React Ink, Bun tests, existing `WorkflowTool`, `WorkflowFacadeTool`, `LocalWorkflowTask`, `PromptInput`, and ultracode attachment/message utilities.

---

## File Structure

- Modify: `src/utils/messages.ts`
  - Owns conversion of ultracode-related attachments (`workflow_keyword_request`, `ultra_effort_enter`, `ultra_effort_exit`) into model-visible system reminder text.
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
  - Owns action-based workflow tool prompt and opt-in guidance.
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
  - Owns concise `Workflow` execution facade prompt. It must not be weaker than `WorkflowTool` on avoid-workflow guard semantics.
- Modify: `src/utils/ultracodeOrchestration.test.ts`
  - Existing string-level test for ultracode reminder text. Update it to enforce softened semantics.
- Modify: `src/tools/WorkflowTool/WorkflowTool.test.ts`
  - Existing prompt test. Add guard assertions.
- Create: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`
  - Focused test for facade prompt guard, if no equivalent test exists.
- Modify: `src/components/PromptInput/PromptInput.tsx`
  - Gate ultracode keyword notification by `settings.ultracodeKeywordTrigger`.
- Modify or create focused test near existing PromptInput tests
  - If an existing `PromptInput` test file exists, extend it; otherwise extract a tiny pure helper and test it in `src/utils/ultracodeOrchestration.test.ts`.
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
  - Add `WorkflowAgentErrorKind`, optional `errorKind`, and a small summary helper if it fits existing file style.
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
  - Classify workflow child-agent failures and pass `errorKind` into failure result.
- Modify: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
  - Show child-agent status summary and explain concurrency-limit failures.
- Modify or create: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts`
  - Test summary formatting for paused/failed/concurrency-limit states.
- Modify: `docs/superpowers/specs/2026-07-05-workflow-ultracode-orchestration-ux-design.md`
  - Already updated by this planning pass; keep it as the design source.

## Task 1: Soften ultracode model-visible reminders

**Files:**
- Modify: `src/utils/messages.ts`
- Modify: `src/utils/ultracodeOrchestration.test.ts`

- [ ] **Step 1: Write failing assertions for softened reminder semantics**

Edit `src/utils/ultracodeOrchestration.test.ts` and replace the current old-string assertions for `workflow_keyword_request` / `ultra_effort_enter` / sparse reminder with assertions equivalent to:

```ts
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  findUltracodeTriggerPositions,
  getUltracodeNotificationText,
  hasUltracodeKeyword,
  shouldInjectUltracodeOrchestration,
} from './ultracodeOrchestration.js'

describe('ultracode orchestration', () => {
  it('detects standalone ultracode keyword but not questions or flag-like strings', () => {
    expect(hasUltracodeKeyword('please ultracode this migration')).toBe(true)
    expect(hasUltracodeKeyword('what is ultracode?')).toBe(false)
    expect(hasUltracodeKeyword('--ultracode')).toBe(false)
    expect(hasUltracodeKeyword('/ultracode')).toBe(false)
    expect(hasUltracodeKeyword('ultracode.foo')).toBe(false)
    expect(findUltracodeTriggerPositions('use ultracode now')).toEqual([4])
  })

  it('injects orchestration helper only for ultracode effort', () => {
    expect(shouldInjectUltracodeOrchestration('ultracode')).toBe(true)
    expect(shouldInjectUltracodeOrchestration('high')).toBe(false)
  })

  it('keeps the UI notification concise', () => {
    expect(getUltracodeNotificationText()).toBe(
      'Dynamic workflow requested for this turn · opt+w to ignore',
    )
  })

  it('uses softened model-visible reminders for ultracode', () => {
    const messagesSource = readFileSync(
      join(import.meta.dir, 'messages.ts'),
      'utf8',
    )

    expect(messagesSource).toContain('deeper verification')
    expect(messagesSource).toContain('workflow-scale orchestration')
    expect(messagesSource).toContain('For focused tasks')
    expect(messagesSource).toContain('do not call Workflow')

    expect(messagesSource).not.toContain(
      'use the Workflow tool to fulfill the request',
    )
    expect(messagesSource).not.toContain(
      'Use the Workflow tool on every substantive task',
    )
    expect(messagesSource).not.toContain(
      'Ultracode is still on — use the Workflow tool',
    )
  })
})
```

If the existing test has additional cases, preserve them and only replace the old prompt-string assertions.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
```

Expected: FAIL because `src/utils/messages.ts` still contains old strings such as `use the Workflow tool to fulfill the request` and `Use the Workflow tool on every substantive task`.

- [ ] **Step 3: Update ultracode reminder text in `messages.ts`**

In `src/utils/messages.ts`, locate the attachment rendering branches for:

- `workflow_keyword_request`
- `ultra_effort_enter`
- `ultra_effort_exit`

Change only the text content. Use these exact replacement semantics:

```ts
// workflow_keyword_request reminder text
'The user included the keyword "ultracode", opting this turn into deeper verification and, when the task warrants it, workflow-scale orchestration. Use Workflow only for broad/fan-out work; for focused tasks, use direct tools or a small number of subagents. If the user asks to avoid workflows, do not call Workflow.'
```

```ts
// ultra_effort_enter full reminder text
'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Prefer Workflow for broad, workflow-scale tasks such as audits, migrations, deep research, cross-checking, or independent fan-out. For focused tasks, use direct tools or a small number of subagents. Do not run Workflow when the user asks to avoid workflow orchestration.'
```

```ts
// ultra_effort_enter sparse reminder text
'Ultracode is still on — use deeper verification; prefer Workflow only for workflow-scale tasks and respect requests to avoid workflows.'
```

Keep `ultra_effort_exit` behavior unless the current text references obsolete semantics. If changed, use:

```ts
'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.'
```

Do not change attachment names, throttling behavior, or effort mapping in this task.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit this task**

```sh
git add src/utils/messages.ts src/utils/ultracodeOrchestration.test.ts
git commit -m "fix: soften ultracode workflow reminders"
```

## Task 2: Align WorkflowTool and WorkflowFacadeTool prompt guards

**Files:**
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.test.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- Create or modify: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`

- [ ] **Step 1: Add failing WorkflowTool prompt assertions**

In `src/tools/WorkflowTool/WorkflowTool.test.ts`, extend the existing prompt test to assert all of these strings appear:

```ts
expect(prompt).toContain('Prefer WorkflowTool for broad, workflow-scale orchestration')
expect(prompt).toContain('For focused tasks, use direct tools or a small number of subagents')
expect(prompt).toContain('Do not run WorkflowTool when the user asks to avoid workflow orchestration')
expect(prompt).not.toContain('prefer this tool on every substantive task')
```

Use the actual local variable name for the generated prompt. If the test currently calls `WorkflowTool.prompt()` inline, assign it first:

```ts
const prompt = await WorkflowTool.prompt({} as never)
```

Follow the existing test helper pattern in the file rather than introducing new test setup.

- [ ] **Step 2: Add failing WorkflowFacadeTool prompt test**

If `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts` does not exist, create it with:

```ts
import { describe, expect, it } from 'bun:test'
import { WorkflowFacadeTool } from './WorkflowFacadeTool.js'

describe('WorkflowFacadeTool prompt', () => {
  it('contains focused-task and avoid-workflow guards', async () => {
    const prompt = await WorkflowFacadeTool.prompt({} as never)

    expect(prompt).toContain('workflow-scale orchestration')
    expect(prompt).toContain('For focused tasks')
    expect(prompt).toContain('do not call this tool')
    expect(prompt).toContain('avoid workflow')
    expect(prompt).not.toContain('every substantive task')
  })
})
```

If a facade test already exists, add the same assertions to that file.

- [ ] **Step 3: Run focused prompt tests and verify failure**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: FAIL because prompt text still contains old ultracode semantics or lacks facade guard text.

- [ ] **Step 4: Update `WorkflowTool` prompt text**

In `src/tools/WorkflowTool/WorkflowTool.ts`, update the `## Ultracode` section to:

```md
## Ultracode

When ultracode is on for a turn (effort=ultracode or the ultracode keyword), optimize for the most exhaustive, correct answer, not the fastest or cheapest. Prefer WorkflowTool for broad, workflow-scale orchestration such as audits, migrations, deep research, cross-checking, or independent fan-out. For focused tasks, use direct tools or a small number of subagents. Do not run WorkflowTool when the user asks to avoid workflow orchestration. Solo-execute on conversational/trivial turns.
```

In the explicit opt-in section, keep the existing opt-in examples but ensure the text says that ultracode permits workflow-scale orchestration when warranted, not that every substantive task must use WorkflowTool.

- [ ] **Step 5: Update `WorkflowFacadeTool` prompt text**

In `src/tools/WorkflowTool/WorkflowFacadeTool.ts`, add this guard paragraph to the prompt returned by `prompt()`:

```md
Use this facade only for workflow-scale orchestration or when the user explicitly asks to run a workflow/script/plan. For focused tasks, use direct tools or a small number of subagents instead. If the user asks to avoid workflow orchestration, do not call this tool.
```

Keep existing execution-surface wording for saved workflow name, `{ script, name }`, `{ scriptPath }`, and `{ plan }`.

- [ ] **Step 6: Run prompt tests and verify pass**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit this task**

```sh
git add src/tools/WorkflowTool/WorkflowTool.ts src/tools/WorkflowTool/WorkflowTool.test.ts src/tools/WorkflowTool/WorkflowFacadeTool.ts src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
git commit -m "fix: align workflow prompt guards"
```

## Task 3: Gate PromptInput ultracode notification by setting

**Files:**
- Modify: `src/components/PromptInput/PromptInput.tsx`
- Modify: `src/utils/ultracodeOrchestration.ts`
- Modify: `src/utils/ultracodeOrchestration.test.ts`

- [ ] **Step 1: Add a pure helper test for notification gating**

In `src/utils/ultracodeOrchestration.test.ts`, import the new helper before it exists:

```ts
import {
  findUltracodeTriggerPositions,
  getUltracodeNotificationText,
  getUltracodeNotificationTriggerPositions,
  hasUltracodeKeyword,
  shouldInjectUltracodeOrchestration,
} from './ultracodeOrchestration.js'
```

Add this test:

```ts
it('gates notification trigger positions by ultracode keyword setting', () => {
  expect(
    getUltracodeNotificationTriggerPositions('please ultracode this', {}),
  ).toEqual([7])

  expect(
    getUltracodeNotificationTriggerPositions('please ultracode this', {
      ultracodeKeywordTrigger: true,
    }),
  ).toEqual([7])

  expect(
    getUltracodeNotificationTriggerPositions('please ultracode this', {
      ultracodeKeywordTrigger: false,
    }),
  ).toEqual([])

  expect(
    getUltracodeNotificationTriggerPositions('what is ultracode?', {}),
  ).toEqual([])
})
```

If the local settings type is available, use it. Otherwise type the second parameter structurally in implementation.

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
```

Expected: FAIL because `getUltracodeNotificationTriggerPositions` is not exported.

- [ ] **Step 3: Implement helper in `ultracodeOrchestration.ts`**

Add this export near `isUltracodeKeywordTriggerEnabled`:

```ts
export function getUltracodeNotificationTriggerPositions(
  text: string,
  settings: { ultracodeKeywordTrigger?: boolean } | undefined,
): number[] {
  if (!isUltracodeKeywordTriggerEnabled(settings)) return []
  return findUltracodeTriggerPositions(text)
}
```

Keep `findUltracodeTriggerPositions` unchanged.

- [ ] **Step 4: Use helper in `PromptInput.tsx`**

In `src/components/PromptInput/PromptInput.tsx`, replace the direct call:

```ts
const ultracodeTriggers = findUltracodeTriggerPositions(displayedValue)
```

with:

```ts
const ultracodeTriggers = getUltracodeNotificationTriggerPositions(
  displayedValue,
  settings,
)
```

Also update the import from `src/utils/ultracodeOrchestration.js` to include `getUltracodeNotificationTriggerPositions`. Use the existing local `settings` source in the component; if the component uses `appState.settings`, pass that exact object instead.

- [ ] **Step 5: Run focused tests and typecheck affected files**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
bunx tsc --noEmit
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 6: Commit this task**

```sh
git add src/utils/ultracodeOrchestration.ts src/utils/ultracodeOrchestration.test.ts src/components/PromptInput/PromptInput.tsx
git commit -m "fix: gate ultracode notification by setting"
```

## Task 4: Classify workflow child-agent failures

**Files:**
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- Modify or create: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`

- [ ] **Step 1: Add unit test for error classifier**

In `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`, add an import for `classifyWorkflowAgentError` from `./workflowScriptRuntime.js` and add:

```ts
describe('classifyWorkflowAgentError', () => {
  it('classifies concurrency-limit failures', () => {
    expect(
      classifyWorkflowAgentError(
        new Error('Concurrency limit exceeded for user: fake-user'),
      ),
    ).toBe('concurrency_limit')
  })

  it('classifies stalled failures', () => {
    expect(classifyWorkflowAgentError(new Error('agent stalled after 60s'))).toBe(
      'stalled',
    )
  })

  it('classifies permission failures', () => {
    expect(classifyWorkflowAgentError(new Error('permission denied'))).toBe(
      'permission_denied',
    )
  })

  it('falls back to agent_failed', () => {
    expect(classifyWorkflowAgentError(new Error('unexpected model error'))).toBe(
      'agent_failed',
    )
  })
})
```

Use the existing `describe` import style in the file.

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
```

Expected: FAIL because `classifyWorkflowAgentError` is not exported.

- [ ] **Step 3: Add types in `LocalWorkflowTask.ts`**

In `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`, add near `WorkflowAgentResult`:

```ts
export type WorkflowAgentErrorKind =
  | 'concurrency_limit'
  | 'stalled'
  | 'permission_denied'
  | 'agent_failed'
```

Add optional field to `WorkflowAgentResult`:

```ts
errorKind?: WorkflowAgentErrorKind
```

Do not change existing `status` values in this task.

- [ ] **Step 4: Implement classifier in `workflowScriptRuntime.ts`**

In `src/tools/WorkflowTool/workflowScriptRuntime.ts`, import the type:

```ts
import type { WorkflowAgentErrorKind } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
```

Add:

```ts
export function classifyWorkflowAgentError(
  error: unknown,
): WorkflowAgentErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/Concurrency limit exceeded for user/i.test(message)) {
    return 'concurrency_limit'
  }
  if (/stalled/i.test(message)) {
    return 'stalled'
  }
  if (/permission denied|not allowed|denied by permission/i.test(message)) {
    return 'permission_denied'
  }
  return 'agent_failed'
}
```

- [ ] **Step 5: Pass `errorKind` into workflow agent failure results**

In `workflowScriptRuntime.ts`, find the catch path around child `agentTool.call(...)` failure. Where the code currently records a failed workflow agent result, compute:

```ts
const errorKind = classifyWorkflowAgentError(error)
```

Pass `errorKind` into the result object sent to `failWorkflowAgent(...)` or equivalent result creation:

```ts
{
  status: 'failed',
  error: error instanceof Error ? error.message : String(error),
  errorKind,
  // preserve all existing fields
}
```

Keep existing special handling for stalled failures if present, but ensure stalled failures also get `errorKind: 'stalled'`.

- [ ] **Step 6: Run focused runtime test**

Run:

```sh
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit this task**

```sh
git add src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts src/tools/WorkflowTool/workflowScriptRuntime.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts
git commit -m "fix: classify workflow agent failures"
```

## Task 5: Add workflow child-agent summary formatting

**Files:**
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- Modify: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
- Modify or create: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts`

- [ ] **Step 1: Add failing summary helper tests**

In `src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts`, add tests following the existing state factory pattern. If no state factory exists, create a local minimal state object matching `LocalWorkflowTaskState` fields used by `formatWorkflowStatus`.

Add a test equivalent to:

```ts
import { describe, expect, it } from 'bun:test'
import { formatWorkflowStatus } from './formatWorkflowStatus.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask.js'

function workflowState(
  overrides: Partial<LocalWorkflowTaskState> = {},
): LocalWorkflowTaskState {
  return {
    type: 'local_workflow',
    id: 'wf_123',
    status: 'paused',
    prompt: 'Audit code',
    summary: 'Paused by user',
    startTime: 1,
    workflowName: 'code-audit',
    workflowRunId: 'run_123',
    scriptPath: '/tmp/workflow.js',
    runArgs: '',
    phases: [],
    results: [],
    events: [],
    liveAgents: {},
    agentControllers: new Map(),
    abortController: new AbortController(),
    tokenCount: 0,
    toolUseCount: 0,
    ...overrides,
  } as LocalWorkflowTaskState
}

describe('formatWorkflowStatus child-agent summary', () => {
  it('shows completed failed skipped live and concurrency-blocked counts', () => {
    const state = workflowState({
      liveAgents: {
        agent_live: {
          tokenCount: 1,
          toolUseCount: 0,
          activity: 'aborting',
        },
      },
      results: [
        { agentId: 'agent_done', status: 'completed', result: 'ok' },
        {
          agentId: 'agent_failed',
          status: 'failed',
          error: 'Concurrency limit exceeded for user',
          errorKind: 'concurrency_limit',
        },
        { agentId: 'agent_skipped', status: 'skipped' },
      ],
    })

    const text = formatWorkflowStatus(state)

    expect(text).toContain('Child agents:')
    expect(text).toContain('1 completed')
    expect(text).toContain('1 failed')
    expect(text).toContain('1 skipped')
    expect(text).toContain('1 live/aborting')
    expect(text).toContain('1 blocked by concurrency limit')
  })
})
```

Adjust only field names that differ in the actual `LocalWorkflowTaskState` type.

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
```

Expected: FAIL because the status formatter does not yet include this summary.

- [ ] **Step 3: Add summary helper**

In `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`, export:

```ts
export type WorkflowChildAgentSummary = {
  completed: number
  failed: number
  skipped: number
  running: number
  live: number
  concurrencyBlocked: number
}

export function getWorkflowChildAgentSummary(
  task: Pick<LocalWorkflowTaskState, 'results' | 'liveAgents'>,
): WorkflowChildAgentSummary {
  const summary: WorkflowChildAgentSummary = {
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    live: Object.keys(task.liveAgents ?? {}).length,
    concurrencyBlocked: 0,
  }

  for (const result of task.results ?? []) {
    if (result.status === 'completed') summary.completed += 1
    if (result.status === 'failed') summary.failed += 1
    if (result.status === 'skipped') summary.skipped += 1
    if (result.status === 'running') summary.running += 1
    if (result.errorKind === 'concurrency_limit') {
      summary.concurrencyBlocked += 1
    }
  }

  return summary
}
```

If `LocalWorkflowTaskState` is declared later in the file, place the helper after the type declaration.

- [ ] **Step 4: Render summary in `formatWorkflowStatus.ts`**

Import helper:

```ts
import { getWorkflowChildAgentSummary } from './LocalWorkflowTask.js'
```

Add a local formatter:

```ts
function formatChildAgentSummary(task: LocalWorkflowTaskState): string | null {
  const summary = getWorkflowChildAgentSummary(task)
  const parts: string[] = []

  if (summary.completed > 0) parts.push(`${summary.completed} completed`)
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
  if (summary.running > 0) parts.push(`${summary.running} running`)
  if (summary.live > 0) parts.push(`${summary.live} live/aborting`)
  if (summary.concurrencyBlocked > 0) {
    parts.push(`${summary.concurrencyBlocked} blocked by concurrency limit`)
  }

  if (parts.length === 0) return null
  return `Child agents: ${parts.join(', ')}`
}
```

In `formatWorkflowStatus(...)`, append the summary after the main status/progress line and before controls:

```ts
const childSummary = formatChildAgentSummary(task)
if (childSummary) lines.push(childSummary)
```

Use the existing array/string assembly style in the file.

- [ ] **Step 5: Run focused status test**

Run:

```sh
bun src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit this task**

```sh
git add src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
git commit -m "fix: summarize workflow child agents"
```

## Task 6: Add pause result aftermath wording

**Files:**
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.test.ts`

- [ ] **Step 1: Add failing pause wording test**

In `src/tools/WorkflowTool/WorkflowTool.test.ts`, find existing tests for `action: 'pause'`. Add or extend one test so it asserts the pause result includes:

```ts
expect(resultText).toContain('Child agents:')
expect(resultText).toContain('Some notifications may still arrive')
expect(resultText).toContain('part of this workflow run')
```

Use the existing helper for extracting tool result text. If there is no helper, add a small local extraction consistent with the tool result shape in the test file.

- [ ] **Step 2: Run WorkflowTool test and verify failure**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowTool.test.ts
```

Expected: FAIL because pause result text does not include aftermath wording.

- [ ] **Step 3: Include child-agent summary in pause action**

In `src/tools/WorkflowTool/WorkflowTool.ts`, in the `pause` action handling:

1. Get the workflow task state after pausing.
2. Use `getWorkflowChildAgentSummary(task)`.
3. Format counts using the same wording as Task 5.
4. Append:

```text
Some notifications may still arrive from agents that were already finalizing; they are part of this workflow run.
```

Keep existing resume instruction unchanged.

- [ ] **Step 4: Run WorkflowTool test**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowTool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit this task**

```sh
git add src/tools/WorkflowTool/WorkflowTool.ts src/tools/WorkflowTool/WorkflowTool.test.ts
git commit -m "fix: explain workflow pause aftermath"
```

## Task 7: Focused verification and build

**Files:**
- No production code changes expected.

- [ ] **Step 1: Run focused ultracode and workflow tests**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
bun src/utils/processUserInput/processUserInput.test.ts
bun src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run effort-related tests if descriptions changed**

Run this only if implementation changed `src/utils/effort.ts`, `src/commands/effort/effort.tsx`, or OpenAI effort mapping:

```sh
bun src/utils/effort.test.ts
bun src/commands/effort/effort.test.ts
bun src/services/api/openai-compat.test.ts
```

Expected: all PASS. If no effort files changed, record “not run; effort mapping unchanged” in final handoff.

- [ ] **Step 3: Run typecheck**

Run:

```sh
bunx tsc --noEmit
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run lint**

Run:

```sh
bun run lint
```

Expected: no lint errors.

- [ ] **Step 5: Check diff formatting**

Run:

```sh
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Build binary**

Run:

```sh
make build
```

Expected: build succeeds and produces `./built-claude`.

- [ ] **Step 7: Commit verification-only fixes if needed**

If verification required code/test fixes, commit those fixes:

```sh
git add <specific fixed files>
git commit -m "test: stabilize workflow ultracode ux checks"
```

If no fixes were required, do not create an empty commit.

## Task 8: Optional tmux runtime validation

**Files:**
- No source changes expected.
- Artifacts: `/tmp/workflow-ultracode-ux-*.log`, `/tmp/workflow-ultracode-ux-*.txt`

- [ ] **Step 1: Start local CLI in tmux with debug log**

Run after `make build`:

```sh
tmux new-session -d -s workflow-ultracode-ux './built-claude --dangerously-skip-permissions --debug-file /tmp/workflow-ultracode-ux-debug.log'
```

Expected: tmux session starts.

- [ ] **Step 2: Send focused no-workflow ultracode prompt**

Run:

```sh
tmux send-keys -t workflow-ultracode-ux 'ultracode 研究 src/utils/ultracodeOrchestration.ts，不要 workflow，只直接读代码回答' Enter
```

Expected: no `WorkflowTool` / `Workflow` tool call is visible in pane or debug log.

- [ ] **Step 3: Capture pane output**

Run:

```sh
tmux capture-pane -t workflow-ultracode-ux -p -S -200 > /tmp/workflow-ultracode-ux-focused.txt
```

Expected: capture file exists and shows direct source research behavior.

- [ ] **Step 4: Send broad workflow-scale prompt**

Run:

```sh
tmux send-keys -t workflow-ultracode-ux 'ultracode 对 workflow orchestration UX 做 broad audit，可以使用 workflow 编排' Enter
```

Expected: Workflow may be proposed or permission preview may appear.

- [ ] **Step 5: Capture broad prompt output**

Run:

```sh
tmux capture-pane -t workflow-ultracode-ux -p -S -300 > /tmp/workflow-ultracode-ux-broad.txt
```

Expected: capture file exists and shows workflow-scale routing is still available.

- [ ] **Step 6: Stop tmux session**

Run:

```sh
tmux kill-session -t workflow-ultracode-ux
```

Expected: session exits. Preserve `/tmp/workflow-ultracode-ux-debug.log` and pane captures.

## Self-Review Checklist

- Spec coverage:
  - Softened ultracode reminders: Task 1 and Task 2.
  - WorkflowFacadeTool guard: Task 2.
  - PromptInput keyword setting mismatch: Task 3.
  - Concurrency-limit classification: Task 4.
  - Pause/kill child-agent summary: Task 5 and Task 6.
  - Recover-inspired diagnostics: included as design scope; full journal/adopted workflow are deferred larger follow-ups.
- Placeholder scan:
  - No `TBD`, `TODO`, “implement later”, or unspecified test instructions are used as required task content.
- Type consistency:
  - `WorkflowAgentErrorKind`, `errorKind`, `WorkflowChildAgentSummary`, and `getWorkflowChildAgentSummary` names are introduced before use in later tasks.
