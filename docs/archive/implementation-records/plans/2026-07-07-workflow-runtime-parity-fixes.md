# Workflow Runtime Parity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining workflow runtime parity gaps with `recover/claude-v2.1.201.js`: stable module initialization, real `journal.jsonl` diagnostics, consistent resume cache loading, official-compatible branch failure semantics, and explicit workflow/ultracode policy tests.

**Architecture:** Keep the existing `WorkflowTool` / `Workflow` facade split. Add a small workflow journal module under `src/tools/WorkflowTool/`, wire it into both script and declarative workflow runtimes, and keep `LocalWorkflowTask` as the UI state owner. Avoid broad rewrites: each task introduces one focused behavior with a failing Bun test first.

**Tech Stack:** TypeScript, Bun tests, existing `WorkflowTool`, `WorkflowFacadeTool`, `workflowScriptRuntime`, `runWorkflowPlan`, `workflowRunSessions`, `workflowResumeCache`, and `LocalWorkflowTask`.

---

## File Structure

- Modify: `src/tasks.ts`
  - Keep task registry imports lazy so workflow task modules can be imported in isolation.
- Modify: `src/tools.ts`
  - Keep workflow tool imports lazy so `WorkflowTool.ts` can import tool types without re-entering the global tool registry.
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
  - Keep workflow task registration local to avoid `utils/task/framework.ts` import cycles, while preserving SDK `task_started` output.
- Create: `src/tools/WorkflowTool/workflowJournal.ts`
  - Owns append/read helpers for `<transcriptDir>/journal.jsonl`.
- Create: `src/tools/WorkflowTool/workflowJournal.test.ts`
  - Focused test for JSONL started/result records and cache conversion.
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
  - Pass real transcript directory to runtime, append journal entries around agent execution, load resume journal entries, and keep launch envelope honest.
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
  - Use the same journal helpers for declarative workflow runs and soften root/branch failure semantics.
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
  - Ensure saved workflow runs with `resumeFromRunId` load prior session cache the same way inline/scriptPath runs do.
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
  - Store and expose the transcript directory consistently.
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`
  - Extend runtime parity coverage for journal files and launch envelope paths.
- Modify: `src/tools/WorkflowTool/WorkflowTool.test.ts`
  - Add regression coverage for saved workflow resume cache and failure semantics.
- Modify: `src/tools/WorkflowTool/runWorkflow.test.ts` if it exists; otherwise create `src/tools/WorkflowTool/runWorkflow.test.ts`
  - Test declarative runtime branch failure/null-result behavior without importing the full tool registry.
- Modify: `src/tools/WorkflowTool/workflowFeatureFlags.ts`
  - Centralize workflow enable/disable/keyword-trigger naming and make behavior explicit.
- Create or modify: `src/tools/WorkflowTool/workflowFeatureFlags.test.ts`
  - Test workflow feature flag and settings behavior.
- Modify: `docs/superpowers/specs/2026-07-05-workflow-ultracode-orchestration-ux-design.md`
  - Document intentional ultracode UX divergence from strict recover parity.

## Task 1: Preserve module initialization stability

**Files:**
- Modify: `src/tasks.ts`
- Modify: `src/tools.ts`
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- Test: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`
- Test: `src/tools/WorkflowTool/WorkflowTool.test.ts`

- [ ] **Step 1: Add import-regression checks to workflow runtime test**

Edit `src/tools/WorkflowTool/workflowScriptRuntime.test.ts` near the top, after existing imports, and add direct import assertions that fail if workflow task/tool modules re-enter their registries:

```ts
await import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js')
await import('./WorkflowTool.js')
```

This keeps the current initialization-loop regression visible before deeper runtime assertions execute.

- [ ] **Step 2: Run focused tests to verify the regression stays covered**

Run:

```sh
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
```

Expected before the fix: one or both commands fail with a TDZ error such as `ReferenceError: Cannot access 'LocalWorkflowTask' before initialization` or `ReferenceError: Cannot access 'WorkflowTool' before initialization`.

- [ ] **Step 3: Make task registry imports lazy**

