# Goal Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/goal clear` support and show `goal: active` in the status line while a `/goal` objective is active.

**Architecture:** Keep `/goal` as a prompt command, but use AppState as the in-memory source of truth for whether a goal is active. The goal command updates `goalStatus.active`; StatusLine reads that state, appends the visible marker, and passes the same state to custom status line commands.

**Tech Stack:** TypeScript, React/Ink AppState, Claude Code builtin command definitions, existing esbuild-based CLI build.

---

## File Structure

- Modify `src/state/AppStateStore.ts`
  - Add `goalStatus: { active: boolean }` to `AppState`.
  - Add default `goalStatus: { active: false }` in `getDefaultAppState()`.
- Modify `src/main.tsx`
  - Initialize `goalStatus: { active: false }` in the interactive initial AppState object.
- Modify `src/commands/goal.ts`
  - Add `isGoalClear(args)`.
  - Add `goalClearPrompt`.
  - Update `goalStopHookPrompt` with clear behavior.
  - Update `argumentHint` typo.
  - Update `getPromptForCommand(args, context)` to set goal status and branch prompt text.
- Modify `src/components/StatusLine.tsx`
  - Pass `goalActive` into `buildStatusLineCommandInput`.
  - Include `goal: { active: goalActive }` in the status line command input.
  - Append `goal: active` to visible status line text while active.
  - Re-render/update status line when goal active state changes.

---

### Task 1: Implement `/goal clear` and status line marker

**Files:**
- Modify: `src/state/AppStateStore.ts`
- Modify: `src/main.tsx`
- Modify: `src/commands/goal.ts`
- Modify: `src/components/StatusLine.tsx`

- [ ] **Step 1: Run failing source checks for the current missing behavior**

Run:

```bash
grep -n "clearr" src/commands/goal.ts && ! grep -R "goalStatus" -n src/state/AppStateStore.ts src/commands/goal.ts src/components/StatusLine.tsx && ! grep -R "goal: active" -n src/commands/goal.ts src/components/StatusLine.tsx
```

Expected: command exits 0 because `clearr` exists and goal status/marker code does not exist yet.

- [ ] **Step 2: Add AppState goal status**

In `src/state/AppStateStore.ts`, add this field to the `AppState` type near `statusLineText`:

```ts
  goalStatus: {
    active: boolean
  }
```

In the default app state object returned by `getDefaultAppState()`, add:

```ts
    goalStatus: {
      active: false,
    },
```

In `src/main.tsx`, add the same field to the `const initialState: AppState = { ... }` object immediately after `statusLineText: undefined,`:

```ts
        goalStatus: {
          active: false,
        },
```

- [ ] **Step 3: Update the StopHook prompt rule**

In `src/commands/goal.ts`, change this block inside `goalStopHookPrompt`:

```ts
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
```

To:

```ts
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if the latest /goal command is clear, because that explicitly clears any active objective.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
```

- [ ] **Step 4: Add clear detection and clear prompt**

After the existing `goalPrompt` function, add:

```ts
const isGoalClear = (args: string): boolean => args.trim().toLowerCase() === 'clear'

const goalClearPrompt = `
The active /goal objective has been explicitly cleared by the user.

Do not continue any previous /goal objective. Treat the session as having no active autonomous goal.

Report concisely that the goal has been cleared.
`
```

- [ ] **Step 5: Fix argument hint typo**

Change:

```ts
  argumentHint: '[ <condition>｜<clearr> ]',
```

To:

```ts
  argumentHint: '[ <condition> | clear ]',
```

- [ ] **Step 6: Branch prompt generation and update AppState**

Change `getPromptForCommand` from:

```ts
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: goalPrompt(args) }]
  },
```

To:

```ts
  async getPromptForCommand(args, context): Promise<ContentBlockParam[]> {
    const clearGoal = isGoalClear(args)
    context.setAppState(prev => {
      if (prev.goalStatus.active === !clearGoal) return prev
      return { ...prev, goalStatus: { active: !clearGoal } }
    })
    return [{ type: 'text', text: clearGoal ? goalClearPrompt : goalPrompt(args) }]
  },
```

- [ ] **Step 7: Update StatusLine input and visible marker**

In `src/components/StatusLine.tsx`, change `buildStatusLineCommandInput` signature from:

```ts
function buildStatusLineCommandInput(
  permissionMode: PermissionMode,
  exceeds200kTokens: boolean,
  settings: ReadonlySettings,
  messages: Message[],
  addedDirs: string[],
  mainLoopModel: ModelName,
  vimMode?: VimMode,
): StatusLineCommandInput {
```

To:

```ts
function buildStatusLineCommandInput(
  permissionMode: PermissionMode,
  exceeds200kTokens: boolean,
  settings: ReadonlySettings,
  messages: Message[],
  addedDirs: string[],
  mainLoopModel: ModelName,
  goalActive: boolean,
  vimMode?: VimMode,
): StatusLineCommandInput {
```

Add this property to the returned object after `version: MACRO.VERSION,`:

```ts
    goal: {
      active: goalActive,
    },
```

Inside `StatusLineInner`, add:

```ts
  const goalActive = useAppState(s => s.goalStatus.active)
```

Add a ref with the other refs:

```ts
  const goalActiveRef = useRef(goalActive)
  goalActiveRef.current = goalActive
```

Pass the ref value into `buildStatusLineCommandInput` immediately before `vimModeRef.current`:

```ts
        mainLoopModelRef.current,
        goalActiveRef.current,
        vimModeRef.current,
```

Update the effect condition so status line refreshes when goal activity changes:

```ts
      mainLoopModel !== previousStateRef.current.mainLoopModel ||
      goalActive !== previousStateRef.current.goalActive
```

Add `goalActive` to `previousStateRef` state and effect dependencies.

Create visible text before render:

```ts
  const renderedStatusLineText = goalActive
    ? [statusLineText, 'goal: active'].filter(Boolean).join(' ')
    : statusLineText
```

Render `renderedStatusLineText` instead of `statusLineText`.

- [ ] **Step 8: Verify source checks now pass in the opposite direction**

Run:

```bash
! grep -n "clearr" src/commands/goal.ts && grep -R "goalStatus" -n src/state/AppStateStore.ts src/commands/goal.ts src/components/StatusLine.tsx && grep -R "goal: active" -n src/components/StatusLine.tsx && grep -n "latest /goal command is clear" src/commands/goal.ts
```

Expected: command exits 0 and prints matches for `goalStatus`, `goal: active`, and the StopHook clear rule.

- [ ] **Step 9: Build and smoke test command loading**

Run:

```bash
pnpm build
node ./dist/cli.js --help
```

Expected: build exits 0 and help exits 0.

- [ ] **Step 10: Do not commit automatically**

Leave the changes uncommitted unless the user explicitly asks for a commit.
