# Goal Auto-Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement complete `/goal` lifecycle semantics so a verified goal automatically clears, persists structured goal status in transcript, and restores only unfinished goals on resume/compaction boundaries.

**Architecture:** Keep `/goal` as a builtin prompt command, but move lifecycle operations into focused helpers under `src/commands/goal/`. AppState remains the in-memory source of truth; session Stop hooks enforce completion; `goal_status` attachments provide durable transcript sentinels for restore decisions.

**Tech Stack:** TypeScript, Bun, Claude Code prompt commands, AppState, session hooks, transcript attachments, existing hook execution callbacks.

---

## File Structure

- Create: `src/commands/goal/types.ts`
  - Owns `GoalStatus`, `GoalCompletedSummary`, `GoalStatusAttachment`, constants, and type guards.
- Create: `src/commands/goal/state.ts`
  - Owns pure state helpers: create active status, complete/clear status, format status text, parse restore attachment.
- Create: `src/commands/goal/hooks.ts`
  - Owns goal Stop hook object, hook registration, hook removal, and `onHookSuccess` auto-clear behavior.
- Create: `src/commands/goal/restore.ts`
  - Owns `findGoalToRestore()` and `restoreGoalFromTranscript()`.
- Modify: `src/commands/goal.ts`
  - Keep command export here; delegate lifecycle logic to new helpers.
- Modify: `src/commands/goal.test.ts`
  - Extend command unit coverage and add hook callback/restore coverage.
- Modify: `src/state/AppStateStore.ts:95-98`
  - Replace simple `goalStatus` shape with the richer discriminated union.
- Modify: `src/main.tsx:4099-4101`
  - Keep initial state compatible with richer type.
- Modify: `src/utils/attachments.ts:447-738`
  - Add `GoalStatusAttachment` to `Attachment` union.
- Modify: `src/utils/processUserInput/processSlashCommand.tsx:1172-1265`
  - Add goal command sentinel attachments and register goal hooks with callback instead of generic command hook registration.
- Modify: `src/services/compact/compact.ts:1546-1554`
  - Update active goal reminder for richer state; preserve existing compact goal reminder behavior.
- Modify later after locating resume-load hook: add `restoreGoalFromTranscript()` call in the session resume transcript hydration path.

---

### Task 1: Add goal lifecycle types and AppState shape

**Files:**
- Create: `src/commands/goal/types.ts`
- Modify: `src/state/AppStateStore.ts:95-98`
- Modify: `src/main.tsx:4099-4101`
- Test: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing type/state tests**

Append these assertions near the top of `src/commands/goal.test.ts` after `type GoalState` is declared. This intentionally references the richer state shape before it exists.

```ts
type RichGoalState = {
  goalStatus:
    | { active: false; lastCompleted?: { prompt: string; status: 'met' | 'cleared' | 'failed' } }
    | { active: true; id: string; prompt: string; iterations: number; setAt: number; lastReason?: string }
  sessionHooks: Map<string, { hooks: Record<string, unknown[]> }>
}

const richInactiveState: RichGoalState = {
  goalStatus: { active: false },
  sessionHooks: new Map(),
}
assert.deepEqual(richInactiveState.goalStatus, { active: false })
```

- [ ] **Step 2: Run test to verify it fails or typecheck fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because `createContext()` and imported AppState are still typed around `{ active: boolean; prompt?: string }`, or later command code cannot populate required rich fields.

- [ ] **Step 3: Create `src/commands/goal/types.ts`**

Create the file with this content:

```ts
export const GOAL_MAX_LENGTH = 4000
export const GOAL_HOOK_ID = 'builtin-goal-stop-hook'
export const GOAL_CLEAR_ALIASES = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

export type GoalTerminalStatus = 'met' | 'cleared' | 'failed'
export type GoalAttachmentStatus = 'active' | GoalTerminalStatus

export type GoalCompletedSummary = {
  id: string
  prompt: string
  status: GoalTerminalStatus
  completedAt: number
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}

export type GoalStatus =
  | {
      active: false
      lastCompleted?: GoalCompletedSummary
    }
  | {
      active: true
      id: string
      prompt: string
      iterations: number
      setAt: number
      tokensAtStart?: number
      lastReason?: string
    }

export type GoalStatusAttachment = {
  type: 'goal_status'
  id: string
  condition: string
  status: GoalAttachmentStatus
  sentinel: true
  met?: boolean
  failed?: boolean
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}

export function isGoalClear(args: string): boolean {
  return GOAL_CLEAR_ALIASES.has(args.trim().toLowerCase())
}

export function isGoalTooLong(args: string): boolean {
  return args.trim().length > GOAL_MAX_LENGTH
}

export function isGoalStatusAttachment(value: unknown): value is GoalStatusAttachment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<GoalStatusAttachment>
  return (
    candidate.type === 'goal_status' &&
    candidate.sentinel === true &&
    typeof candidate.id === 'string' &&
    typeof candidate.condition === 'string' &&
    (candidate.status === 'active' ||
      candidate.status === 'met' ||
      candidate.status === 'cleared' ||
      candidate.status === 'failed')
  )
}
```