In `src/tasks.ts`, keep the static imports for tasks that are already safe, but replace top-level `LocalWorkflowTask` and `MonitorMcpTask` values with lazy functions:

```ts
function getLocalWorkflowTask(): Task {
  // Lazy require avoids evaluating LocalWorkflowTask while tasks.ts itself is
  // being imported through task-stop/tool initialization paths.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
}

function getMonitorMcpTask(): Task | null {
  if (!feature('MONITOR_TOOL')) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tasks/MonitorMcpTask/MonitorMcpTask.js').MonitorMcpTask
}
```

Update `getAllTasks()` to call the functions inside the function body:

```ts
tasks.push(getLocalWorkflowTask())
const monitorMcpTask = getMonitorMcpTask()
if (monitorMcpTask) tasks.push(monitorMcpTask)
```

- [ ] **Step 4: Make workflow tool registry imports lazy**

In `src/tools.ts`, replace the top-level `workflowTools` IIFE with a function:

```ts
function getWorkflowTools(): Tool[] {
  require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
  return [
    require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool,
    require('./tools/WorkflowTool/WorkflowFacadeTool.js').WorkflowFacadeTool,
  ]
}
```

Replace usages of `workflowTools` with `getWorkflowTools()`:

```ts
...getWorkflowTools(),
```

and:

```ts
simpleTools.push(...getWorkflowTools())
```

- [ ] **Step 5: Keep workflow task registration local**

In `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`, do not import `registerTask` from `../../utils/task/framework.js`. Register the workflow state locally and emit the SDK start event directly:

```ts
setAppState(prev => ({
  ...prev,
  tasks: {
    ...prev.tasks,
    [taskState.id]: taskState,
  },
}))
enqueueSdkEvent({
  type: 'system',
  subtype: 'task_started',
  task_id: taskState.id,
  tool_use_id: taskState.toolUseId,
  description: taskState.description,
  task_type: taskState.type,
  workflow_name: taskState.workflowName,
  prompt: taskState.prompt,
})
return taskState
```

Import only the SDK helper as a runtime dependency:

```ts
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
```

- [ ] **Step 6: Verify initialization stability**

Run:

```sh
bun -e "import('./src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts').then(() => console.log('local workflow import ok'))"
bun -e "import('./src/tools/WorkflowTool/WorkflowTool.ts').then(() => console.log('workflow tool import ok'))"
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bunx tsc --noEmit
```

Expected: all commands pass.

## Task 2: Add real workflow journal JSONL support

**Files:**
- Create: `src/tools/WorkflowTool/workflowJournal.ts`
- Create: `src/tools/WorkflowTool/workflowJournal.test.ts`
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Test: `src/tools/WorkflowTool/workflowJournal.test.ts`
- Test: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`

- [ ] **Step 1: Write failing journal helper tests**

Create `src/tools/WorkflowTool/workflowJournal.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
  readWorkflowJournalCacheEntries,
  workflowJournalPath,
} from './workflowJournal.js'

const dir = await mkdtemp(join(tmpdir(), 'workflow-journal-test-'))
const startedAt = 1710000000000
const completedAt = 1710000000100

await appendWorkflowJournalStarted(dir, {
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  timestamp: startedAt,
})
await appendWorkflowJournalResult(dir, {
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  result: 'agent output',
  timestamp: completedAt,
})

const raw = await readFile(workflowJournalPath(dir), 'utf8')
const lines = raw.trim().split('\n').map(line => JSON.parse(line))
assert.deepEqual(lines[0], {
  type: 'started',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  timestamp: startedAt,
})
assert.deepEqual(lines[1], {
  type: 'result',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  result: 'agent output',
  timestamp: completedAt,
})

const cache = await readWorkflowJournalCacheEntries(dir)
assert.deepEqual(cache, [
  {
    index: 0,
    identity: 'phase-a:agent-a:0',
    phase: 'phase-a',
    label: 'agent-a',
    result: 'agent output',
    completedAt,
  },
])

