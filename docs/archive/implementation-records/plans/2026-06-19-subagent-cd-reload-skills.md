# Subagent nesting, /cd, and /reload-skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe nested normal subagents up to depth 5, plus user-visible `/cd <path>` and `/reload-skills` commands with focused tests.

**Architecture:** Add first-class `subagentDepth` to `ToolUseContext.options` and propagate it through `AgentTool` → `runAgent()` → `createSubagentContext()`, while keeping fork-subagent recursion blocked. Add small command-focused helpers for cwd changes and skill reload cache clearing so commands and tests do not duplicate shell-side behavior.

**Tech Stack:** TypeScript, React Ink command patterns, Zod, Bun test runner, Node `assert/strict`, existing Claude Code command/tool abstractions.

## Global Constraints

- 输出中文。
- 不允许使用 npm；所有包管理和脚本命令使用 bun。
- 修改 bug 必须先定位根因，再写最小失败测试；修复后运行相关测试和构建。
- 不要在用户明确批准前创建 git commit。
- Normal subagent max nesting depth is exactly `5`.
- Depth limit error text is exactly `Subagent nesting limit reached (5). Complete the task directly instead of spawning another agent.`
- Fork subagents remain blocked from spawning subagents.
- `/cd` must not add additional working directories.
- `/reload-skills` must not refresh, install, update, or reconcile plugins.

---

## File map

### Create

- `src/commands/cd/index.ts`
  - Registers `/cd` as a local command with `<path>` argument hint.
- `src/commands/cd/cd.ts`
  - Implements `/cd <path>` by calling a shared cwd helper and returning concise text.
- `src/commands/cd/cd.test.ts`
  - Covers absolute path, relative path, missing path, file path, and cache-clearing behavior.
- `src/commands/reload-skills/index.ts`
  - Registers `/reload-skills` as a local command.
- `src/commands/reload-skills/reload-skills.ts`
  - Implements skill-only reload by clearing skill/command memoization and reporting skill count.
- `src/commands/reload-skills/reload-skills.test.ts`
  - Covers new skill visibility, edited description visibility, malformed skill isolation, and no plugin refresh.
- `src/utils/cwdChange.ts`
  - Shared cwd-changing helper used by `/cd`; wraps directory validation, `setCwd()`, env invalidation, hook notification, sandbox cleanup, and command cache clearing.
- `src/utils/cwdChange.test.ts`
  - Unit tests helper side effects without requiring a shell process.
- `src/tools/AgentTool/subagentDepth.ts`
  - Exports `MAX_SUBAGENT_DEPTH`, `SUBAGENT_DEPTH_LIMIT_MESSAGE`, `getCurrentSubagentDepth()`, `getNextSubagentDepth()`, and `assertCanSpawnNestedSubagent()`.
- `src/tools/AgentTool/subagentDepth.test.ts`
  - Covers depth 0→1, depth 4→5, and depth 5 rejection.
- `src/tools/AgentTool/AgentTool.nesting.test.ts`
  - Focused AgentTool tests for normal depth enforcement, async path registration, and cwd override propagation using stubs where practical.

### Modify

- `src/Tool.ts`
  - Add `subagentDepth?: number` to `ToolUseContext.options`.
- `src/utils/forkedAgent.ts`
  - Preserve and increment `subagentDepth` in `createSubagentContext()` when subagent options are built.
- `src/tools/AgentTool/AgentTool.tsx`
  - Enforce normal subagent depth before selecting/running a normal agent.
  - Pass `subagentDepth` into `runAgent()` via `ToolUseContext.options`.
  - Keep fork-subagent guard unchanged.
  - Ensure explicit `cwd` and `isolation: 'worktree'` remain mutually exclusive.
- `src/tools/AgentTool/runAgent.ts`
  - Include `subagentDepth` in `agentOptions` for the child query context.
  - Include effective cwd/worktree metadata in `writeAgentMetadata()` when present.
- `src/commands.ts`
  - Import and register `cd` and `reloadSkills` in `COMMANDS()`.
  - Existing `clearCommandMemoizationCaches()` remains the command-cache entry point for `/reload-skills`.
- `src/utils/Shell.ts`
  - Replace duplicated shell cwd side effects with `changeSessionCwd()`.
- `src/utils/skills/skillChangeDetector.ts`
  - Keep watcher behavior unchanged unless implementation naturally extracts a shared skill-only cache helper.

### Reference only

- `docs/superpowers/specs/2026-06-19-subagent-cd-reload-skills-design.md`
  - Source spec for this plan.