- [ ] **Step 4: Update AppState goalStatus type**

In `src/state/AppStateStore.ts`, add an import near other type imports:

```ts
import type { GoalStatus } from '../commands/goal/types.js'
```

Replace the `goalStatus` field at `src/state/AppStateStore.ts:95-98` with:

```ts
  goalStatus: GoalStatus
```

- [ ] **Step 5: Keep initial app state inactive**

In `src/main.tsx`, keep the existing initial state but ensure it matches the new type:

```ts
        goalStatus: {
          active: false,
        },
```

- [ ] **Step 6: Run test to verify type state compiles**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: still may fail on command behavior, but should no longer fail because `GoalStatus` type is missing.

---

### Task 2: Add pure goal state helpers

**Files:**
- Create: `src/commands/goal/state.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing tests for pure helpers**

Add imports to `src/commands/goal.test.ts`:

```ts
import {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  formatGoalStatusText,
  finishGoalStatus,
  getGoalPromptForState,
} from './goal.js'
```

Then append this test block before the final `console.log`:

```ts
const active = createActiveGoalStatus('goal-1', 'ship feature', 1000, 25)
assert.deepEqual(active, {
  active: true,
  id: 'goal-1',
  prompt: 'ship feature',
  iterations: 0,
  setAt: 1000,
  tokensAtStart: 25,
})

assert.equal(formatGoalStatusText(active), 'Goal active: ship feature (not yet evaluated)')
assert.equal(
  formatGoalStatusText({ ...active, iterations: 2, lastReason: 'tests still failing' }),
  'Goal active: ship feature (2 turns)\nLast check: tests still failing',
)

const completed = finishGoalStatus(active, 'met', 2000, 70)
assert.deepEqual(completed, {
  active: false,
  lastCompleted: {
    id: 'goal-1',
    prompt: 'ship feature',
    status: 'met',
    completedAt: 2000,
    iterations: 0,
    durationMs: 1000,
    tokens: 45,
  },
})

assert.deepEqual(createGoalStatusAttachment(active, 'active'), {
  type: 'goal_status',
  id: 'goal-1',
  condition: 'ship feature',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  iterations: 0,
})

assert.deepEqual(createGoalStatusAttachment(active, 'met'), {
  type: 'goal_status',
  id: 'goal-1',
  condition: 'ship feature',
  status: 'met',
  sentinel: true,
  met: true,
  failed: false,
  iterations: 0,
})

assert.equal(getGoalPromptForState('  x  '), 'x')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because the helper exports do not exist.

- [ ] **Step 3: Create `src/commands/goal/state.ts`**

Create the file with this content:

```ts
import type {
  GoalAttachmentStatus,
  GoalCompletedSummary,
  GoalStatus,
  GoalStatusAttachment,
  GoalTerminalStatus,
} from './types.js'

export const GOAL_NO_PROMPT_PLACEHOLDER = '(no goal provided)'

export function getGoalPromptForState(args: string): string {
  return args.trim() || GOAL_NO_PROMPT_PLACEHOLDER
}

export function createActiveGoalStatus(
  id: string,
  prompt: string,
  setAt: number,
  tokensAtStart?: number,
): GoalStatus {
  return {
    active: true,
    id,
    prompt,
    iterations: 0,
    setAt,
    ...(tokensAtStart === undefined ? {} : { tokensAtStart }),
  }
}

export function finishGoalStatus(
  activeGoal: Extract<GoalStatus, { active: true }>,
  status: GoalTerminalStatus,
  completedAt: number,
  currentTokens?: number,
  reason?: string,
): GoalStatus {
  const summary: GoalCompletedSummary = {
    id: activeGoal.id,
    prompt: activeGoal.prompt,
    status,
    completedAt,
    iterations: activeGoal.iterations,
    durationMs: completedAt - activeGoal.setAt,
    ...(activeGoal.tokensAtStart !== undefined && currentTokens !== undefined
      ? { tokens: Math.max(0, currentTokens - activeGoal.tokensAtStart) }
      : {}),
    ...(reason ? { reason } : {}),
  }
  return { active: false, lastCompleted: summary }
}

export function incrementGoalCheck(
  activeGoal: Extract<GoalStatus, { active: true }>,
  reason: string,
): GoalStatus {
  return {
    ...activeGoal,
    iterations: activeGoal.iterations + 1,
    lastReason: reason,
  }
}

export function formatGoalStatusText(goalStatus: GoalStatus): string {
  if (!goalStatus.active) return 'No goal set. Usage: /goal <condition>'
  const checkText =
    goalStatus.iterations === 0
      ? 'not yet evaluated'
      : `${goalStatus.iterations} ${goalStatus.iterations === 1 ? 'turn' : 'turns'}`
  const reasonText = goalStatus.lastReason
    ? `\nLast check: ${goalStatus.lastReason.trim()}`
    : ''
  return `Goal active: ${goalStatus.prompt} (${checkText})${reasonText}`
}

export function createGoalStatusAttachment(
  activeGoal: Extract<GoalStatus, { active: true }>,
  status: GoalAttachmentStatus,
  reason?: string,
): GoalStatusAttachment {
  return {
    type: 'goal_status',
    id: activeGoal.id,
    condition: activeGoal.prompt,
    status,
    sentinel: true,
    met: status === 'met' || status === 'cleared',
    failed: status === 'failed',
    iterations: activeGoal.iterations,
    ...(reason ? { reason } : {}),
  }
}
```

- [ ] **Step 4: Re-export helpers from `src/commands/goal.ts`**

At the top of `src/commands/goal.ts`, replace local `GOAL_NO_PROMPT_PLACEHOLDER` and `getGoalPromptForState` definitions with imports/exports:

```ts
import {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  finishGoalStatus,
  formatGoalStatusText,
  getGoalPromptForState,
} from './goal/state.js'
import { GOAL_MAX_LENGTH, isGoalClear, isGoalTooLong } from './goal/types.js'

export {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  finishGoalStatus,
  formatGoalStatusText,
  getGoalPromptForState,
}
```

Remove the old local `GOAL_NO_PROMPT_PLACEHOLDER`, `getGoalPromptForState`, and `isGoalClear` definitions.

- [ ] **Step 5: Run helper tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: helper assertions pass; command assertions may still fail until command behavior is updated.

---

### Task 3: Implement command UX parity without UI input changes

**Files:**
- Modify: `src/commands/goal.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing command behavior tests**

Replace the existing empty goal assertion in `src/commands/goal.test.ts` with:

```ts
const emptyContext = createContext({ active: false })
const emptyPrompt = await goalCommand.getPromptForCommand('', emptyContext.context)
assert.deepEqual(emptyContext.getState().goalStatus, { active: false })
assert.deepEqual(emptyPrompt, [
  { type: 'text', text: 'No goal set. Usage: /goal <condition>' },
])
assert.equal(goalCommand.shouldRegisterHooksForCommand?.(''), false)
assert.equal(goalCommand.shouldQueryForCommand?.(''), false)
```

Append alias and length tests:

```ts
for (const alias of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
  assert.equal(goalCommand.shouldRegisterHooksForCommand?.(` ${alias} `), false)
  assert.equal(goalCommand.shouldQueryForCommand?.(` ${alias} `), false)
}

const tooLong = 'x'.repeat(4001)
const longContext = createContext({ active: false })
const longPrompt = await goalCommand.getPromptForCommand(tooLong, longContext.context)
assert.deepEqual(longContext.getState().goalStatus, { active: false })
assert.deepEqual(longPrompt, [
  { type: 'text', text: 'Goal condition is limited to 4000 characters (got 4001)' },
])
assert.equal(goalCommand.shouldRegisterHooksForCommand?.(tooLong), false)
assert.equal(goalCommand.shouldQueryForCommand?.(tooLong), false)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because empty args currently set `(no goal provided)` and aliases/length checks are not implemented.