console.log('workflowJournal.test.ts passed')
```

- [ ] **Step 2: Run the failing journal test**

Run:

```sh
bun src/tools/WorkflowTool/workflowJournal.test.ts
```

Expected: FAIL with module-not-found for `./workflowJournal.js`.

- [ ] **Step 3: Implement the journal helper**

Create `src/tools/WorkflowTool/workflowJournal.ts`:

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isENOENT } from '../../utils/errors.js'
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'

export type WorkflowJournalStartedEntry = {
  type: 'started'
  key: string
  agentId: string
  phase?: string
  label?: string
  index?: number
  timestamp: number
}

export type WorkflowJournalResultEntry = {
  type: 'result'
  key: string
  agentId: string
  phase?: string
  label?: string
  index?: number
  result: unknown
  timestamp: number
}

export type WorkflowJournalEntry =
  | WorkflowJournalStartedEntry
  | WorkflowJournalResultEntry

export function workflowJournalPath(transcriptDir: string): string {
  return join(transcriptDir, 'journal.jsonl')
}

async function appendWorkflowJournalEntry(
  transcriptDir: string,
  entry: WorkflowJournalEntry,
): Promise<void> {
  await mkdir(transcriptDir, { recursive: true })
  await appendFile(workflowJournalPath(transcriptDir), `${JSON.stringify(entry)}\n`)
}

export async function appendWorkflowJournalStarted(
  transcriptDir: string,
  entry: Omit<WorkflowJournalStartedEntry, 'type'>,
): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'started', ...entry })
}

export async function appendWorkflowJournalResult(
  transcriptDir: string,
  entry: Omit<WorkflowJournalResultEntry, 'type'>,
): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'result', ...entry })
}

export async function readWorkflowJournalEntries(
  transcriptDir: string,
): Promise<WorkflowJournalEntry[]> {
  let raw: string
  try {
    raw = await readFile(workflowJournalPath(transcriptDir), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as WorkflowJournalEntry)
}

export async function readWorkflowJournalCacheEntries(
  transcriptDir: string,
): Promise<WorkflowResumeCacheEntry[]> {
  const entries = await readWorkflowJournalEntries(transcriptDir)
  return entries.flatMap((entry, index): WorkflowResumeCacheEntry[] => {
    if (entry.type !== 'result') return []
    return [
      {
        index: entry.index ?? index,
        identity: entry.key,
        phase: entry.phase,
        label: entry.label,
        result: entry.result,
        completedAt: entry.timestamp,
      },
    ]
  })
}
```

- [ ] **Step 4: Run the focused journal test**

Run:

```sh
bun src/tools/WorkflowTool/workflowJournal.test.ts
```

Expected: PASS and prints `workflowJournal.test.ts passed`.

- [ ] **Step 5: Wire script runtime journal writes around agent calls**

In `src/tools/WorkflowTool/workflowScriptRuntime.ts`, import the helper:

```ts
import {
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
  readWorkflowJournalCacheEntries,
} from './workflowJournal.js'
```

Inside the function that runs a single workflow agent, compute a stable identity before invoking `AgentTool`:

```ts
const identity = `${phase}:${label}:${index}`
await appendWorkflowJournalStarted(transcriptDir, {
  key: identity,
  agentId: label,
  phase,
  label,
  index,
  timestamp: Date.now(),
})
```

After successful agent completion, append the result:

```ts
await appendWorkflowJournalResult(transcriptDir, {
  key: identity,
  agentId: label,
  phase,
  label,
  index,
  result: output,
  timestamp: Date.now(),
})
```

For structured output agents, write the structured result value, not only the rendered text.

- [ ] **Step 6: Make launch envelope and session state use the same transcript directory**

In `src/tools/WorkflowTool/workflowRunSessions.ts`, extend `WorkflowRunSession` with:

```ts
transcriptDir?: string
```

When starting a script workflow run, compute `transcriptDir` once, pass it to `startWorkflowRunSession`, pass it to `runSingleAgent`, and pass it to `workflowLaunchEnvelope`. Do not print a `journal.jsonl` warning unless that exact directory is where `workflowJournalPath(transcriptDir)` is written.