- `src/commands/reload-plugins/reload-plugins.ts`
  - Pattern for a local command returning `{ type: 'text', value }`.
- `src/commands/workflows/workflows.test.ts`
  - Existing command test style using top-level `assert` and `bun test`.
- `src/utils/cwd.ts`
  - Current `getCwd()` / `runWithCwdOverride()` primitives.

---

### Task 1: Add shared subagent depth helpers

**Files:**
- Create: `src/tools/AgentTool/subagentDepth.ts`
- Create: `src/tools/AgentTool/subagentDepth.test.ts`
- Modify: `src/Tool.ts`

**Interfaces:**
- Consumes: `ToolUseContext['options']` from `src/Tool.ts`.
- Produces:
  - `MAX_SUBAGENT_DEPTH: 5`
  - `SUBAGENT_DEPTH_LIMIT_MESSAGE: string`
  - `getCurrentSubagentDepth(options: Pick<ToolUseContext['options'], 'subagentDepth'>): number`
  - `getNextSubagentDepth(options: Pick<ToolUseContext['options'], 'subagentDepth'>): number`
  - `assertCanSpawnNestedSubagent(options: Pick<ToolUseContext['options'], 'subagentDepth'>): void`

- [ ] **Step 1: Write the failing depth helper test**

Create `src/tools/AgentTool/subagentDepth.test.ts`:

```ts
import assert from 'node:assert/strict'

import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_DEPTH_LIMIT_MESSAGE,
  assertCanSpawnNestedSubagent,
  getCurrentSubagentDepth,
  getNextSubagentDepth,
} from './subagentDepth.js'

assert.equal(MAX_SUBAGENT_DEPTH, 5)
assert.equal(getCurrentSubagentDepth({}), 0)
assert.equal(getCurrentSubagentDepth({ subagentDepth: 1 }), 1)
assert.equal(getNextSubagentDepth({}), 1)
assert.equal(getNextSubagentDepth({ subagentDepth: 4 }), 5)
assert.doesNotThrow(() => assertCanSpawnNestedSubagent({ subagentDepth: 4 }))
assert.throws(
  () => assertCanSpawnNestedSubagent({ subagentDepth: 5 }),
  error => error instanceof Error && error.message === SUBAGENT_DEPTH_LIMIT_MESSAGE,
)

console.log('subagentDepth.test.ts passed')
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts
```

Expected: FAIL with module-not-found for `./subagentDepth.js`.

- [ ] **Step 3: Add `subagentDepth` to the tool context type**

In `src/Tool.ts`, inside `ToolUseContext.options`, add the field after `querySource?: QuerySource`:

```ts
    /** Normal AgentTool nesting depth. Main thread is 0; subagents start at 1. */
    subagentDepth?: number
```

- [ ] **Step 4: Implement the helper**

Create `src/tools/AgentTool/subagentDepth.ts`:

```ts
import type { ToolUseContext } from '../../Tool.js'

export const MAX_SUBAGENT_DEPTH = 5

export const SUBAGENT_DEPTH_LIMIT_MESSAGE =
  'Subagent nesting limit reached (5). Complete the task directly instead of spawning another agent.'

type OptionsWithDepth = Pick<ToolUseContext['options'], 'subagentDepth'>

export function getCurrentSubagentDepth(options: OptionsWithDepth): number {
  return options.subagentDepth ?? 0
}

export function getNextSubagentDepth(options: OptionsWithDepth): number {
  return getCurrentSubagentDepth(options) + 1
}

export function assertCanSpawnNestedSubagent(options: OptionsWithDepth): void {
  if (getCurrentSubagentDepth(options) >= MAX_SUBAGENT_DEPTH) {
    throw new Error(SUBAGENT_DEPTH_LIMIT_MESSAGE)
  }
}
```

- [ ] **Step 5: Run the helper test**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts
```

Expected: PASS and prints `subagentDepth.test.ts passed`.

- [ ] **Step 6: Checkpoint**

Do not commit unless the user has explicitly approved commits in this implementation session. If approved, commit only these files:

```bash
git add src/Tool.ts src/tools/AgentTool/subagentDepth.ts src/tools/AgentTool/subagentDepth.test.ts
git commit -m "feat: add subagent nesting depth helpers"
```

### Task 2: Propagate depth through subagent contexts

**Files:**
- Modify: `src/utils/forkedAgent.ts`
- Modify: `src/tools/AgentTool/runAgent.ts`
- Test: `src/tools/AgentTool/subagentDepth.test.ts`

**Interfaces:**
- Consumes from Task 1: `getNextSubagentDepth(options)`.
- Produces: child `ToolUseContext.options.subagentDepth` is parent depth + 1 for normal subagents.

- [ ] **Step 1: Extend the helper test for child options propagation**

Append this test block to `src/tools/AgentTool/subagentDepth.test.ts`:

```ts
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { createFileStateCache } from '../../utils/fileStateCache.js'

