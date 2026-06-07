# Workflow Session List UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the local tmux debug launch flow and replace the current coordinator task panel with an official-style selectable session/background-work list that can switch to main, agent, and workflow contexts while preserving workflow metric parity.

**Architecture:** Keep the existing footer selection state (`footerSelection === 'tasks'`) and row index state (`coordinatorTaskIndex`) as the single source of keyboard navigation truth. Refactor `CoordinatorAgentStatus.tsx` by extracting pure row model helpers that format main/agent/workflow rows, then render those rows from Ink components; keep Enter behavior delegated to the existing main/agent/workflow handlers. Fix completed workflow metric display by preserving live progress metrics through agent completion so workflow rows and detail views can show real token/tool counts instead of zeroes.

**Tech Stack:** TypeScript, React Ink-style `Box`/`Text`, existing AppState task model, Node/esbuild-based test runner (`scripts/run-workflow-tests.mjs`), tmux manual verification.

---

## File structure

- Modify: `CLAUDE.md` — add the requested local workflow debug build/start commands.
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` — preserve completed workflow agent live progress metrics so UI detail rows can display final token/tool counts when the final Agent tool output lacks totals.
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts` — add a regression assertion that `completeWorkflowAgent()` carries forward live progress metrics into `results`, `tokenCount`, and `toolUseCount`.
- Modify: `src/components/CoordinatorAgentStatus.tsx` — replace the existing simple `main` + `AgentLine` task panel with a compact selectable session/background-work list; add pure helpers for row modeling and export them for tests.
- Create: `src/components/CoordinatorAgentStatus.test.ts` — test row model output for main, local agent, completed workflow, selected rows, and workflow metric formatting.
- Modify: `scripts/run-workflow-tests.mjs` — include the new `CoordinatorAgentStatus.test.ts` in the workflow/UI test batch.

---

### Task 1: Record local tmux debug commands

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md` with the requested commands**

Replace the Dynamic workflow compatibility section with this exact block:

```md
# Project Instructions

## Dynamic workflow compatibility work

- Use `tmux send-keys` to interact with both the official Claude Code binary and the current project build when debugging workflow compatibility. Explicitly compare and record both UI behavior differences and workflow execution logic differences before and after fixes.
- For local workflow debugging, compile with `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build` and launch with `pnpm start`; use tmux for interaction rather than direct internal function calls.
- Use analysis techniques, including reverse engineering and deobfuscation, to inspect JavaScript saved by the official binary and understand related workflow and agent orchestration logic. Do not blindly copy proprietary official script bodies; reconstruct behavior clean-room unless explicitly authorized.
- Preserve the existing project code style. For interactive UI, write React Ink-style components and prefer existing UI/layout libraries or structured `Box`/`Text` layouts over fixed-width string construction.
- Periodically inspect code you have written, remove invalid or dead snippets, and verify authorship before cleanup when uncertain. Use `git blame` when needed to distinguish your changes from code written by Esonhugh.
```

- [ ] **Step 2: Verify the file contains the command text**

Run:

```bash
grep -n "CLAUDE_CODE_VERSION=2.1.165-dev pnpm build\|pnpm start" CLAUDE.md
```

Expected output includes:

```text
6:- For local workflow debugging, compile with `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build` and launch with `pnpm start`; use tmux for interaction rather than direct internal function calls.
```

---

### Task 2: Preserve workflow agent metrics after completion

**Files:**
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts`
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`

- [ ] **Step 1: Write the failing regression test**

In `src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts`, add `completeWorkflowAgent` to the import list near the top if it is not already imported:

```ts
import {
  completeWorkflowAgent,
  killWorkflowTask,
  pauseWorkflowTask,
  recordWorkflowAgentController,
  recordWorkflowAgentProgress,
  resumeWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  type LocalWorkflowTaskState,
} from './LocalWorkflowTask.js'
```

Then add this block after the existing `recordWorkflowAgentProgress({ taskId: 'w-running', ... })` assertions for the running task:

```ts
  completeWorkflowAgent({
    taskId: 'w-running',
    result: {
      phaseId: 'phase',
      agentId: 'agent-1',
      index: 0,
      status: 'completed',
      output: 'done',
    },
    setAppState,
  })

  const completedProgressTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.equal(completedProgressTask.results[0]?.tokenCount, 12)
  assert.equal(completedProgressTask.results[0]?.toolUseCount, 1)
  assert.equal(completedProgressTask.tokenCount, 12)
  assert.equal(completedProgressTask.toolUseCount, 1)
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: FAIL in `LocalWorkflowTask.test.ts` because `completedProgressTask.results[0]?.tokenCount` is `undefined` or `completedProgressTask.tokenCount` remains `0` for a completion result without explicit metrics.