- [ ] **Step 7: Extend runtime test for the journal file**

In `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`, after the run completes and before final `console.log`, inspect the launched task and journal path:

```ts
const workflowTask = Object.values(state.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(workflowTask)
assert.ok(workflowTask.scriptPath)
assert.match(result, /Transcript dir: /)
```

Read the journal from the transcript dir stored in the workflow session or task state:

```ts
const journalRaw = await readFile(join(transcriptDir, 'journal.jsonl'), 'utf8')
assert.match(journalRaw, /"type":"started"/)
assert.match(journalRaw, /"type":"result"/)
assert.match(journalRaw, /"agentId":"alpha"/)
```

Import `readFile` and `join` at the top if needed.

- [ ] **Step 8: Run journal and runtime tests**

Run:

```sh
bun src/tools/WorkflowTool/workflowJournal.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bunx tsc --noEmit
```

Expected: all pass.

## Task 3: Load resume cache consistently for saved workflows

**Files:**
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`

- [ ] **Step 1: Add failing test for saved workflow resume cache**

In `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`, add a source-level regression assertion if the file currently avoids importing `WorkflowFacadeTool` directly:

```ts
assert.match(
  workflowFacadeSource,
  /loadWorkflowRunSession\([^)]*resumeFromRunId/s,
)
assert.match(
  workflowFacadeSource,
  /resumeJournalEntries:\s*priorSession\?\.resumeCacheEntries/s,
)
```

If this test file already imports and calls the facade safely, instead add an execution test that runs a saved workflow once, then invokes it again with `resumeFromRunId`, and asserts the second run uses cached agent output.

- [ ] **Step 2: Run the failing facade test**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: FAIL because the saved workflow branch does not load `priorSession` and does not pass `resumeJournalEntries`.

- [ ] **Step 3: Load prior session in the saved workflow branch**

In `src/tools/WorkflowTool/WorkflowFacadeTool.ts`, in the branch that handles a saved workflow name, load prior session exactly as the inline/scriptPath branch does:

```ts
const priorSession = input.resumeFromRunId
  ? await loadWorkflowRunSession(input.resumeFromRunId)
  : undefined
```

Pass it into `runWorkflowPlan` or `runWorkflowScript`:

```ts
resumeJournalEntries: priorSession?.resumeCacheEntries,
```

If the branch uses `loadWorkflowSpecByNameOrPath`, keep the load order simple: resolve the spec, validate the plan, load `priorSession`, then run.

- [ ] **Step 4: Prefer real journal cache when available**

If `priorSession?.transcriptDir` exists, load `journal.jsonl` entries and prefer them over JSON session cache:

```ts
const resumeJournalEntries = priorSession?.transcriptDir
  ? await readWorkflowJournalCacheEntries(priorSession.transcriptDir)
  : priorSession?.resumeCacheEntries
```

Import:

```ts
import { readWorkflowJournalCacheEntries } from './workflowJournal.js'
```

- [ ] **Step 5: Run facade and runtime tests**

Run:

```sh
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bunx tsc --noEmit
```

Expected: all pass.

## Task 4: Remove non-official root insufficient-output abort

**Files:**
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Create or modify: `src/tools/WorkflowTool/runWorkflow.test.ts`
- Test: `src/tools/WorkflowTool/runWorkflow.test.ts`
- Test: `src/tools/WorkflowTool/WorkflowTool.test.ts`

- [ ] **Step 1: Add a failing test for short root output**

Create `src/tools/WorkflowTool/runWorkflow.test.ts` if it does not exist. Add a fake agent tool that returns a short but valid output:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { runWorkflowPlan } from './runWorkflow.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}

const plan: WorkflowDryRunPlan = {
  name: 'short-root-output',
  description: 'Accept short root output.',
  defaults: {
    maxConcurrency: 1,
    maxAgents: 1,
    maxRetries: 0,
    fanout: 1,
    concurrency: 1,
    review: 'none',
    permissionMode: 'bypassPermissions',
    execution: 'agent',
  },
  phases: [
    {
      id: 'root',
      description: 'Root phase',
      prompt: 'Return ok.',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 1,
}

const fakeAgentTool = {
  name: 'Agent',
  async call() {
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'ok' }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}

const context = {
  getAppState: () => state,
  setAppState,
  options: {
    tools: [fakeAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_short_root',
} as unknown as ToolUseContext

const result = await runWorkflowPlan({
  plan,
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_short_root' } } as never,
  workflowRunId: 'wf_short_root',
})

assert.match(result, /Workflow launched in background\. Task ID: w/)
const task = Object.values(state.tasks).find(task => task.type === 'local_workflow')
assert.equal(task?.status, 'completed')

console.log('runWorkflow.test.ts passed')
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
bun src/tools/WorkflowTool/runWorkflow.test.ts
```

