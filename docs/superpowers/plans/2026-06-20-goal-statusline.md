# Goal Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a bright `Goal is set` footer marker while `/goal` is active, keep goal prompt text out of statusline data, and clear goal status after StopHook-approved completion.

**Architecture:** Keep `AppState.goalStatus` as an active-only flag. `/goal <prompt>` injects the prompt into the model-facing command text but stores only `{ active: true }`; `/goal clear` stores `{ active: false }`. `StatusLine` command input remains `goal: { active }`, while the visible marker is rendered in the prompt footer notification area and cleared by the StopHook pass path.

**Tech Stack:** TypeScript, React Ink, Bun tests, existing Claude Code AppState and StopHook runtime.

## Global Constraints

- Do not add a separate `/goal set` command.
- Do not persist goal status across process restarts.
- Do not expose the goal prompt text to statusline commands.
- Use bun, not npm.
- Use TDD: write failing tests before production changes.
- Do not create git commits without explicit user approval.
- Completion requires focused tests, full `bun test`, `bunx tsc --noEmit --pretty false`, build, and interactive checks.

---

### Task 1: Keep `/goal` AppState Active-Only

**Files:**
- Modify: `src/state/AppStateStore.ts`
- Modify: `src/commands/goal.ts`
- Test: `src/commands/goal.test.ts`

**Interfaces:**
- Produces: `goalStatus: { active: boolean }`
- Produces: `/goal <prompt>` sets active state without storing prompt text; `/goal clear` clears active state.

- [x] **Step 1: Write the failing test**

`src/commands/goal.test.ts` asserts that `/goal <prompt>` and empty `/goal` set only `{ active: true }`, while `/goal clear` sets `{ active: false }`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/goal.test.ts`
Expected before implementation: FAIL because prompt text is still stored in `goalStatus`.

- [x] **Step 3: Write minimal implementation**

Keep `goalPrompt(args)` model-facing behavior unchanged, but change app state writes to only store `{ active: true }` or `{ active: false }`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/goal.test.ts`
Expected: PASS.

### Task 2: Keep StatusLine Input Prompt-Free

**Files:**
- Modify: `src/components/StatusLine.tsx`
- Test: `src/components/StatusLine.test.ts`

**Interfaces:**
- Consumes: `goalStatus: { active: boolean }`
- Produces: statusline command input `goal: { active: boolean }` only.

- [x] **Step 1: Write the failing test**

`src/components/StatusLine.test.ts` calls `buildStatusLineCommandInput()` with a prompt-like goal object and asserts the output is exactly `{ active: true }`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/components/StatusLine.test.ts`
Expected before implementation: FAIL because `goal.prompt` is included.

- [x] **Step 3: Write minimal implementation**

Build the statusline goal input as:

```ts
goal: {
  active: goalStatus.active,
}
```

Remove prompt-sensitive rerender comparisons and any appended `goal: active` statusline text.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/components/StatusLine.test.ts`
Expected: PASS.

### Task 3: Render Bright Footer Goal Marker

**Files:**
- Modify: `src/components/PromptInput/Notifications.tsx`
- Test: `src/components/PromptInput/Notifications.test.tsx`

**Interfaces:**
- Consumes: `useAppState(s => s.goalStatus.active)`
- Produces: `GoalStatusIndicator({ active })` returning bright `Goal is set` text when active and `null` when inactive.

- [x] **Step 1: Write the failing test**

`src/components/PromptInput/Notifications.test.tsx` asserts inactive returns `null`, and active returns a `<Text color="warning" bold wrap="truncate">Goal is set</Text>` element.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/components/PromptInput/Notifications.test.tsx`
Expected before implementation: FAIL because `GoalStatusIndicator` is not exported.

- [x] **Step 3: Write minimal implementation**

Add `GoalStatusIndicator` and render it in `Notifications` after `TokenWarning` using `goalStatus.active`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/components/PromptInput/Notifications.test.tsx`
Expected: PASS.

### Task 4: Clear Goal After StopHook Approval

**Files:**
- Modify: `src/query/stopHooks.ts`
- Test: `src/query/stopHooks.test.ts`

**Interfaces:**
- Consumes: `ToolUseContext.getAppState().goalStatus.active`
- Produces: `clearGoalStatusAfterStopHooksPassForTesting(toolUseContext)` clears active state only after StopHook pass path.

- [x] **Step 1: Write the failing test**

`src/query/stopHooks.test.ts` asserts active state clears to `{ active: false }` and inactive state does not call `setAppState`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test src/query/stopHooks.test.ts`
Expected before implementation: FAIL because helper does not exist.

- [x] **Step 3: Write minimal implementation**

Add the helper and call it immediately before the successful `handleStopHooks` return.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test src/query/stopHooks.test.ts`
Expected: PASS.

### Task 5: Verify and Interactively Check

**Files:**
- No production files unless verification reveals a bug.

**Interfaces:**
- Verifies all prior tasks.

- [ ] **Step 1: Run focused tests**

Run: `bun test src/commands/goal.test.ts src/components/StatusLine.test.ts src/components/PromptInput/Notifications.test.tsx src/query/stopHooks.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit --pretty false`
Expected: PASS.

- [ ] **Step 3: Run full tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Build binary**

Run: `CLAUDE_CODE_VERSION=2.1.165-dev bun package:binary`
Expected: PASS.

- [ ] **Step 5: Run InteractiveTerminal check after compact**

Launch `dist/release/claude-code-v2.1.165-dev-darwin-arm64 --dangerously-skip-permissions` in `InteractiveTerminal`, run `/compact`, then run `/goal <small goal>` and confirm the footer shows `Goal is set` without prompt text. Run `/goal clear` and confirm it disappears. Run a small completing goal and confirm StopHook approval clears the marker.