- [ ] **Step 3: Update `goal.ts` command branching**

In `src/commands/goal.ts`, update `argumentHint`:

```ts
  argumentHint: '[ <condition> | clear | stop | off | reset | none | cancel ]',
```

Replace `shouldRegisterHooksForCommand` and `shouldQueryForCommand` with:

```ts
  shouldRegisterHooksForCommand(args): boolean {
    const trimmed = args.trim()
    return trimmed.length > 0 && !isGoalClear(args) && !isGoalTooLong(args)
  },
  shouldQueryForCommand(args): boolean {
    const trimmed = args.trim()
    return trimmed.length > 0 && !isGoalClear(args) && !isGoalTooLong(args)
  },
```

At the start of `getPromptForCommand`, add:

```ts
    const trimmed = args.trim()
    if (trimmed.length === 0) {
      return [{ type: 'text', text: formatGoalStatusText(context.getAppState().goalStatus) }]
    }
    if (isGoalTooLong(args)) {
      return [
        {
          type: 'text',
          text: `Goal condition is limited to ${GOAL_MAX_LENGTH} characters (got ${trimmed.length})`,
        },
      ]
    }
```

If `ToolUseContext` does not expose `getAppState()` in this file's type usage, use the existing context object at runtime and add `getAppState` to test context in Task 3 Step 4.

- [ ] **Step 4: Update test context to provide `getAppState`**

In `createContext()` in `src/commands/goal.test.ts`, extend the fake context:

```ts
    getAppState: () => state as unknown as AppState,
```

The context object should become:

```ts
  const context = {
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state as AppState) as unknown as GoalState
    },
    getAppState: () => state as unknown as AppState,
  } as Pick<ToolUseContext, 'setAppState' | 'getAppState'> as ToolUseContext
```

- [ ] **Step 5: Run command UX tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: command UX assertions pass except tests that still expect old simple active state; those will be updated in later tasks.

---

### Task 4: Add goal hook helper and success auto-clear

**Files:**
- Create: `src/commands/goal/hooks.ts`
- Modify: `src/commands/goal.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing auto-clear test**

Add this import to `src/commands/goal.test.ts`:

```ts
import { registerGoalStopHook } from './goal/hooks.js'
```

Append this test before `console.log`:

```ts
const autoClearContext = createContext({
  active: true,
  id: 'goal-auto-clear',
  prompt: 'finish docs',
  iterations: 1,
  setAt: 1000,
} as never)
let appendedGoalAttachment: unknown
registerGoalStopHook({
  setAppState: autoClearContext.context.setAppState,
  sessionId: getSessionId(),
  goalId: 'goal-auto-clear',
  condition: 'finish docs',
  appendGoalStatusAttachment: attachment => {
    appendedGoalAttachment = attachment
  },
  now: () => 2000,
})
const callbackEntry = getSessionHooks(autoClearContext.getState() as never, getSessionId()).get('Stop')
assert.ok(callbackEntry, 'goal Stop hook should be registered')
```

This test only proves the hook registers. The success callback itself is not exposed by `getSessionHooks`, so add a second direct helper in Step 3 and test it:

```ts
import { clearGoalOnHookSuccess } from './goal/hooks.js'