Expected before implementation: FAIL with `Workflow aborted: root phase "root" returned insufficient output`.

- [ ] **Step 3: Remove the length-based root output guard**

In `src/tools/WorkflowTool/runWorkflow.ts`, delete this behavior entirely:

```ts
if (
  phase.fanout === 1 &&
  phase.dependsOn.length === 0 &&
  results.length === 1
) {
  const output = results[0]?.output ?? ''
  if (!output || output.length < 20) {
    throw new Error(
      `Workflow aborted: root phase "${phase.id}" returned insufficient output (${output.length} chars). The phase agent may not have received valid input.`,
    )
  }
}
```

Do not replace it with another content-length guard. Official parity treats empty/short cached results as diagnosable via `journal.jsonl`, not as a hard runtime abort.

- [ ] **Step 4: Run declarative workflow tests**

Run:

```sh
bun src/tools/WorkflowTool/runWorkflow.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bunx tsc --noEmit
```

Expected: all pass.

## Task 5: Align branch failure semantics for partial workflows

**Files:**
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.test.ts`
- Modify: `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`

- [ ] **Step 1: Add a failing test for one failed branch plus one successful branch**

Append to `src/tools/WorkflowTool/runWorkflow.test.ts` a second scenario using two fake agent calls. The first returns completed output; the second throws:

```ts
let callCount = 0
const partialAgentTool = {
  name: 'Agent',
  async call() {
    callCount++
    if (callCount === 1) {
      return {
        data: {
          status: 'completed',
          content: [{ type: 'text', text: 'useful branch output' }],
          totalTokens: 2,
          totalToolUseCount: 0,
          totalDurationMs: 1,
        },
      }
    }
    throw new Error('branch failed')
  },
}
```

Use a plan with `fanout: 2`, `concurrency: 2`, and assert:

```ts
const partialTask = Object.values(partialState.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(partialTask)
assert.equal(partialTask.results.some(result => result.status === 'completed'), true)
assert.equal(partialTask.results.some(result => result.status === 'failed'), true)
```

The runtime may mark the overall workflow as `failed` if a required phase cannot synthesize a final result, but it must preserve both branch results and not discard successful output.

- [ ] **Step 2: Run the failing branch test**

Run:

```sh
bun src/tools/WorkflowTool/runWorkflow.test.ts
```

Expected before implementation: FAIL because a thrown branch error aborts the phase before preserving partial state, or because the whole run throws without stable result bookkeeping.

- [ ] **Step 3: Preserve partial branch results before throwing terminal phase errors**

In `src/tools/WorkflowTool/runWorkflow.ts`, ensure each branch failure calls `failWorkflowAgent` and records a `WorkflowAgentResult` before retry exhaustion throws. If a phase has mixed results, keep the `completed` and `failed` result records in `LocalWorkflowTask.results` and `WorkflowRunSession.results`.

Use the existing `classifyWorkflowAgentError` helper if available; otherwise import or duplicate only the classification function, not broad runtime code.

- [ ] **Step 4: Match script runtime null-result behavior**

In `src/tools/WorkflowTool/workflowScriptRuntime.ts`, keep the current behavior where failed/invalid structured output can return `null` to the workflow script, and ensure that `null` result is also written to `journal.jsonl` as a `result` entry when the agent invocation has completed with a known invalid/empty output.

Add this assertion to `src/tools/WorkflowTool/workflowScriptRuntime.test.ts` for the empty-error or schema-invalid path:

```ts
assert.match(journalRaw, /"result":null/)
```

- [ ] **Step 5: Run partial failure tests**

Run:

```sh
bun src/tools/WorkflowTool/runWorkflow.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bunx tsc --noEmit
```

Expected: all pass.

## Task 6: Centralize workflow feature flags and settings parity

**Files:**
- Modify: `src/tools/WorkflowTool/workflowFeatureFlags.ts`
- Create or modify: `src/tools/WorkflowTool/workflowFeatureFlags.test.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/utils/ultracodeOrchestration.ts`

- [ ] **Step 1: Add feature flag tests**

Create `src/tools/WorkflowTool/workflowFeatureFlags.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  isWorkflowKeywordTriggerEnabled,
  shouldShowWorkflowUsageWarning,
  shouldEnableWorkflows,
} from './workflowFeatureFlags.js'