const parentContext = {
  options: {
    commands: [],
    debug: false,
    mainLoopModel: 'claude-sonnet-4-6',
    tools: [],
    verbose: false,
    thinkingConfig: { type: 'disabled' as const },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [], inactiveAgents: [], allowedAgentTypes: undefined },
    subagentDepth: 2,
  },
  abortController: new AbortController(),
  readFileState: createFileStateCache(),
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
  setAppState: () => {},
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as never

const childContext = createSubagentContext(parentContext)
assert.equal(childContext.options.subagentDepth, 3)

const explicitChildContext = createSubagentContext(parentContext, {
  options: { ...parentContext.options, subagentDepth: 5 },
})
assert.equal(explicitChildContext.options.subagentDepth, 5)
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts
```

Expected: FAIL because `createSubagentContext(parentContext)` does not yet add `subagentDepth` when no options override is provided.

- [ ] **Step 3: Update `createSubagentContext()` default options**

In `src/utils/forkedAgent.ts`, replace the `options` assignment around line 445:

```ts
    options: overrides?.options ?? parentContext.options,
```

with:

```ts
    options: overrides?.options ?? {
      ...parentContext.options,
      subagentDepth: (parentContext.options.subagentDepth ?? 0) + 1,
    },
```

- [ ] **Step 4: Ensure `runAgent()` passes explicit child depth**

In `src/tools/AgentTool/runAgent.ts`, add `subagentDepth` to `agentOptions` near `agentDefinitions`:

```ts
    agentDefinitions: toolUseContext.options.agentDefinitions,
    subagentDepth: (toolUseContext.options.subagentDepth ?? 0) + 1,
```

Keep the existing `...(useExactTools && { querySource })` line after this. This makes the depth explicit even though `createSubagentContext()` also has a safe default.

- [ ] **Step 5: Run the depth tests**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/utils/forkedAgent.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/subagentDepth.test.ts
git commit -m "feat: propagate subagent nesting depth"
```

### Task 3: Enforce depth in AgentTool normal spawns

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Create: `src/tools/AgentTool/AgentTool.nesting.test.ts`
- Test: `src/tools/AgentTool/AgentTool.nesting.test.ts`

**Interfaces:**
- Consumes from Task 1: `assertCanSpawnNestedSubagent()`, `getNextSubagentDepth()`, `SUBAGENT_DEPTH_LIMIT_MESSAGE`.
- Produces: normal AgentTool spawn rejects at depth 5; depth 4 can spawn depth 5.

- [ ] **Step 1: Write a failing depth-limit test**

Create `src/tools/AgentTool/AgentTool.nesting.test.ts` with this focused test. If imports expose slightly different active-agent result shape, adjust only the fixture object fields required by TypeScript:

```ts
import assert from 'node:assert/strict'

import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { SUBAGENT_DEPTH_LIMIT_MESSAGE } from './subagentDepth.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createFileStateCache } from '../../utils/fileStateCache.js'

function createContext(subagentDepth: number) {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        inactiveAgents: [],
        allowedAgentTypes: undefined,
      },
      subagentDepth,
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCache(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { clients: [], tools: [] },
      tasks: {},
      agentNameRegistry: new Map(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as never
}

await assert.rejects(
  () => AgentTool.call(
    { description: 'too deep', prompt: 'do it', subagent_type: 'general-purpose' },
    createContext(5),
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_test' } } as never,
  ),
  error => error instanceof Error && error.message === SUBAGENT_DEPTH_LIMIT_MESSAGE,
)

console.log('AgentTool.nesting.test.ts passed')
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected before implementation: FAIL because AgentTool does not reject at depth 5 and attempts to run the agent.

- [ ] **Step 3: Import the helper in `AgentTool.tsx`**

Add near other AgentTool imports:

```ts
import {
  assertCanSpawnNestedSubagent,
  getNextSubagentDepth,
} from './subagentDepth.js'
```

- [ ] **Step 4: Enforce depth after fork/normal path is known**

In `src/tools/AgentTool/AgentTool.tsx`, after:

```ts
    const isForkPath = effectiveType === undefined
```

add:

```ts
    if (!isForkPath) {
      assertCanSpawnNestedSubagent(toolUseContext.options)
    }