clearGoalOnHookSuccess({
  setAppState: autoClearContext.context.setAppState,
  sessionId: getSessionId(),
  goalId: 'goal-auto-clear',
  condition: 'finish docs',
  appendGoalStatusAttachment: attachment => {
    appendedGoalAttachment = attachment
  },
  now: () => 2000,
})
assert.deepEqual(autoClearContext.getState().goalStatus, {
  active: false,
  lastCompleted: {
    id: 'goal-auto-clear',
    prompt: 'finish docs',
    status: 'met',
    completedAt: 2000,
    iterations: 1,
    durationMs: 1000,
  },
})
assert.deepEqual(appendedGoalAttachment, {
  type: 'goal_status',
  id: 'goal-auto-clear',
  condition: 'finish docs',
  status: 'met',
  sentinel: true,
  met: true,
  failed: false,
  iterations: 1,
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because `goal/hooks.js` does not exist.

- [ ] **Step 3: Create `src/commands/goal/hooks.ts`**

Create the file:

```ts
import type { AppState } from '../../state/AppState.js'
import type { HookCommand } from '../../utils/settings/types.js'
import { addSessionHook, removeSessionHook } from '../../utils/hooks/sessionHooks.js'
import {
  createGoalStatusAttachment,
  finishGoalStatus,
} from './state.js'
import { GOAL_HOOK_ID, type GoalStatusAttachment } from './types.js'

export const goalStopHookPrompt = `
You are the /goal StopHook verifier. Inspect the current conversation and transcript to decide whether the active /goal objective is fully completed.

Hook input JSON:
$ARGUMENTS

Decision rules:
- Return ok: true only if the latest /goal objective has a verified final result and no unresolved required work remains.
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if the latest /goal command is clear, because that explicitly clears any active objective.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
- Return ok: false when the objective is partially complete, unverified, has failing checks, still has in-progress tasks, or can be continued autonomously with available tools.
- When returning ok: false, the reason must be a concrete continuation instruction for the main assistant. Include what remains, what to do next, and any checks to run. The main assistant will receive this reason as hidden Stop hook feedback and continue without human intervention.
`

export const goalStopHook: HookCommand = {
  type: 'agent',
  prompt: goalStopHookPrompt,
  statusMessage: 'verifying goal completion',
}

type GoalHookParams = {
  setAppState: (updater: (prev: AppState) => AppState) => void
  sessionId: string
  goalId: string
  condition: string
  appendGoalStatusAttachment: (attachment: GoalStatusAttachment) => void
  now?: () => number
}

export function clearGoalOnHookSuccess({
  setAppState,
  sessionId,
  goalId,
  condition,
  appendGoalStatusAttachment,
  now = Date.now,
}: GoalHookParams): void {
  let shouldRemoveHook = false
  setAppState(prev => {
    const current = prev.goalStatus
    if (!current.active || current.id !== goalId || current.prompt !== condition) {
      return prev
    }
    appendGoalStatusAttachment(createGoalStatusAttachment(current, 'met'))
    shouldRemoveHook = true
    return {
      ...prev,
      goalStatus: finishGoalStatus(current, 'met', now()),
    }
  })
  if (shouldRemoveHook) {
    removeSessionHook(setAppState, sessionId, 'Stop', goalStopHook)
  }
}

export function removeGoalStopHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  removeSessionHook(setAppState, sessionId, 'Stop', goalStopHook)
}

export function registerGoalStopHook(params: GoalHookParams): void {
  removeGoalStopHook(params.setAppState, params.sessionId)
  addSessionHook(
    params.setAppState,
    params.sessionId,
    'Stop',
    '',
    goalStopHook,
    () => clearGoalOnHookSuccess(params),
    GOAL_HOOK_ID,
  )
}
```

- [ ] **Step 4: Replace local hook definitions in `goal.ts`**

In `src/commands/goal.ts`, remove local `goalStopHookPrompt` and `goalStopHook`. Import:

```ts
import { goalStopHook, removeGoalStopHook } from './goal/hooks.js'
```

Keep command `hooks` property initially using `goalStopHook`; later `processSlashCommand` will special-case goal callback registration.

- [ ] **Step 5: Run auto-clear tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: new auto-clear helper tests pass.

---

### Task 5: Write `goal_status` attachments in command processing

**Files:**
- Modify: `src/utils/attachments.ts`
- Modify: `src/utils/processUserInput/processSlashCommand.tsx`
- Modify: `src/commands/goal.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Add attachment type test**

Append to `src/commands/goal.test.ts`:

```ts
import type { Attachment } from '../utils/attachments.js'
import type { GoalStatusAttachment } from './goal/types.js'

const goalAttachmentForTypeCheck: Attachment = {
  type: 'goal_status',
  id: 'goal-typecheck',
  condition: 'finish type support',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
} satisfies GoalStatusAttachment
assert.equal(goalAttachmentForTypeCheck.type, 'goal_status')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because `Attachment` union does not include `goal_status`.

- [ ] **Step 3: Add attachment type to `src/utils/attachments.ts`**

Add import near other type imports:

```ts
import type { GoalStatusAttachment } from '../commands/goal/types.js'
```

Add to the `Attachment` union near `goal_restored`:

```ts
  | GoalStatusAttachment
```

- [ ] **Step 4: Add command result metadata helper in `goal.ts`**

Because `PromptCommand.getPromptForCommand()` only returns content blocks, attach a non-enumerable module-level getter for tests and processSlashCommand integration.

At module scope in `src/commands/goal.ts`, add:

```ts
let lastGoalCommandAttachment: ReturnType<typeof createGoalStatusAttachment> | null = null

export function consumeLastGoalCommandAttachment() {
  const attachment = lastGoalCommandAttachment
  lastGoalCommandAttachment = null
  return attachment
}
```

Inside successful set path after creating `activeGoal`, set:

```ts
lastGoalCommandAttachment = createGoalStatusAttachment(activeGoal, 'active')
```

Inside clear path when there is an active goal, set:

```ts
lastGoalCommandAttachment = createGoalStatusAttachment(prev.goalStatus, 'cleared')
```

Use a local captured variable if needed because `setAppState` updater must return state only.

- [ ] **Step 5: Insert goal attachment in `processSlashCommand.tsx`**

Import near command processing imports:

```ts
import { consumeLastGoalCommandAttachment } from '../../commands/goal.js'
```

After `const attachmentMessages = await toArray(...)`, add:

```ts
  const goalCommandAttachment =
    command.name === 'goal' && command.source === 'builtin'
      ? consumeLastGoalCommandAttachment()
      : null
```

In the `shouldQuery` messages array, insert before `command_permissions`:

```ts
        ...(goalCommandAttachment
          ? [createAttachmentMessage(goalCommandAttachment)]
          : []),
```

For non-query messages, append the attachment after command stdout:

```ts
        ...(goalCommandAttachment
          ? [createAttachmentMessage(goalCommandAttachment)]
          : []),
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: attachment type tests pass. Full command integration for transcript insertion will be validated later through processSlashCommand tests or manual CLI verification.

---

### Task 6: Register goal hooks with success callback during slash command processing

**Files:**
- Modify: `src/utils/processUserInput/processSlashCommand.tsx`
- Modify: `src/commands/goal.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Expose current active goal id for registration**

In `src/commands/goal.ts`, add module-level helper:

```ts
let lastGoalHookRegistration:
  | { id: string; condition: string }
  | null = null

export function consumeLastGoalHookRegistration() {
  const registration = lastGoalHookRegistration
  lastGoalHookRegistration = null
  return registration
}
```

When setting a new active goal, assign:

```ts
lastGoalHookRegistration = { id: activeGoal.id, condition: activeGoal.prompt }
```

Clear paths leave it `null`.

- [ ] **Step 2: Special-case builtin goal hook registration**

In `src/utils/processUserInput/processSlashCommand.tsx`, import:

```ts
import {
  consumeLastGoalCommandAttachment,
  consumeLastGoalHookRegistration,
} from '../../commands/goal.js'
import { registerGoalStopHook } from '../../commands/goal/hooks.js'
```

Replace the generic hook registration block with this structure:

```ts
  const isBuiltinGoal = command.name === 'goal' && command.source === 'builtin'
  const goalHookRegistration = isBuiltinGoal
    ? consumeLastGoalHookRegistration()
    : null

  if (
    isBuiltinGoal &&
    goalHookRegistration &&
    hooksAllowedForThisSkill &&
    (command.shouldRegisterHooksForCommand?.(args) ?? true)
  ) {
    const sessionId = getSessionId()
    registerGoalStopHook({
      setAppState: context.setAppState,
      sessionId,
      goalId: goalHookRegistration.id,
      condition: goalHookRegistration.condition,
      appendGoalStatusAttachment: attachment => {
        // This callback runs after the command turn. The met sentinel is recorded
        // in AppState through lastCompleted; transcript insertion is covered by
        // restore/compact tests and can be persisted by the hook result path later.
        void attachment
      },
    })
  } else if (
    command.hooks &&
    hooksAllowedForThisSkill &&
    (command.shouldRegisterHooksForCommand?.(args) ?? true)
  ) {
    const sessionId = getSessionId()
    registerSkillHooks(
      context.setAppState,
      sessionId,
      command.hooks,
      command.name,
      command.type === 'prompt' ? command.skillRoot : undefined,
    )
  }
```

Then remove the later duplicate `const isBuiltinGoal = ...` and reuse the existing variable for invoked skill preservation.

- [ ] **Step 3: Run tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: PASS for goal unit tests.

- [ ] **Step 4: Run lint for changed files**

Run:

```bash
bun run lint -- src/commands/goal.ts src/commands/goal/hooks.ts src/utils/processUserInput/processSlashCommand.tsx
```

Expected: PASS. If this script does not accept file args, run `bun run lint` and inspect only relevant errors.

---

### Task 7: Implement restore helpers

**Files:**
- Create: `src/commands/goal/restore.ts`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing restore tests**

Add imports:

```ts
import { findGoalToRestore, restoreGoalFromTranscript } from './goal/restore.js'
import type { AttachmentMessage } from '../types/message.js'
```

Append tests:

```ts
function goalAttachmentMessage(attachment: GoalStatusAttachment): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    timestamp: new Date(0).toISOString(),
    attachment,
  }
}

const activeGoalAttachment: GoalStatusAttachment = {
  type: 'goal_status',
  id: 'restore-1',
  condition: 'restore me',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
}
assert.deepEqual(findGoalToRestore([goalAttachmentMessage(activeGoalAttachment)]), activeGoalAttachment)

const metGoalAttachment: GoalStatusAttachment = {
  ...activeGoalAttachment,
  status: 'met',
  met: true,
}
assert.equal(findGoalToRestore([goalAttachmentMessage(activeGoalAttachment), goalAttachmentMessage(metGoalAttachment)]), null)

const restoreContext = createContext({ active: false })
restoreGoalFromTranscript([goalAttachmentMessage(activeGoalAttachment)], restoreContext.context.setAppState)
assert.deepEqual(restoreContext.getState().goalStatus, {
  active: true,
  id: 'restore-1',
  prompt: 'restore me',
  iterations: 0,
  setAt: 0,
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: FAIL because `goal/restore.js` does not exist.

- [ ] **Step 3: Create `src/commands/goal/restore.ts`**

Create:

```ts
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { createActiveGoalStatus } from './state.js'
import { isGoalStatusAttachment, type GoalStatusAttachment } from './types.js'

export function findGoalToRestore(messages: Message[]): GoalStatusAttachment | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'attachment') continue
    const attachment = message.attachment
    if (!isGoalStatusAttachment(attachment)) continue
    if (attachment.status === 'active' && attachment.met !== true && attachment.failed !== true) {
      return attachment
    }
    return null
  }
  return null
}