assert.equal(shouldEnableWorkflows({ enableWorkflows: true }), true)
assert.equal(shouldEnableWorkflows({ disableWorkflows: true }), false)
assert.equal(
  shouldEnableWorkflows({ enableWorkflows: true, disableWorkflows: true }),
  false,
)
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: false }), false)
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: true }), true)
assert.equal(isWorkflowKeywordTriggerEnabled({ ultracodeKeywordTrigger: false }), false)
assert.equal(shouldShowWorkflowUsageWarning({ skipWorkflowUsageWarning: true }), false)
assert.equal(shouldShowWorkflowUsageWarning({ skipWorkflowUsageWarning: false }), true)

console.log('workflowFeatureFlags.test.ts passed')
```

Use `SettingsJson`-compatible object shapes if the actual settings type already declares different field names.

- [ ] **Step 2: Run the failing flag test**

Run:

```sh
bun src/tools/WorkflowTool/workflowFeatureFlags.test.ts
```

Expected before implementation: FAIL for missing exports or unsupported setting names.

- [ ] **Step 3: Implement central helpers**

In `src/tools/WorkflowTool/workflowFeatureFlags.ts`, add pure helpers:

```ts
type WorkflowSettings = {
  enableWorkflows?: boolean
  disableWorkflows?: boolean
  workflowKeywordTriggerEnabled?: boolean
  ultracodeKeywordTrigger?: boolean
  skipWorkflowUsageWarning?: boolean
}

export function shouldEnableWorkflows(settings: WorkflowSettings | undefined): boolean {
  if (settings?.disableWorkflows) return false
  if (settings?.enableWorkflows === false) return false
  return true
}

export function isWorkflowKeywordTriggerEnabled(settings: WorkflowSettings | undefined): boolean {
  if (settings?.workflowKeywordTriggerEnabled !== undefined) {
    return settings.workflowKeywordTriggerEnabled
  }
  if (settings?.ultracodeKeywordTrigger !== undefined) {
    return settings.ultracodeKeywordTrigger
  }
  return true
}

