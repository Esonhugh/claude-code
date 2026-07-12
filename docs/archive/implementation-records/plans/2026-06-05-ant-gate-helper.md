# Default-True Ant Gate Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recovered inline ant/external literal gates with a centralized `isAnt()` helper that defaults to `true`.

**Architecture:** Add a tiny `src/utils/userType.ts` helper and migrate the exact literal gate pattern to `isAnt()` / `!isAnt()`. Keep the migration mechanical and avoid changing surrounding behavior, feature flags, or runtime `process.env.USER_TYPE` checks.

**Tech Stack:** TypeScript, React/Ink components, Node.js, existing `src/*` TypeScript path alias, pnpm validation scripts.

---

## File structure

- Create: `src/utils/userType.ts`
  - Owns the default-true ant classification helper.
- Modify: 54 tracked `src/` files that currently contain the target literal gate.
  - Add `import { isAnt } from 'src/utils/userType.js'` where needed.
  - Replace `("external" as string) === 'ant'` with `isAnt()`.
  - Replace `("external" as string) !== 'ant'` with `!isAnt()`.
- Do not modify: `process.env.USER_TYPE === 'ant'` or `process.env.USER_TYPE !== 'ant'` checks.
- Do not modify: existing docs under `docs/superpowers/specs/` or `docs/superpowers/plans/` except this plan.

## Target files to migrate

```text
src/buddy/useBuddyNotification.tsx
src/commands/chrome/chrome.tsx
src/commands/mcp/mcp.tsx
src/commands/plugin/PluginSettings.tsx
src/commands/terminalSetup/terminalSetup.tsx
src/commands/thinkback/thinkback.tsx
src/commands/ultraplan.tsx
src/components/agents/ToolSelector.tsx
src/components/AutoModeOptInDialog.tsx
src/components/ConsoleOAuthFlow.tsx
src/components/ContextVisualization.tsx
src/components/CoordinatorAgentStatus.tsx
src/components/DevBar.tsx
src/components/Feedback.tsx
src/components/FeedbackSurvey/FeedbackSurvey.tsx
src/components/FeedbackSurvey/useMemorySurvey.tsx
src/components/HelpV2/HelpV2.tsx
src/components/InterruptedByUser.tsx
src/components/LogoV2/feedConfigs.tsx
src/components/LogoV2/LogoV2.tsx
src/components/LogSelector.tsx
src/components/MemoryUsageIndicator.tsx
src/components/messages/AssistantToolUseMessage.tsx
src/components/messages/AttachmentMessage.tsx
src/components/messages/SystemTextMessage.tsx
src/components/MessageSelector.tsx
src/components/NativeAutoUpdater.tsx
src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx
src/components/permissions/SandboxPermissionRequest.tsx
src/components/PromptInput/IssueFlagBanner.tsx
src/components/PromptInput/PromptInput.tsx
src/components/PromptInput/PromptInputFooter.tsx
src/components/PromptInput/PromptInputFooterLeftSide.tsx
src/components/PromptInput/PromptInputHelpMenu.tsx
src/components/PromptInput/PromptInputModeIndicator.tsx
src/components/Settings/Config.tsx
src/components/Settings/Settings.tsx
src/components/Spinner.tsx
src/components/Stats.tsx
src/components/tasks/BackgroundTaskStatus.tsx
src/components/tasks/taskStatusUtils.tsx
src/hooks/useCanUseTool.tsx
src/hooks/useChromeExtensionNotification.tsx
src/hooks/usePromptsFromClaudeInChrome.tsx
src/main.tsx
src/screens/REPL.tsx
src/state/AppState.tsx
src/tools/AgentTool/AgentTool.tsx
src/tools/AgentTool/UI.tsx
src/tools/TaskOutputTool/TaskOutputTool.tsx
src/tools/TaskStopTool/UI.tsx
src/utils/autoRunIssue.tsx
src/utils/processUserInput/processSlashCommand.tsx
src/utils/status.tsx
```

---

### Task 1: Add the default-true helper

**Files:**
- Create: `src/utils/userType.ts`

- [ ] **Step 1: Write the helper file**

Create `src/utils/userType.ts` with exactly:

```ts
export function isAnt(): boolean {
  return true
}
```

- [ ] **Step 2: Verify the helper typechecks by itself**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: either no TypeScript errors, or only pre-existing errors unrelated to `src/utils/userType.ts`. If there is an error involving `src/utils/userType.ts`, fix it before continuing.

- [ ] **Step 3: Commit the helper if committing is authorized**

Only run this step if the user explicitly asked for commits in the implementation session.

```bash
git add src/utils/userType.ts
git commit -m "feat: add default ant gate helper"
```