- [ ] **Step 3: Implement metric carry-forward**

In `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`, add this helper above `completeWorkflowAgent()`:

```ts
function resultWithProgressMetrics(
  task: LocalWorkflowTaskState,
  activeAgentId: string | undefined,
  result: WorkflowAgentResult,
): WorkflowAgentResult {
  const liveProgress = task.liveAgents?.[result.agentId] ?? (
    activeAgentId ? task.liveAgents?.[activeAgentId] : undefined
  )
  if (!liveProgress) return result
  return {
    ...result,
    tokenCount: result.tokenCount ?? liveProgress.tokenCount,
    toolUseCount: result.toolUseCount ?? liveProgress.toolUseCount,
  }
}
```

Then in `completeWorkflowAgent()`, replace:

```ts
    const activeAgentId = task.currentAgentId
    const nextTask = updatePhase(task, result.phaseId, phase => {
```

with:

```ts
    const activeAgentId = task.currentAgentId
    const completedResult = resultWithProgressMetrics(task, activeAgentId, result)
    const nextTask = updatePhase(task, completedResult.phaseId, phase => {
```

Inside the same function, replace every remaining completion-result write with `completedResult`:

```ts
          completedResult.agentId,
```

```ts
          if (agentId.startsWith(`${completedResult.agentId}-retry-`)) return false
          if (completedResult.agentId.startsWith(`${agentId}-retry-`)) return false
          return !agentId.includes(`-${completedResult.index + 1}-`)
```

```ts
        results: [...removePhaseResultsForIndex(phase.results, completedResult.index), completedResult],
```

```ts
    const liveAgentKeysToRemove = new Set([completedResult.agentId])
```

```ts
          completedResult.phaseId,
          completedResult.index,
```

```ts
        completedResult,
```

```ts
      summary: `Completed ${completedResult.phaseId} agent ${completedResult.index + 1}`,
      tokenCount: (nextTask.tokenCount ?? 0) + (completedResult.tokenCount ?? 0),
      toolUseCount: (nextTask.toolUseCount ?? 0) + (completedResult.toolUseCount ?? 0),
```

- [ ] **Step 4: Run the workflow tests and verify they pass**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS, including `LocalWorkflowTask.test.ts passed`.

---

### Task 3: Add pure row-model helpers for the replacement task panel

**Files:**
- Create: `src/components/CoordinatorAgentStatus.test.ts`
- Modify: `src/components/CoordinatorAgentStatus.tsx`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing row-model test**

Create `src/components/CoordinatorAgentStatus.test.ts` with this content:

```ts
import assert from 'node:assert/strict'

import type { AppState } from '../state/AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  getCoordinatorSessionRows,
  getVisibleAgentTasks,
} from './CoordinatorAgentStatus.js'

const agentTask: LocalAgentTaskState = {
  id: 'agent-1',
  type: 'local_agent',
  status: 'running',
  description: 'Research user reports',
  prompt: 'Research user reports',
  startTime: 1_000,
  outputFile: '.claude/tasks/agent-1.output',
  outputOffset: 0,
  notified: false,
  progress: {
    tokenCount: 1500,
    toolUseCount: 2,
    lastActivity: 'Read(src/index.ts)',
  },
} as unknown as LocalAgentTaskState

const workflowTask: LocalWorkflowTaskState = {
  id: 'workflow-1',
  type: 'local_workflow',
  status: 'completed',
  description: 'Workflow: tmux-agent-smoke',
  workflowName: 'tmux-agent-smoke',
  summary: 'Workflow completed',
  agentCount: 1,
  tokenCount: 19591,
  toolUseCount: 0,
  defaultModel: 'gpt-5.5[1m]',
  startTime: 2_000,
  endTime: 4_000,
  outputFile: '.claude/tasks/workflow-1.output',
  outputOffset: 0,
  notified: false,
  phases: [
    {
      id: 'Run',
      status: 'completed',
      agentIds: ['tmux-agent-smoke'],
      completedAgentIds: ['tmux-agent-smoke'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [
        {
          phaseId: 'Run',
          agentId: 'tmux-agent-smoke',
          index: 0,
          status: 'completed',
          output: 'TMUX_WORKFLOW_AGENT_OK',
          tokenCount: 19591,
          toolUseCount: 0,
          durationMs: 2319,
        },
      ],
    },
  ],
  results: [
    {
      phaseId: 'Run',
      agentId: 'tmux-agent-smoke',
      index: 0,
      status: 'completed',
      output: 'TMUX_WORKFLOW_AGENT_OK',
      tokenCount: 19591,
      toolUseCount: 0,
      durationMs: 2319,
    },
  ],
  events: [],
}

const tasks = {
  [agentTask.id]: agentTask,
  [workflowTask.id]: workflowTask,
} as unknown as AppState['tasks']

assert.deepEqual(
  getVisibleAgentTasks(tasks).map(task => task.id),
  ['agent-1', 'workflow-1'],
)

const rows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 2,
  viewingAgentTaskId: undefined,
  nameByAgentId: new Map([['agent-1', 'researcher']]),
  now: 5_000,
})

assert.equal(rows.length, 3)
assert.deepEqual(rows[0], {
  id: 'main',
  taskId: undefined,
  kind: 'main',
  selected: false,
  viewed: true,
  icon: '●',
  label: 'main',
  meta: '',
  statusText: 'current session',
})
assert.equal(rows[1]?.id, 'agent-1')
assert.equal(rows[1]?.kind, 'agent')
assert.equal(rows[1]?.label, 'agent researcher')
assert.equal(rows[1]?.meta, '1.5k tok · 2 tools')
assert.equal(rows[1]?.statusText, 'running · Read(src/index.ts)')
assert.equal(rows[2]?.id, 'workflow-1')
assert.equal(rows[2]?.kind, 'workflow')
assert.equal(rows[2]?.selected, true)
assert.equal(rows[2]?.label, 'workflow tmux-agent-smoke')
assert.equal(rows[2]?.meta, '1/1 agents · 19.6k tok')
assert.equal(rows[2]?.statusText, 'done · 2s')

console.log('CoordinatorAgentStatus.test.ts passed')
```

- [ ] **Step 2: Register the new test in the workflow test runner**

In `scripts/run-workflow-tests.mjs`, add this entry after `src/components/tasks/workflowDetailSnapshot.test.ts`:

```js
  'src/components/CoordinatorAgentStatus.test.ts',
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: FAIL because `getCoordinatorSessionRows` is not exported from `CoordinatorAgentStatus.tsx`.

- [ ] **Step 4: Add the row model types and helpers**

In `src/components/CoordinatorAgentStatus.tsx`, update the format import:

```ts
import { formatDuration, formatNumber } from '../utils/format.js'
```

Add these types and helpers after `getVisibleAgentTasks()`:

```ts
export type CoordinatorSessionRow = {
  id: string
  taskId?: string
  kind: 'main' | 'agent' | 'workflow'
  selected: boolean
  viewed: boolean
  icon: string
  label: string
  meta: string
  statusText: string
}

type CoordinatorSessionRowsInput = {
  tasks: AppState['tasks']
  selectedIndex?: number
  viewingAgentTaskId?: string
  nameByAgentId: Map<string, string>
  now?: number
}