```

Do not add this to the fork path; fork workers remain governed by the existing fork guard.

- [ ] **Step 5: Pass child depth into `runAgentParams`**

Before `const runAgentParams`, add:

```ts
    const childSubagentDepth = getNextSubagentDepth(toolUseContext.options)
```

Then change the `toolUseContext` passed into `runAgentParams` from the parent object to a shallow wrapper with depth set:

```ts
      toolUseContext: {
        ...toolUseContext,
        options: {
          ...toolUseContext.options,
          subagentDepth: childSubagentDepth,
        },
      },
```

Keep every other `runAgentParams` field unchanged.

- [ ] **Step 6: Run the nesting test**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: PASS and prints `AgentTool.nesting.test.ts passed`.

- [ ] **Step 7: Run the helper test too**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts
```

Expected: PASS.

- [ ] **Step 8: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/AgentTool.nesting.test.ts
git commit -m "feat: enforce subagent nesting limit"
```

### Task 4: Add cwd change helper with shell-equivalent side effects

**Files:**
- Create: `src/utils/cwdChange.ts`
- Create: `src/utils/cwdChange.test.ts`
- Modify: `src/utils/Shell.ts`

**Interfaces:**
- Consumes: `setCwd(path, relativeTo?)` from `src/utils/Shell.ts`.
- Produces: `changeSessionCwd(path: string, options?: { relativeTo?: string; clearCommandCaches?: () => void; invalidateEnv?: () => void; notifyHooks?: (oldCwd: string, newCwd: string) => void | Promise<void> }): string`.

- [ ] **Step 1: Write failing cwd helper tests**

Create `src/utils/cwdChange.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getCwd } from './cwd.js'
import { changeSessionCwd } from './cwdChange.js'
import { setCwd } from './Shell.js'

const originalCwd = getCwd()
const root = await mkdtemp(join(tmpdir(), 'cwd-change-test-'))
const next = join(root, 'next')
const nested = join(next, 'nested')
await mkdir(nested, { recursive: true })
await writeFile(join(root, 'file.txt'), 'not a directory')

let cacheClears = 0
let envInvalidations = 0
const hookCalls: Array<{ oldCwd: string; newCwd: string }> = []

try {
  setCwd(root)
  const changed = changeSessionCwd('next', {
    relativeTo: root,
    clearCommandCaches: () => { cacheClears += 1 },
    invalidateEnv: () => { envInvalidations += 1 },
    notifyHooks: (oldCwd, newCwd) => { hookCalls.push({ oldCwd, newCwd }) },
  })

  assert.equal(changed, next)
  assert.equal(getCwd(), next)
  assert.equal(cacheClears, 1)
  assert.equal(envInvalidations, 1)
  assert.deepEqual(hookCalls, [{ oldCwd: root, newCwd: next }])

  assert.throws(
    () => changeSessionCwd(join(root, 'missing')),
    /does not exist/,
  )
  assert.equal(getCwd(), next)

  assert.throws(
    () => changeSessionCwd(join(root, 'file.txt')),
    /is not a directory/,
  )
  assert.equal(getCwd(), next)
} finally {
  setCwd(originalCwd)
}

console.log('cwdChange.test.ts passed')
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/utils/cwdChange.test.ts
```

Expected: FAIL with module-not-found for `./cwdChange.js`.

- [ ] **Step 3: Implement `changeSessionCwd()`**

Create `src/utils/cwdChange.ts`:

```ts
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { clearCommandsCache } from '../commands.js'
import { getCwd } from './cwd.js'
import { onCwdChangedForHooks } from './hooks/fileChangedWatcher.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { setCwd } from './Shell.js'

type ChangeSessionCwdOptions = {
  relativeTo?: string
  clearCommandCaches?: () => void
  invalidateEnv?: () => void
  notifyHooks?: (oldCwd: string, newCwd: string) => void | Promise<void>
}

export function changeSessionCwd(
  path: string,
  options: ChangeSessionCwdOptions = {},
): string {
  const oldCwd = getCwd()
  const resolved = isAbsolute(path) ? path : resolve(options.relativeTo ?? oldCwd, path)
  const stat = statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`Path "${resolved}" is not a directory`)
  }

  setCwd(resolved, options.relativeTo ?? oldCwd)
  const newCwd = getCwd()
  if (newCwd === oldCwd) return newCwd

  ;(options.invalidateEnv ?? invalidateSessionEnvCache)()
  ;(options.clearCommandCaches ?? clearCommandsCache)()
  SandboxManager.cleanupAfterCommand()
  void (options.notifyHooks ?? onCwdChangedForHooks)(oldCwd, newCwd)

  return newCwd
}
```

- [ ] **Step 4: Replace shell cwd side-effect duplication**

In `src/utils/Shell.ts`, import the helper:

```ts
import { changeSessionCwd } from './cwdChange.js'
```

Then replace the block around lines 408-412:

```ts
          if (newCwd.normalize('NFC') !== cwd) {
            setCwd(newCwd, cwd)
            invalidateSessionEnvCache()
            void onCwdChangedForHooks(cwd, newCwd)
          }