export function shouldShowWorkflowUsageWarning(settings: WorkflowSettings | undefined): boolean {
  return settings?.skipWorkflowUsageWarning !== true
}
```

- [ ] **Step 4: Wire helpers into workflow and ultracode gates**

In `src/tools/WorkflowTool/WorkflowTool.ts`, use `shouldEnableWorkflows(context.getAppState().settings)` in `isEnabled` or call-time guard, matching the existing tool API shape.

In `src/utils/ultracodeOrchestration.ts`, call `isWorkflowKeywordTriggerEnabled(settings)` when deciding whether to show or inject keyword-triggered workflow/ultracode notifications.

- [ ] **Step 5: Run flag and ultracode tests**

Run:

```sh
bun src/tools/WorkflowTool/workflowFeatureFlags.test.ts
bun src/utils/ultracodeOrchestration.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bunx tsc --noEmit
```

Expected: all pass.

## Task 7: Document strict parity versus intentional ultracode UX divergence

**Files:**
- Modify: `docs/superpowers/specs/2026-07-05-workflow-ultracode-orchestration-ux-design.md`
- Modify: `src/utils/ultracodeOrchestration.test.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.test.ts`

- [ ] **Step 1: Add source-level assertions that preserve the intentional divergence**

In `src/utils/ultracodeOrchestration.test.ts`, keep or add assertions that softened wording remains present:

```ts
assert.match(messagesSource, /workflow-scale orchestration/)
assert.match(messagesSource, /For focused tasks/)
assert.doesNotMatch(messagesSource, /Use the Workflow tool on every substantive task/)
```

In `src/tools/WorkflowTool/WorkflowTool.test.ts`, keep or add prompt assertions:

```ts
assert.match(workflowPrompt, /workflow-scale orchestration/)
assert.match(workflowPrompt, /For focused tasks/)
assert.doesNotMatch(workflowPrompt, /every substantive task/)
```

- [ ] **Step 2: Update the design doc with an explicit parity decision**

In `docs/superpowers/specs/2026-07-05-workflow-ultracode-orchestration-ux-design.md`, add a section:

```md
## Parity Decision: Ultracode Prompting

`recover/claude-v2.1.201.js` uses stronger model-visible wording that pushes Workflow on every substantive ultracode turn. This repository intentionally diverges for UX safety: ultracode increases verification effort, but Workflow is preferred only for broad workflow-scale tasks such as audits, migrations, deep research, cross-checking, and independent fan-out. Focused tasks should use direct tools or a small number of subagents, and explicit user requests to avoid workflows must be respected.

Strict parity still applies to runtime lifecycle behavior: launch envelope, parent task events, progress, terminal notifications, transcript directory, `journal.jsonl`, and resume cache semantics.
```

- [ ] **Step 3: Run documentation-adjacent tests**

Run:

```sh
bun src/utils/ultracodeOrchestration.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
```

Expected: both pass.

## Task 8: Final verification and cleanup

**Files:**
- Verify all modified files from Tasks 1-7.

- [ ] **Step 1: Run focused workflow tests**

Run:

```sh
bun src/tools/WorkflowTool/workflowJournal.test.ts
bun src/tools/WorkflowTool/workflowScriptRuntime.test.ts
bun src/tools/WorkflowTool/runWorkflow.test.ts
bun src/tools/WorkflowTool/WorkflowTool.test.ts
bun src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
bun src/tools/WorkflowTool/workflowFeatureFlags.test.ts
bun src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
bun src/utils/ultracodeOrchestration.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run typecheck**

Run:

```sh
bunx tsc --noEmit
```

Expected: exits 0 with no output.

- [ ] **Step 3: Run build because workflow runtime and CLI behavior changed**

Run:

```sh
make build
```

Expected: `./built-claude` is produced successfully.

- [ ] **Step 4: Inspect diff for accidental broad changes**

Run:

```sh
git status --short
git diff -- src/tasks.ts src/tools.ts src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts src/tools/WorkflowTool docs/superpowers/specs/2026-07-05-workflow-ultracode-orchestration-ux-design.md
```

Expected: diff only contains the planned runtime parity changes, tests, and design doc clarification. No debug logs, generated binary, secrets, or unrelated formatting changes should be staged.

- [ ] **Step 5: Commit only if the user explicitly asks**

Do not commit automatically. If the user says `commit`, run the project git safety flow first: `git status`, `git diff`, recent `git log`, then stage only intended files and create a new commit.

## Self-Review Notes

- Spec coverage: covers initialization cycles, journal artifact, resume cache consistency, root output guard removal, partial failure semantics, feature flags/settings, ultracode parity decision, and final verification.
- Placeholder scan: no `TBD`, no vague `handle edge cases`, and every task includes concrete files, commands, and expected outcomes.
- Type consistency: uses existing names where present (`WorkflowResumeCacheEntry`, `resumeJournalEntries`, `workflowRunInForeground`, `LocalWorkflowTaskState`) and introduces only one new module (`workflowJournal.ts`) with explicit exported helper names.