function taskElapsed(task: CoordinatorPanelTask, now: number): string {
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    task.status === 'running'
      ? now - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )
  return formatDuration(elapsedMs)
}

function workflowCompletedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function workflowStatusText(task: LocalWorkflowTaskState, now: number): string {
  if (task.status === 'completed') return `done · ${taskElapsed(task, now)}`
  if (task.status === 'failed') return `failed · ${taskElapsed(task, now)}`
  if (task.status === 'killed') return `killed · ${taskElapsed(task, now)}`
  if (task.status === 'pending') return `paused · ${taskElapsed(task, now)}`
  return `running · ${taskElapsed(task, now)}`
}

function agentStatusText(task: LocalAgentTaskState, now: number): string {
  const prefix = isTerminalStatus(task.status) ? task.status : 'running'
  const activity = task.progress?.lastActivity
  return activity ? `${prefix} · ${activity}` : `${prefix} · ${taskElapsed(task, now)}`
}

function taskIcon(task: CoordinatorPanelTask): string {
  if (task.status === 'completed') return figures.tick
  if (task.status === 'failed' || task.status === 'killed') return figures.cross
  if (task.status === 'pending') return PAUSE_ICON
  return BLACK_CIRCLE
}

function agentRowLabel(task: LocalAgentTaskState, nameByAgentId: Map<string, string>): string {
  return `agent ${nameByAgentId.get(task.id) ?? task.description ?? task.id}`
}

function workflowRowLabel(task: LocalWorkflowTaskState): string {
  return `workflow ${task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')}`
}

function agentRowMeta(task: LocalAgentTaskState): string {
  const tokenCount = task.progress?.tokenCount ?? 0
  const toolUseCount = task.progress?.toolUseCount ?? 0
  return `${formatNumber(tokenCount)} tok · ${toolUseCount} ${toolUseCount === 1 ? 'tool' : 'tools'}`
}

function workflowRowMeta(task: LocalWorkflowTaskState): string {
  const completed = workflowCompletedAgents(task)
  const total = task.agentCount ?? task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
  const tokenCount = task.tokenCount ?? task.results.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0)
  return `${completed}/${total} ${total === 1 ? 'agent' : 'agents'} · ${formatNumber(tokenCount)} tok`
}