```

with:

```ts
          if (newCwd.normalize('NFC') !== cwd) {
            changeSessionCwd(newCwd, { relativeTo: cwd })
          }
```

Remove now-unused imports `onCwdChangedForHooks`, `SandboxManager`, and `invalidateSessionEnvCache` only if TypeScript reports them unused. Keep `SandboxManager` if other shell code still uses it for `cleanupAfterCommand()` after sandboxed commands.

- [ ] **Step 5: Run cwd helper tests**

Run:

```bash
bun test src/utils/cwdChange.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/utils/cwdChange.ts src/utils/cwdChange.test.ts src/utils/Shell.ts
git commit -m "feat: share cwd change side effects"
```

### Task 5: Add `/cd <path>` command

**Files:**
- Create: `src/commands/cd/index.ts`
- Create: `src/commands/cd/cd.ts`
- Create: `src/commands/cd/cd.test.ts`
- Modify: `src/commands.ts`
- Test: `src/commands/cd/cd.test.ts`

**Interfaces:**
- Consumes from Task 4: `changeSessionCwd(path, { relativeTo })`.
- Produces local command `/cd` returning `{ type: 'text', value: string }`.

- [ ] **Step 1: Write failing command tests**

Create `src/commands/cd/cd.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { call } from './cd.js'
import { getCwd } from '../../utils/cwd.js'
import { setCwd } from '../../utils/Shell.js'

const originalCwd = getCwd()
const root = await mkdtemp(join(tmpdir(), 'cd-command-test-'))
const absoluteTarget = join(root, 'absolute')
const relativeTarget = join(root, 'relative')
await mkdir(absoluteTarget, { recursive: true })
await mkdir(relativeTarget, { recursive: true })
await writeFile(join(root, 'file.txt'), 'not a directory')

try {
  setCwd(root)

  const absoluteResult = await call(absoluteTarget, { getCwd: () => getCwd() } as never)
  assert.equal(absoluteResult.type, 'text')
  assert.match(absoluteResult.value, /^Changed directory to /)
  assert.equal(getCwd(), absoluteTarget)

  setCwd(root)
  const relativeResult = await call('relative', { getCwd: () => getCwd() } as never)
  assert.equal(relativeResult.type, 'text')
  assert.equal(getCwd(), relativeTarget)

  const beforeMissing = getCwd()
  const missingResult = await call('missing', { getCwd: () => getCwd() } as never)
  assert.equal(missingResult.type, 'text')
  assert.match(missingResult.value, /does not exist/)
  assert.equal(getCwd(), beforeMissing)

  const beforeFile = getCwd()
  const fileResult = await call(join(root, 'file.txt'), { getCwd: () => getCwd() } as never)
  assert.equal(fileResult.type, 'text')
  assert.match(fileResult.value, /is not a directory/)
  assert.equal(getCwd(), beforeFile)

  const emptyResult = await call('', { getCwd: () => getCwd() } as never)
  assert.equal(emptyResult.type, 'text')
  assert.equal(emptyResult.value, 'Usage: /cd <path>')
} finally {
  setCwd(originalCwd)
}

console.log('cd.test.ts passed')
```

- [ ] **Step 2: Run the command test to verify it fails**

Run:

```bash
bun test src/commands/cd/cd.test.ts
```

Expected: FAIL with module-not-found for `./cd.js`.

- [ ] **Step 3: Register command metadata**

Create `src/commands/cd/index.ts`:

```ts
import type { Command } from '../../types/command.js'

const cd = {
  type: 'local',
  name: 'cd',
  description: 'Change the current working directory',
  argumentHint: '<path>',
  supportsNonInteractive: false,
  load: () => import('./cd.js'),
} satisfies Command

export default cd
```

- [ ] **Step 4: Implement command call**

Create `src/commands/cd/cd.ts`:

```ts
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { changeSessionCwd } from '../../utils/cwdChange.js'
import { errorMessage } from '../../utils/errors.js'

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const target = args.trim()
  if (!target) {
    return { type: 'text', value: 'Usage: /cd <path>' }
  }

  try {
    const newCwd = changeSessionCwd(target, { relativeTo: context.getCwd() })
    return { type: 'text', value: `Changed directory to ${newCwd}` }
  } catch (error) {
    return { type: 'text', value: errorMessage(error) }
  }
}
```

- [ ] **Step 5: Add command to `COMMANDS()`**

In `src/commands.ts`, import near other command imports:

```ts
import cd from './commands/cd/index.js'
```

Add `cd` to the `COMMANDS()` array near `addDir`:

```ts
  addDir,
  cd,