Expected: a new commit containing only `src/utils/userType.ts`.

---

### Task 2: Migrate low-density files first

**Files:**
- Modify files with one or two target checks from the target file list.

- [ ] **Step 1: Confirm the low-density target set**

Run:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- src | cut -d: -f1 | sort | uniq -c | sort -n
```

Expected: output lists files by target-check count. Start with files showing `1` or `2`.

- [ ] **Step 2: Add the import to each low-density file**

For each low-density file that does not already import `isAnt`, add:

```ts
import { isAnt } from 'src/utils/userType.js'
```

Follow the file's existing import style. Do not reorder ant-only marker comments or special import blocks.

- [ ] **Step 3: Replace positive checks**

In the low-density files, replace every exact expression:

```ts
("external" as string) === 'ant'
```

with:

```ts
isAnt()
```

- [ ] **Step 4: Replace negative checks**

In the low-density files, replace every exact expression:

```ts
("external" as string) !== 'ant'
```

with:

```ts
!isAnt()
```

- [ ] **Step 5: Preserve local boolean variable names where useful**

If a file currently has a local variable like:

```ts
const isAnt = ("external" as string) === 'ant'
```

replace it with a direct call or rename the local variable to avoid shadowing the imported helper:

```ts
const antEnabled = isAnt()
```

Then update references in that file from `isAnt` to `antEnabled`.

- [ ] **Step 6: Run targeted grep for migrated low-density files**

Run this command, replacing the file list with the files edited in this task:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- path/to/edited-file.tsx path/to/edited-file.ts
```

Expected: no matches in files edited by this task.

- [ ] **Step 7: Run TypeScript validation**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: no new errors from imported `isAnt`, duplicate identifiers, or hook ordering.

- [ ] **Step 8: Commit the low-density migration if committing is authorized**

Only run this step if the user explicitly asked for commits in the implementation session.

```bash
git add src
git commit -m "refactor: migrate low-density ant gates"
```

Expected: a focused commit containing helper imports and literal gate replacements in low-density files.

---

### Task 3: Migrate medium-density files

**Files:**
- Modify files with three to seven target checks:
  - `src/commands/chrome/chrome.tsx`
  - `src/components/ContextVisualization.tsx`
  - `src/components/HelpV2/HelpV2.tsx`
  - `src/components/LogoV2/feedConfigs.tsx`
  - `src/components/PromptInput/PromptInput.tsx`
  - `src/components/PromptInput/PromptInputFooterLeftSide.tsx`
  - `src/tools/AgentTool/AgentTool.tsx`
  - `src/tools/AgentTool/UI.tsx`
  - `src/utils/processUserInput/processSlashCommand.tsx`

- [ ] **Step 1: Add imports**

Add this import to each medium-density file that uses the migrated gate:

```ts
import { isAnt } from 'src/utils/userType.js'
```

If a file uses relative imports only and has no `src/*` imports, the path alias is still valid because `tsconfig.json` maps `src/*` to `./src/*`.

- [ ] **Step 2: Replace exact target checks**

In these files, make only these replacements:

```ts
("external" as string) === 'ant'
```

becomes:

```ts
isAnt()
```

and:

```ts
("external" as string) !== 'ant'
```

becomes:

```ts
!isAnt()
```

- [ ] **Step 3: Resolve local identifier conflicts**

If any file defines a local `isAnt` variable, do not import a function with the same name into that scope. Use this pattern instead:

```ts
import { isAnt as getIsAnt } from 'src/utils/userType.js'

const antEnabled = getIsAnt()
```

Prefer the normal `isAnt` import unless there is an actual local conflict.

- [ ] **Step 4: Pay special attention to React hook gates**

Inspect files where the gate appears before hook calls. For `src/components/MemoryUsageIndicator.tsx`, keep the early return shape:

```ts
if (!isAnt()) {
  return null
}
```

Do not move hooks above the gate in this migration.

- [ ] **Step 5: Verify target checks are gone from medium-density files**