export function getCoordinatorSessionRows({
  tasks,
  selectedIndex,
  viewingAgentTaskId,
  nameByAgentId,
  now = Date.now(),
}: CoordinatorSessionRowsInput): CoordinatorSessionRow[] {
  const visibleTasks = getVisibleAgentTasks(tasks)
  return [
    {
      id: 'main',
      kind: 'main',
      selected: selectedIndex === 0,
      viewed: viewingAgentTaskId === undefined,
      icon: viewingAgentTaskId === undefined ? BLACK_CIRCLE : figures.circle,
      label: 'main',
      meta: '',
      statusText: 'current session',
    },
    ...visibleTasks.map((task, index): CoordinatorSessionRow => {
      const selected = selectedIndex === index + 1
      if (task.type === 'local_agent') {
        return {
          id: task.id,
          taskId: task.id,
          kind: 'agent',
          selected,
          viewed: viewingAgentTaskId === task.id,
          icon: taskIcon(task),
          label: agentRowLabel(task, nameByAgentId),
          meta: agentRowMeta(task),
          statusText: agentStatusText(task, now),
        }
      }
      return {
        id: task.id,
        taskId: task.id,
        kind: 'workflow',
        selected,
        viewed: false,
        icon: taskIcon(task),
        label: workflowRowLabel(task),
        meta: workflowRowMeta(task),
        statusText: workflowStatusText(task, now),
      }
    }),
  ]
}
```

- [ ] **Step 5: Run the workflow tests and verify they pass**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS, including `CoordinatorAgentStatus.test.ts passed`.

---

### Task 4: Replace the panel rendering with the selectable session list

**Files:**
- Modify: `src/components/CoordinatorAgentStatus.tsx`

- [ ] **Step 1: Replace `CoordinatorTaskPanel` render internals**

In `src/components/CoordinatorAgentStatus.tsx`, replace the `visibleTasks`, `hasTasks`, and returned JSX section in `CoordinatorTaskPanel()` with this implementation:

```tsx
  const visibleTasks = getVisibleAgentTasks(tasks)
  const hasTasks = visibleTasks.some(task => task.type === 'local_agent')

  // 1s tick: re-render for elapsed time + evict tasks past their deadline.
  // The eviction deletes from prev.tasks, which makes useCoordinatorTaskCount
  // (and other consumers) see the updated count without their own tick.
  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!hasTasks) return
    const interval = setInterval(
      (tasksRef, setAppState, setTick) => {
        const now = Date.now()
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState)
          }
        }
        setTick((prev: number) => prev + 1)
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    )
    return () => clearInterval(interval)
  }, [hasTasks, setAppState])

  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>()
    for (const [n, id] of agentNameRegistry) inv.set(id, n)
    return inv
  }, [agentNameRegistry])

  if (visibleTasks.length === 0) {
    return null
  }

  const rows = getCoordinatorSessionRows({
    tasks,
    selectedIndex,
    viewingAgentTaskId,
    nameByAgentId,
  })

  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Text dimColor>Sessions / background work</Text>
      {rows.map(row => (
        <SessionRow
          key={row.id}
          row={row}
          onClick={() => {
            if (row.kind === 'main') {
              exitTeammateView(setAppState)
            } else if (row.kind === 'agent' && row.taskId) {
              enterTeammateView(row.taskId, setAppState)
            } else if (row.kind === 'workflow' && row.taskId) {
              onOpenTasksDialog?.(row.taskId)
            }
          }}
        />
      ))}
    </Box>
  )
```

- [ ] **Step 2: Replace `MainLine` and `AgentLine` with `SessionRow`**

Delete the existing `MainLine` and `AgentLine` components from `src/components/CoordinatorAgentStatus.tsx`, then add this component in their place:

```tsx
function SessionRow({
  row,
  onClick,
}: {
  row: CoordinatorSessionRow
  onClick: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)
  const active = row.selected || hover
  const prefix = active ? `${figures.pointer} ` : '  '
  const maxLabelWidth = Math.max(12, Math.min(36, columns - 46))
  const label = row.label.length > maxLabelWidth
    ? `${row.label.slice(0, Math.max(0, maxLabelWidth - 1))}…`
    : row.label.padEnd(maxLabelWidth)
  const meta = row.meta ? ` ${row.meta}` : ''
  const status = row.statusText ? ` ${row.statusText}` : ''
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text dimColor={!active && !row.viewed} bold={row.viewed || active}>
        {prefix}
        {row.icon} {label}
        {meta}
        {status}
      </Text>
    </Box>
  )
}
```

- [ ] **Step 3: Run lint on the modified component**

Run:

```bash
npx eslint src/components/CoordinatorAgentStatus.tsx src/components/CoordinatorAgentStatus.test.ts
```

Expected: exit 0 or only pre-existing warnings unrelated to these files. There should be no unused `wrapText`, `stringWidth`, `PLAY_ICON`, or old component props warnings; remove any unused imports if ESLint reports them.

- [ ] **Step 4: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 5: Preserve keyboard context switching behavior

**Files:**
- Modify: `src/components/PromptInput/PromptInput.tsx`

- [ ] **Step 1: Inspect the existing Enter and close handlers**

Confirm that `footer:openSelected` still contains this behavior:

```ts
if (selectedTask?.type === 'local_agent') {
  enterTeammateView(selectedTask.id, setAppState)
} else if (selectedTask?.type === 'local_workflow') {
  setShowBashesDialog(selectedTask.id)
  selectFooterItem(null)
}
```

Confirm that `footer:close` still opens workflow detail instead of dismissing workflows:

```ts
if (task.type === 'local_workflow') {
  setShowBashesDialog(task.id)
  selectFooterItem(null)
  return
}
```

- [ ] **Step 2: If either block differs, restore it exactly**

Use `Edit` to restore the two snippets above. Do not change unrelated navigation code.

- [ ] **Step 3: Run targeted lint**

Run:

```bash
npx eslint src/components/PromptInput/PromptInput.tsx src/components/CoordinatorAgentStatus.tsx
```

Expected: exit 0 or only pre-existing warnings in `PromptInput.tsx`; no new unused variables from the session-list work.

---

### Task 6: Build and tmux-verify the interactive flow

**Files:**
- No source changes unless verification reveals a root-cause bug.

- [ ] **Step 1: Build with the documented command**

Run:

```bash
CLAUDE_CODE_VERSION=2.1.165-dev pnpm build
```

Expected: build completes and writes `dist/cli.js`.

- [ ] **Step 2: Launch local TUI with tmux using the documented start command**

Run:

```bash
tmux new-session -d -s workflow-session-list-local 'pnpm start -- --permission-mode bypassPermissions --debug-file /tmp/workflow-session-list-local.log'
sleep 5
tmux capture-pane -pt workflow-session-list-local -S -160
```

Expected: TUI prompt is visible. If onboarding/trust prompts appear, answer them through `tmux send-keys`; do not bypass by calling internal functions.

- [ ] **Step 3: Launch a workflow through the TUI**

Create the prompt file:

```bash
cat > /tmp/workflow-session-list-smoke.txt <<'EOF'
Run a minimal dynamic workflow using the Workflow tool from this interactive tmux session. Use this script exactly:

export const meta = {
  name: 'session-list-smoke',
  description: 'Smoke workflow for selectable session list',
  phases: [{ title: 'Run' }],
}
phase('Run')
const result = await agent('Reply with exactly SESSION_LIST_WORKFLOW_OK and do not use tools.', { label: 'session-list-smoke', phase: 'Run' })
return { result }

After it launches, report only the Task ID and Run ID.
EOF
```

Paste and submit it:

```bash
tmux load-buffer -b wsl_prompt /tmp/workflow-session-list-smoke.txt
tmux paste-buffer -t workflow-session-list-local -b wsl_prompt
tmux send-keys -t workflow-session-list-local C-m
sleep 30
tmux capture-pane -pt workflow-session-list-local -S -260
```

Expected: local TUI reports a workflow Task ID and Run ID, and the session list shows a `workflow session-list-smoke` row with non-zero token count after completion.

- [ ] **Step 4: Verify keyboard navigation and context switching**

Use tmux key sends:

```bash
tmux send-keys -t workflow-session-list-local Up
sleep 1
tmux capture-pane -pt workflow-session-list-local -S -120
tmux send-keys -t workflow-session-list-local Down
sleep 1
tmux capture-pane -pt workflow-session-list-local -S -120
tmux send-keys -t workflow-session-list-local C-m
sleep 2
tmux capture-pane -pt workflow-session-list-local -S -180
```

Expected:
- `❯` moves between rows.
- Enter on `main` returns to main context.
- Enter on an agent row enters teammate/agent context.
- Enter on a workflow row opens the workflow detail dialog.

- [ ] **Step 5: Run the full verification set**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
npm run build
```

Expected: both commands pass. `npm run build` may use the default dev version, so it only verifies compilation; tmux verification above verifies the documented debug launch flow.

---

## Self-review checklist

- Spec coverage: Task 1 covers `CLAUDE.md`; Tasks 3-5 replace the current task panel with a selectable list and preserve main/agent/workflow switching; Task 2 fixes workflow token display parity; Task 6 verifies through tmux with the documented commands.
- Placeholder scan: No TODO/TBD placeholders remain. Every code-changing step includes concrete code or exact snippets.
- Type consistency: The plan consistently uses `CoordinatorSessionRow`, `getCoordinatorSessionRows`, `LocalWorkflowTaskState`, `LocalAgentTaskState`, `coordinatorTaskIndex`, and existing task IDs as the selection bridge.