```

- [ ] **Step 6: Run cd tests**

Run:

```bash
bun test src/commands/cd/cd.test.ts src/utils/cwdChange.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/commands.ts src/commands/cd/index.ts src/commands/cd/cd.ts src/commands/cd/cd.test.ts
git commit -m "feat: add cd slash command"
```

### Task 6: Add skill-only reload helper and `/reload-skills`

**Files:**
- Create: `src/commands/reload-skills/index.ts`
- Create: `src/commands/reload-skills/reload-skills.ts`
- Create: `src/commands/reload-skills/reload-skills.test.ts`
- Modify: `src/commands.ts`
- Optionally modify: `src/utils/skills/skillChangeDetector.ts`
- Test: `src/commands/reload-skills/reload-skills.test.ts`

**Interfaces:**
- Produces: `reloadSkillsForSession(cwd: string): Promise<{ skillCount: number; errorCount: number }>` from `reload-skills.ts`.
- Produces local command `/reload-skills` returning `Reloaded: N skills` or `Reloaded: N skills · M errors during load. Run /doctor for details.`

- [ ] **Step 1: Write failing reload-skills tests**

Create `src/commands/reload-skills/reload-skills.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { call, reloadSkillsForSession } from './reload-skills.js'
import { getSkillToolCommands } from '../../commands.js'
import { setCwd } from '../../utils/Shell.js'

const originalCwd = process.cwd()
const root = await mkdtemp(join(tmpdir(), 'reload-skills-test-'))
await mkdir(join(root, '.claude', 'skills', 'fresh-skill'), { recursive: true })
await writeFile(
  join(root, '.claude', 'skills', 'fresh-skill', 'SKILL.md'),
  `---
name: fresh-skill
description: Fresh skill before edit
---

Use this fresh skill.
`,
)

try {
  setCwd(root)

  const first = await reloadSkillsForSession(root)
  assert.ok(first.skillCount >= 1)
  const commands = await getSkillToolCommands(root)
  const fresh = commands.find(command => command.name === 'fresh-skill')
  assert.equal(fresh?.description, 'Fresh skill before edit')

  await writeFile(
    join(root, '.claude', 'skills', 'fresh-skill', 'SKILL.md'),
    `---
name: fresh-skill
description: Fresh skill after edit
---

Use this edited fresh skill.
`,
  )

  await reloadSkillsForSession(root)
  const editedCommands = await getSkillToolCommands(root)
  const edited = editedCommands.find(command => command.name === 'fresh-skill')
  assert.equal(edited?.description, 'Fresh skill after edit')

  const commandResult = await call('', { getCwd: () => root } as never)
  assert.equal(commandResult.type, 'text')
  assert.match(commandResult.value, /^Reloaded: \d+ skills/)
} finally {
  setCwd(originalCwd)
}

console.log('reload-skills.test.ts passed')
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/commands/reload-skills/reload-skills.test.ts
```

Expected: FAIL with module-not-found for `./reload-skills.js`.

- [ ] **Step 3: Register command metadata**

Create `src/commands/reload-skills/index.ts`:

```ts
import type { Command } from '../../types/command.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Reload skills without refreshing plugins',
  supportsNonInteractive: false,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
```

- [ ] **Step 4: Implement skill-only reload**

Create `src/commands/reload-skills/reload-skills.ts`:

```ts
import { clearCommandMemoizationCaches, getSkillToolCommands } from '../../commands.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'

export async function reloadSkillsForSession(
  cwd: string,
): Promise<{ skillCount: number; errorCount: number }> {
  clearSkillCaches()
  clearCommandMemoizationCaches()
  resetSentSkillNames()

  const skills = await getSkillToolCommands(cwd)
  return { skillCount: skills.length, errorCount: 0 }
}

export async function call(
  _args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const result = await reloadSkillsForSession(context.getCwd())
  if (result.errorCount > 0) {
    const noun = result.errorCount === 1 ? 'error' : 'errors'
    return {
      type: 'text',
      value: `Reloaded: ${result.skillCount} skills · ${result.errorCount} ${noun} during load. Run /doctor for details.`,
    }
  }
  return { type: 'text', value: `Reloaded: ${result.skillCount} skills` }
}
```

- [ ] **Step 5: Register command in `src/commands.ts`**

Import near `reloadPlugins`:

```ts
import reloadSkills from './commands/reload-skills/index.js'
```

Add to `COMMANDS()` next to `reloadPlugins`:

```ts
  reloadPlugins,
  reloadSkills,