Run:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- src/commands/chrome/chrome.tsx src/components/ContextVisualization.tsx src/components/HelpV2/HelpV2.tsx src/components/LogoV2/feedConfigs.tsx src/components/PromptInput/PromptInput.tsx src/components/PromptInput/PromptInputFooterLeftSide.tsx src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/UI.tsx src/utils/processUserInput/processSlashCommand.tsx
```

Expected: no matches.

- [ ] **Step 6: Run TypeScript validation**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: no new import, duplicate identifier, or type errors.

- [ ] **Step 7: Commit the medium-density migration if committing is authorized**

Only run this step if the user explicitly asked for commits in the implementation session.

```bash
git add src
git commit -m "refactor: migrate medium-density ant gates"
```

Expected: a focused commit containing helper imports and literal gate replacements in medium-density files.

---

### Task 4: Migrate high-density files

**Files:**
- Modify:
  - `src/screens/REPL.tsx`
  - `src/main.tsx`
  - `src/components/LogoV2/LogoV2.tsx`

- [ ] **Step 1: Add imports**

Add this import to each high-density file:

```ts
import { isAnt } from 'src/utils/userType.js'
```

Use the existing import area. In `src/components/LogoV2/LogoV2.tsx`, do not disturb the conditional `require()` block around feature-gated modules.

- [ ] **Step 2: Replace exact target checks in `src/screens/REPL.tsx`**

Replace:

```ts
("external" as string) === 'ant'
```

with:

```ts
isAnt()
```

Replace:

```ts
("external" as string) !== 'ant'
```

with:

```ts
!isAnt()
```

Do not change `process.env.USER_TYPE` checks in this file.

- [ ] **Step 3: Replace exact target checks in `src/main.tsx`**

Apply the same replacements in `src/main.tsx`:

```ts
("external" as string) === 'ant'
```

becomes:

```ts
isAnt()
```

and:

```ts
("external" as string) !== 'ant'
```

becomes:

```ts
!isAnt()
```

Do not change adjacent auth, subscription, GrowthBook, or environment checks.

- [ ] **Step 4: Replace exact target checks in `src/components/LogoV2/LogoV2.tsx`**

Apply the same replacements in `src/components/LogoV2/LogoV2.tsx`.

Keep existing feature-gated module loading logic intact:

```ts
const ChannelsNoticeModule =
  feature('KAIROS') || feature('KAIROS_CHANNELS')
    ? (require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js'))
    : null
```

- [ ] **Step 5: Verify target checks are gone from high-density files**

Run:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- src/screens/REPL.tsx src/main.tsx src/components/LogoV2/LogoV2.tsx
```

Expected: no matches.

- [ ] **Step 6: Run TypeScript validation**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: no new errors from the high-density migration.

- [ ] **Step 7: Commit the high-density migration if committing is authorized**

Only run this step if the user explicitly asked for commits in the implementation session.

```bash
git add src
git commit -m "refactor: migrate high-density ant gates"
```

Expected: a focused commit containing helper imports and literal gate replacements in high-density files.

---

### Task 5: Run whole-repository validation

**Files:**
- Verify all migrated source files.
- No source changes expected unless validation identifies a concrete issue.

- [ ] **Step 1: Verify no target literal gates remain under `src/`**

Run:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- src
```

Expected: no output.

- [ ] **Step 2: Verify the helper is used**

Run:

```bash
git grep -n -e 'isAnt()' -- src | wc -l
```

Expected: a non-zero count. The count should be close to the original 138 target checks, with small differences allowed where local variables such as `const antEnabled = isAnt()` replace multiple downstream uses.

- [ ] **Step 3: Verify runtime `USER_TYPE` checks were not mass-migrated**

Run:

```bash
git grep -n -e 'process.env.USER_TYPE === '\''ant'\''' -e 'process.env.USER_TYPE !== '\''ant'\''' -- src scripts | wc -l
```

Expected: runtime checks still exist. This confirms the migration stayed within the literal-gate scope.

- [ ] **Step 4: Run TypeScript**

Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

Expected: no TypeScript errors.

- [ ] **Step 5: Build the CLI**

Run:

```bash
pnpm build
```

Expected: build completes and writes `dist/cli.js`.

- [ ] **Step 6: Run lint**

Run:

```bash
pnpm lint
```

Expected: no lint errors. If lint reports import-order issues, fix only import ordering in files touched by this migration.

- [ ] **Step 7: Run missing import audit**

Run:

```bash
pnpm audit:missing
```

Expected: zero missing runtime imports/assets.

- [ ] **Step 8: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 9: Smoke-test the built CLI**

Run:

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

Expected: both commands exit successfully.

- [ ] **Step 10: Commit validation fixes if committing is authorized**

Only run this step if the user explicitly asked for commits in the implementation session and validation required additional source fixes.

```bash
git add src
git commit -m "fix: resolve ant gate migration validation issues"
```

Expected: a focused commit containing only validation-driven fixes.

---

## Self-review checklist

- Spec coverage: Tasks add the helper, migrate the target literal checks, avoid runtime `USER_TYPE` checks, and run required validation.
- Placeholder scan: The plan contains no placeholder markers or unspecified implementation steps.
- Type consistency: The helper is consistently named `isAnt()` and exported from `src/utils/userType.ts`.
- Scope check: This is one focused migration, not a redesign of the full feature-flag system.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-ant-gate-helper.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