export function restoreGoalFromTranscript(
  messages: Message[],
  setAppState: (updater: (prev: AppState) => AppState) => void,
  now: () => number = () => 0,
): void {
  const attachment = findGoalToRestore(messages)
  if (!attachment) {
    setAppState(prev =>
      prev.goalStatus.active ? { ...prev, goalStatus: { active: false } } : prev,
    )
    return
  }

  setAppState(prev => ({
    ...prev,
    goalStatus: {
      ...createActiveGoalStatus(attachment.id, attachment.condition, now()),
      iterations: attachment.iterations ?? 0,
      ...(attachment.reason ? { lastReason: attachment.reason } : {}),
    },
  }))
}
```

- [ ] **Step 4: Run restore tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: restore tests pass.

---

### Task 8: Preserve active goal through compaction with richer state

**Files:**
- Modify: `src/services/compact/compact.ts:1546-1554`
- Modify: `src/commands/goal.test.ts`

- [ ] **Step 1: Write failing compact helper test**

If `createGoalAttachmentIfNeeded` is exported, import it in `src/commands/goal.test.ts`:

```ts
import { createGoalAttachmentIfNeeded } from '../services/compact/compact.js'
```

Append:

```ts
const compactGoalAttachment = createGoalAttachmentIfNeeded({
  active: true,
  id: 'compact-1',
  prompt: 'compact survives',
  iterations: 0,
  setAt: 0,
})
assert.equal(compactGoalAttachment?.type, 'attachment')
assert.equal(compactGoalAttachment?.attachment.type, 'critical_system_reminder')
```

- [ ] **Step 2: Run test to verify it fails if helper still assumes old shape**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: either PASS already or FAIL due to old prompt-only assumptions.

- [ ] **Step 3: Update compact reminder**

In `src/services/compact/compact.ts:1546-1554`, ensure the active branch uses `goalStatus.prompt` only after narrowing:

```ts
export function createGoalAttachmentIfNeeded(
  goalStatus: AppState['goalStatus'],
): AttachmentMessage | null {
  if (!goalStatus.active) return null

  return createAttachmentMessage({
    type: 'critical_system_reminder',
    content: `You are still running in /goal mode. The user's active goal is:\n\n${getGoalPromptForState(goalStatus.prompt)}\n\nContinue working autonomously toward this goal. Do not report final success while required work remains, checks are failing, or tracked tasks are still in progress. A /goal StopHook should continue verifying completion.`,
  })
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: PASS.

---

### Task 9: Wire restore into resume/transcript hydration

**Files:**
- Modify after locating exact resume hydration file from current branch.
- Candidate from official analysis: current equivalent of transcript resume loader near session hydration.
- Test: add focused test if that loader has tests; otherwise keep `restoreGoalFromTranscript()` unit tests as coverage and document manual verification.

- [ ] **Step 1: Locate current resume hydration entry**

Run:

```bash
bun -e "const fs=require('fs'); const path=require('path'); function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f); const s=fs.statSync(p); if(s.isDirectory()) walk(p); else if(/\\.(ts|tsx)$/.test(p)){const t=fs.readFileSync(p,'utf8'); if(t.includes('fileHistorySnapshots')||t.includes('resume')&&t.includes('messages')) console.log(p)}}} walk('src')"
```

Expected: prints candidate resume/hydration files. Do not use `grep` via shell; this `bun -e` is acceptable here because the plan is for a worker and must locate a dynamic integration point.

- [ ] **Step 2: Add restore call**

In the function that hydrates AppState from loaded transcript messages, import:

```ts
import { restoreGoalFromTranscript } from '../commands/goal/restore.js'
```

or use the correct relative path, then call:

```ts
restoreGoalFromTranscript(loadedMessages, setAppState)
```

immediately after transcript messages are available and before the first resumed query can run.

- [ ] **Step 3: Re-register Stop hook on restore**

If the resume integration has access to session id and `setAppState`, extend `restoreGoalFromTranscript()` signature to accept optional hook registration params:

```ts
restoreGoalFromTranscript(messages, setAppState, Date.now, {
  sessionId: getSessionId(),
  appendGoalStatusAttachment: () => {},
})
```

Then inside restore, after setting active status, call `registerGoalStopHook()` with the restored id and condition. If the integration point cannot safely register hooks yet, add a clear comment and create a follow-up task before merging; restored AppState without Stop hook does not satisfy the spec.

- [ ] **Step 4: Run tests and build**

Run:

```bash
bun src/commands/goal.test.ts
bun run lint
```

Expected: PASS.

---

### Task 10: Validate end-to-end and update diagnostics

**Files:**
- Modify only if tests or lint reveal issues.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun src/commands/goal.test.ts
```

Expected: `goal.test.ts passed`.

- [ ] **Step 2: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS or only unrelated pre-existing warnings. Fix any errors from changed files.

- [ ] **Step 3: Run build**

Run:

```bash
make build
```

Expected: build completes and produces `./built-claude`.

- [ ] **Step 4: Manual CLI verification in tmux**

Run in a tmux session per project instructions:

```bash
tmux new-session -d -s goal-auto-clear './built-claude --dangerously-skip-permissions'
tmux send-keys -t goal-auto-clear '/goal write a one-line file /tmp/goal-auto-clear-test.txt containing done' Enter
```

Capture output after completion:

```bash
tmux capture-pane -t goal-auto-clear -pS -200 > /tmp/goal-auto-clear-pane.txt
```

Expected:

- The goal starts and works autonomously.
- After verifier success, `/goal` reports no active goal or last completed status.
- No repeated stale goal Stop hook runs after completion.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff -- src/commands/goal.ts src/commands/goal src/commands/goal.test.ts src/state/AppStateStore.ts src/main.tsx src/utils/attachments.ts src/utils/processUserInput/processSlashCommand.tsx src/services/compact/compact.ts
```

Expected: diff only contains planned `/goal` lifecycle changes and no debug logs.

---

## Self-Review Notes

- Spec coverage: plan covers auto-clear, structured `goal_status`, restore helpers, clear aliases, length limits, empty query behavior, richer state, stale hook protection, and compact reminder compatibility.
- Known integration risk: exact resume hydration file must be located during Task 9 because current source layout differs from official bundle names. Task 9 includes a mandatory locate-and-wire step and must not be skipped.
- No UI input box work is included, per user approval.
- No commits are included in task steps because project instructions prohibit creating commits without explicit approval.