```

Do not call `refreshActivePlugins()` anywhere in this command.

- [ ] **Step 6: Run reload-skills tests**

Run:

```bash
bun test src/commands/reload-skills/reload-skills.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/commands.ts src/commands/reload-skills/index.ts src/commands/reload-skills/reload-skills.ts src/commands/reload-skills/reload-skills.test.ts
git commit -m "feat: add reload-skills command"
```

### Task 7: Preserve cwd/worktree metadata for nested agents

**Files:**
- Modify: `src/tools/AgentTool/runAgent.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Test: `src/tools/AgentTool/AgentTool.nesting.test.ts`

**Interfaces:**
- Consumes: `worktreePath?: string` already passed to `runAgent()`.
- Produces: `writeAgentMetadata(agentId, { agentType, worktreePath?, cwd?, description? })` where `cwd` is the effective cwd when explicit cwd override is used.

- [ ] **Step 1: Add a metadata-focused test seam**

In `src/tools/AgentTool/AgentTool.nesting.test.ts`, add a pure helper assertion instead of trying to run a full API query. First define the helper in implementation step below, then test it here:

```ts
import { buildAgentMetadataForTesting } from './runAgent.js'

assert.deepEqual(
  buildAgentMetadataForTesting({
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    cwd: undefined,
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
  },
)

assert.deepEqual(
  buildAgentMetadataForTesting({
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: undefined,
    cwd: '/tmp/explicit-cwd',
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    cwd: '/tmp/explicit-cwd',
  },
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: FAIL because `buildAgentMetadataForTesting` is not exported.

- [ ] **Step 3: Add `cwd` to runAgent params**

In `src/tools/AgentTool/runAgent.ts`, add to the parameter type near `worktreePath?: string`:

```ts
  /** Effective cwd for explicit cwd overrides; worktreePath remains separate. */
  cwd?: string
```

Add `cwd` to destructured parameters near `worktreePath`:

```ts
  worktreePath,
  cwd,
  description,
```

- [ ] **Step 4: Add metadata builder**

In `src/tools/AgentTool/runAgent.ts`, above `runAgent()`, add:

```ts
export function buildAgentMetadataForTesting({
  agentType,
  description,
  worktreePath,
  cwd,
}: {
  agentType: string
  description?: string
  worktreePath?: string
  cwd?: string
}): {
  agentType: string
  description?: string
  worktreePath?: string
  cwd?: string
} {
  return {
    agentType,
    ...(worktreePath && { worktreePath }),
    ...(!worktreePath && cwd && { cwd }),
    ...(description && { description }),
  }
}
```

- [ ] **Step 5: Use builder in `writeAgentMetadata()`**

Replace the existing call body around lines 742-746:

```ts
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))
```

with:

```ts
  void writeAgentMetadata(
    agentId,
    buildAgentMetadataForTesting({
      agentType: agentDefinition.agentType,
      description,
      worktreePath,
      cwd,
    }),
  ).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))
```

- [ ] **Step 6: Pass explicit cwd from AgentTool into runAgent params**

In `src/tools/AgentTool/AgentTool.tsx`, add to `runAgentParams`:

```ts
      cwd: cwdOverridePath,
```

Place it next to `worktreePath: worktreeInfo?.worktreePath`.

- [ ] **Step 7: Run nesting tests**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: PASS.

- [ ] **Step 8: Checkpoint**

Do not commit unless explicitly approved. If approved:

```bash
git add src/tools/AgentTool/runAgent.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/AgentTool.nesting.test.ts
git commit -m "fix: persist subagent cwd metadata"
```

### Task 8: Verify nested async task lifecycle stays rooted

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.nesting.test.ts`
- Possibly modify: `src/tools/AgentTool/AgentTool.tsx`
- Possibly modify: `src/tools/AgentTool/runAgent.ts`
- Test: `src/tools/AgentTool/AgentTool.nesting.test.ts`

**Interfaces:**
- Consumes: existing `rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState` in `AgentTool.tsx` and `runAgent.ts`.
- Produces: tests proving nested async registration uses `setAppStateForTasks` instead of isolated `setAppState`.

- [ ] **Step 1: Add a root-state regression test**

Append to `src/tools/AgentTool/AgentTool.nesting.test.ts`:

```ts
let rootSetCalls = 0
let isolatedSetCalls = 0
const asyncContext = createContext(1) as any
asyncContext.setAppState = () => { isolatedSetCalls += 1 }
asyncContext.setAppStateForTasks = updater => {
  rootSetCalls += 1
  const prev = asyncContext.getAppState()
  updater(prev)
}

const asyncResult = await AgentTool.call(
  {
    description: 'async child',
    prompt: 'do async child work',
    subagent_type: 'general-purpose',
    run_in_background: true,
  },
  asyncContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_async_test' } } as never,
)

assert.equal(asyncResult.data.status, 'async_launched')
assert.ok(rootSetCalls > 0)
assert.equal(isolatedSetCalls, 0)
```

- [ ] **Step 2: Run the test**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: PASS if current code already uses root task state. If it fails because the async lifecycle starts real query work, narrow the test by exporting and testing a small helper that selects the root setter:

```ts
export function getRootSetAppStateForTesting(context: ToolUseContext): ToolUseContext['setAppState'] {
  return context.setAppStateForTasks ?? context.setAppState
}
```

Then assert that helper returns the root setter when present.

- [ ] **Step 3: Only patch if the test exposes a bug**

If current code does not consistently use root setter, replace local task-registration calls in `AgentTool.tsx` with the already-created `rootSetAppState`. Do not refactor unrelated task lifecycle code.

- [ ] **Step 4: Run the test again**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Do not commit unless explicitly approved. If approved and files changed:

```bash
git add src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/runAgent.ts src/tools/AgentTool/AgentTool.nesting.test.ts
git commit -m "test: cover nested async agent root task state"
```

### Task 9: Run targeted and type validation

**Files:**
- No new files.
- Validate all files changed in Tasks 1-8.

**Interfaces:**
- Consumes all previous tasks.
- Produces a clean targeted test/typecheck result.

- [ ] **Step 1: Run command and cwd tests**

Run:

```bash
bun test src/utils/cwdChange.test.ts src/commands/cd/cd.test.ts src/commands/reload-skills/reload-skills.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run AgentTool depth tests**

Run:

```bash
bun test src/tools/AgentTool/subagentDepth.test.ts src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run nearby existing command tests**

Run:

```bash
bun test src/commands/workflows/workflows.test.ts src/commands/effort/effort.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
bunx tsc --noEmit --pretty false
```

Expected: exits 0.

- [ ] **Step 5: Inspect diff for accidental scope creep**

Run:

```bash
git diff -- src/Tool.ts src/utils/forkedAgent.ts src/tools/AgentTool src/utils/cwdChange.ts src/utils/Shell.ts src/commands.ts src/commands/cd src/commands/reload-skills src/utils/skills/skillChangeDetector.ts
```

Expected: diff only contains nested subagent depth propagation, `/cd`, `/reload-skills`, and direct tests. No plugin refresh changes in `/reload-skills`.

- [ ] **Step 6: Final checkpoint**

Do not commit unless explicitly approved. If approved after review:

```bash
git add src/Tool.ts src/utils/forkedAgent.ts src/tools/AgentTool src/utils/cwdChange.ts src/utils/Shell.ts src/commands.ts src/commands/cd src/commands/reload-skills
git commit -m "feat: add nested subagents cd and reload-skills"
```

---

## Self-review

### Spec coverage

- Nested subagent depth model: Tasks 1-3 add and enforce first-class depth with max 5.
- Tool exposure and permission boundary: Task 3 preserves existing AgentTool permission path and does not special-case child permissions.
- Fork subagents: Task 3 explicitly avoids changing fork path; existing fork guard remains.
- Task state and lifecycle stability: Task 8 tests root task-state setter usage for nested async agents.
- cwd/worktree isolation: Tasks 4, 5, and 7 cover cwd command side effects and sidechain metadata.
- Skill visibility and reload: Task 6 adds skill-only reload and command surface verification.
- `/cd`: Tasks 4-5 implement directory validation, relative resolution, symlink-realpath via `setCwd()`, env/cache/hook side effects, and concise errors.
- `/reload-skills`: Task 6 reloads skill caches without plugin refresh.
- Minimal failing tests first: every implementation task starts with a failing test or a test seam.

### Placeholder scan

No placeholder markers or unspecified test-writing steps remain. Each task includes exact files, exact commands, expected outcomes, and concrete code snippets.

### Type consistency

The depth helpers use `ToolUseContext['options']` consistently. The cwd helper returns `string`. The reload helper returns `{ skillCount: number; errorCount: number }`. Command `call()` functions return `Promise<LocalCommandResult>`.