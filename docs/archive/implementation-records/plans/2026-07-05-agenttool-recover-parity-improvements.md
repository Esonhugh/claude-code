# AgentTool Recover Parity Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten `AgentTool` behavior against `recover/claude-v2.1.201.js` while preserving intentional local safety divergences and proving launch correctness with deterministic tests.

**Architecture:** Keep production behavior in the existing `AgentTool` pipeline and small helper modules. Make parity changes through focused tests first: resolver parity, progress payload metadata, runAgent launch params, sync/async anti-hang behavior, and debug-log build verification. Preserve the existing `cwd` + `isolation: "worktree"` early failure as an intentional local divergence from recover.

**Tech Stack:** TypeScript, Bun test scripts, React Ink tool rendering, Claude Code AgentTool internals, `make build`, `built-claude --debug --debug-file`, InteractiveTerminal validation.

---

## Recover Reference Map

Use these bundled recover locations as the behavior oracle:

- AgentTool call entry: `recover/claude-v2.1.201.js:526675-526685`
- depth / teammate background guards: `recover/claude-v2.1.201.js:526686-526710`
- exact deny / allowed type checks: `recover/claude-v2.1.201.js:526727-526737`
- normalized agent type matching: `recover/claude-v2.1.201.js:526776-526824`
- required MCP wait and missing-server error: `recover/claude-v2.1.201.js:526830-526859`
- selected-agent analytics metadata: `recover/claude-v2.1.201.js:526884-526896`
- `runAgent` launch params: `recover/claude-v2.1.201.js:527029-527080`
- async task registration result: `recover/claude-v2.1.201.js:527142-527219`
- sync progress payload with `resolvedModel`: `recover/claude-v2.1.201.js:527241-527254`
- streamed sync progress payload with `resolvedModel`: `recover/claude-v2.1.201.js:527333-527345`
- sync anti-hang `Promise.race(done, backgroundSignal)`: `recover/claude-v2.1.201.js:527391-527395`

## File Structure

- Modify: `src/types/tools.ts`
  - Add `resolvedModel?: string` to `AgentToolProgress`.
- Modify: `src/tools/AgentTool/AgentTool.tsx`
  - Include `resolvedModel` in both sync `agent_progress` payloads.
  - Pass recover-aligned launch params where current context supports them.
  - Keep `cwd` + `worktree` early failure.
  - Keep sanitized debug launch params.
- Modify: `src/tools/AgentTool/agentTypeResolver.ts`
  - Align normalized ambiguity and allowed-agent errors closer to recover.
- Modify: `src/tools/AgentTool/runAgent.ts`
  - Add `worktreeBranch` to params only if the existing metadata/write path needs it.
  - Wire `spawnedBySkill` only from existing `toolUseContext.options` fields.
- Modify: `src/tools/AgentTool/AgentTool.nesting.test.ts`
  - Extend direct helper coverage for debug params and `cwd` + `worktree` early failure.
- Modify: `src/tools/AgentTool/agentTypeResolver.test.ts`
  - Add recover-parity resolver cases for unavailable normalized ambiguity and allowed-agent not-found behavior.
- Modify: `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`
  - Keep async completion-before-cleanup test; add a no-background-residue assertion if feasible with existing helpers.
- Create: `src/tools/AgentTool/agentProgressPayload.test.ts`
  - Unit-test the payload builder introduced in Task 1, or test exported helper if one already exists.
- Create: `src/tools/AgentTool/agentLaunchParams.test.ts`
  - Unit-test sanitized launch debug params and recover-aligned runAgent metadata shape without launching a real agent.

No git commits in this plan. The user must explicitly approve commits.

---

### Task 1: Add `resolvedModel` to Agent progress payloads

**Files:**
- Modify: `src/types/tools.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx:929-957`
- Modify: `src/tools/AgentTool/AgentTool.tsx` sync progress emission blocks
- Create: `src/tools/AgentTool/agentProgressPayload.test.ts`

- [ ] **Step 1: Write the failing progress payload test**

Create `src/tools/AgentTool/agentProgressPayload.test.ts`:

```ts
import assert from 'node:assert/strict'
import type { AgentToolProgress } from '../../types/tools.js'

const firstProgress: AgentToolProgress = {
  type: 'agent_progress',
  message: {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-07-05T00:00:00.000Z',
  } as never,
  prompt: 'hello',
  agentId: 'agent-test',
  agentType: 'general-purpose',
  description: 'Recover progress parity',
  resolvedModel: 'claude-sonnet-4-6',
}

assert.equal(firstProgress.resolvedModel, 'claude-sonnet-4-6')
assert.equal(firstProgress.agentType, 'general-purpose')
assert.equal(firstProgress.description, 'Recover progress parity')

console.log('agentProgressPayload.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/tools/AgentTool/agentProgressPayload.test.ts
```

Expected: TypeScript/Bun fails because `resolvedModel` is not assignable to `AgentToolProgress`.

- [ ] **Step 3: Add `resolvedModel` to the type**

Modify `src/types/tools.ts`:

```ts
export type AgentToolProgress = {
  type: 'agent_progress'
  message: Message
  taskId?: string
  summary?: string
  prompt?: string
  agentId?: string
  agentType?: string
  description?: string
  resolvedModel?: string
}
```

- [ ] **Step 4: Add `resolvedModel` to first sync progress emission**

In `src/tools/AgentTool/AgentTool.tsx`, update the first user-message progress payload to include:

```ts
resolvedModel: resolvedAgentModel,
```

The payload should match this shape:

```ts
data: {
  message: normalizedFirstMessage,
  type: 'agent_progress',
  prompt,
  agentId: syncAgentId,
  agentType: selectedAgent.agentType,
  description,
  resolvedModel: resolvedAgentModel,
},
```

- [ ] **Step 5: Add `resolvedModel` to streamed sync progress emission**

In `src/tools/AgentTool/AgentTool.tsx`, update the streamed progress payload to include:

```ts
resolvedModel: resolvedAgentModel,
```

The payload should match this shape:

```ts
data: {
  message: m,
  type: 'agent_progress',
  prompt: '',
  agentId: syncAgentId,
  agentType: selectedAgent.agentType,
  description,
  resolvedModel: resolvedAgentModel,
},
```

- [ ] **Step 6: Run focused test**

Run:

```bash
bun src/tools/AgentTool/agentProgressPayload.test.ts
```

Expected:

```text
agentProgressPayload.test.ts passed
```

---

### Task 2: Align resolver ambiguity and allowed-agent errors with recover

**Files:**
- Modify: `src/tools/AgentTool/agentTypeResolver.ts`
- Modify: `src/tools/AgentTool/agentTypeResolver.test.ts`

- [ ] **Step 1: Add failing tests for recover-style resolver behavior**

Append to `src/tools/AgentTool/agentTypeResolver.test.ts`:

```ts
assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'ab',
      activeAgents: [agent('a-b'), agent('a_b'), agent('other')],
      allowedAgentTypes: ['a-b'],
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'ab' is ambiguous") &&
    error.message.includes('a-b') &&
    error.message.includes('a_b (unavailable)') &&
    error.message.includes('Use the exact name: a-b'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'plan',
      activeAgents: [agent('Plan'), agent('Explore')],
      allowedAgentTypes: ['Explore'],
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'plan' not found") &&
    error.message.includes('Available agents: Explore'),
)
```

- [ ] **Step 2: Run resolver test to verify failure**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
```

Expected: FAIL because current ambiguity only considers available agents and current allowed-agent wording says `not available in this context`.

- [ ] **Step 3: Update resolver to compute recover-style normalized candidates**

Modify `src/tools/AgentTool/agentTypeResolver.ts` after `normalizedRequested` is computed:

```ts
const activeNormalizedMatches = activeAgents.filter(
  agent => normalizeAgentType(agent.agentType) === normalizedRequested,
)
const availableAgentTypes = new Set(availableAgents.map(agent => agent.agentType))
```

- [ ] **Step 4: Replace normalized ambiguity branch**

Replace the current `if (normalizedMatches.length > 1)` branch with:

```ts
if (activeNormalizedMatches.length > 1) {
  const availableMatches = activeNormalizedMatches.filter(agent =>
    availableAgentTypes.has(agent.agentType),
  )
  const formattedMatches = activeNormalizedMatches
    .map(agent =>
      availableAgentTypes.has(agent.agentType)
        ? agent.agentType
        : `${agent.agentType} (unavailable)`,
    )
    .join(', ')
  const exactNames = availableMatches.map(agent => agent.agentType).join(' or ')
  throw new Error(
    `Agent type '${requestedType}' is ambiguous — matches ${formattedMatches}. ${
      exactNames
        ? `Use the exact name: ${exactNames}`
        : `None of these are available. Available agents: ${formatAvailableAgents(availableAgents)}`
    }`,
  )
}
```

- [ ] **Step 5: Replace unavailable allowed-agent wording**

In the denied/unavailable branch where no deny rule exists, replace:

```ts
throw new Error(
  `Agent type '${requestedType}' is not available in this context. Available agents: ${availableText}`,
)
```

with:

```ts
throw new Error(
  `Agent type '${requestedType}' not found. Available agents: ${availableText}`,
)
```

- [ ] **Step 6: Run resolver test**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
```

Expected:

```text
agentTypeResolver.test.ts passed
```

---

### Task 3: Preserve and test `cwd` + `worktree` early failure as intentional divergence

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.nesting.test.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx:602-605` only if needed

- [ ] **Step 1: Strengthen existing direct failure test**

In `src/tools/AgentTool/AgentTool.nesting.test.ts`, keep the existing test that calls:

```ts
await AgentTool.call(
  {
    description: 'invalid cwd worktree',
    prompt: 'do it',
    subagent_type: 'general-purpose',
    isolation: 'worktree',
    cwd: '/tmp',
  },
  createContext(0) as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_cwd_worktree' } } as never,
)
```

Ensure the assertion remains:

```ts
assert.ok(cwdWorktreeError instanceof Error)
assert.equal(
  cwdWorktreeError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)
```

- [ ] **Step 2: Add side-effect guard counters**

Extend `createContext()` or the test harness so the invalid call proves no task was registered. Add after the assertion:

```ts
const invalidContext = createContext(0)
let invalidError: unknown
try {
  await AgentTool.call(
    {
      description: 'invalid cwd worktree side effects',
      prompt: 'do it',
      subagent_type: 'general-purpose',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    invalidContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_cwd_worktree_side_effects' } } as never,
  )
} catch (error) {
  invalidError = error
}
assert.ok(invalidError instanceof Error)
assert.deepEqual(invalidContext.getAppState().tasks, {})
assert.equal(invalidContext.getAppState().agentNameRegistry.size, 0)
```

- [ ] **Step 3: Run nesting test**

Run:

```bash
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected:

```text
AgentTool.nesting.test.ts passed
```

---

### Task 4: Add recover-aligned launch parameter tests

**Files:**
- Create: `src/tools/AgentTool/agentLaunchParams.test.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/tools/AgentTool/runAgent.ts` only if required by types

- [ ] **Step 1: Write failing launch debug params test**

Create `src/tools/AgentTool/agentLaunchParams.test.ts`:

```ts
import assert from 'node:assert/strict'
import { buildAgentLaunchDebugParamsForTesting } from './AgentTool.js'

const params = buildAgentLaunchDebugParamsForTesting({
  requestedType: 'general purpose',
  selectedAgentType: 'general-purpose',
  matchKind: 'normalized',
  description: 'Launch params should not leak',
  name: 'worker-name',
  model: 'claude-sonnet-4-6',
  permissionMode: 'acceptEdits',
  runInBackground: true,
  selectedAgentBackground: false,
  isAsync: true,
  isolation: 'worktree',
  cwd: '/tmp/agent-worktree',
  toolUseId: 'toolu_launch_params',
  requiredMcpServers: ['github'],
  availableMcpServers: ['github-enterprise'],
  childSubagentDepth: 2,
  availableToolNames: ['Read', 'Edit', 'mcp__github-enterprise__search'],
})

assert.equal(params.requestedType, 'general purpose')
assert.equal(params.selectedAgentType, 'general-purpose')
assert.equal(params.matchKind, 'normalized')
assert.equal(params.hasDescription, true)
assert.equal(params.descriptionLength, 'Launch params should not leak'.length)
assert.equal(params.hasName, true)
assert.equal(params.nameLength, 'worker-name'.length)
assert.equal(params.model, 'claude-sonnet-4-6')
assert.equal(params.permissionMode, 'acceptEdits')
assert.equal(params.runInBackground, true)
assert.equal(params.selectedAgentBackground, false)
assert.equal(params.isAsync, true)
assert.equal(params.isolation, 'worktree')
assert.equal(params.cwd, '/tmp/agent-worktree')
assert.equal(params.toolUseId, 'toolu_launch_params')
assert.deepEqual(params.requiredMcpServers, ['github'])
assert.deepEqual(params.availableMcpServers, ['github-enterprise'])
assert.equal(params.childSubagentDepth, 2)
assert.deepEqual(params.availableToolNames, ['Read', 'Edit', 'mcp__github-enterprise__search'])

const serialized = JSON.stringify(params)
assert.equal(serialized.includes('Launch params should not leak'), false)
assert.equal(serialized.includes('worker-name'), false)

console.log('agentLaunchParams.test.ts passed')
```

- [ ] **Step 2: Run test**

Run:

```bash
bun src/tools/AgentTool/agentLaunchParams.test.ts
```

Expected:

```text
agentLaunchParams.test.ts passed
```

If it fails because the helper does not expose one of these fields, add the field to `buildAgentLaunchDebugParamsForTesting()` without adding raw prompt, raw description, or raw name.

- [ ] **Step 3: Add `worktreeBranch` pass-through if current types need it**

If `runAgent.ts` has metadata persistence that can use `worktreeBranch`, add to the runAgent params type:

```ts
/** Worktree branch for isolated agent attribution. */
worktreeBranch?: string
```

Then pass it from `AgentTool.tsx`:

```ts
worktreeBranch: worktreeInfo?.worktreeBranch,
```

Do not add dead fields if no code reads them and no test can assert them.

- [ ] **Step 4: Wire `spawnedBySkill` only from existing options**

If `toolUseContext.options` already has `spawnedBySkill` or `activeSkill`, pass recover-style:

```ts
spawnedBySkill:
  toolUseContext.options.spawnedBySkill ?? toolUseContext.options.activeSkill,
```

If TypeScript shows neither field exists, skip this wiring and document it in the final verification as “not wired because current ToolUseContext has no recover-equivalent source.”

---

### Task 5: Verify sync anti-hang behavior against recover

**Files:**
- Modify: `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx` only if sync auto-background is missing

- [ ] **Step 1: Locate current sync auto-background logic**

Search current `src/tools/AgentTool/AgentTool.tsx` for the existing equivalent of recover:

```ts
Promise.race([
  lifecycle.then(() => 'done'),
  backgroundSignal.then(() => 'backgrounded'),
])
```

Use dedicated search for these terms:

```text
backgroundSignal
Promise.race
autoBackground
```

- [ ] **Step 2: If current logic exists, add a regression note test**

If `AgentTool.tsx` already races sync completion with an auto-background signal, add a small assertion to existing tests that the relevant exported helper or constants remain present. If no helper exists, do not export production internals just for this.

- [ ] **Step 3: If current logic is missing, implement minimal recover-style race**

In the sync branch, wrap the lifecycle promise with the current task's background signal so the main turn can unblock:

```ts
const outcome = await Promise.race([
  agentLifecycle.then(() => 'done' as const),
  agentTask.backgroundSignal.then(() => 'backgrounded' as const),
])
```

Then return the existing async-launched/backgrounded result when `outcome === 'backgrounded'`.

Do not change async lifecycle ordering. Async task completion must still happen before classifier/worktree cleanup.

- [ ] **Step 4: Re-run async ordering test**

Run:

```bash
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
```

Expected:

```text
asyncLifecycleOrdering.test.ts passed
```

- [ ] **Step 5: Run nesting test**

Run:

```bash
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected:

```text
AgentTool.nesting.test.ts passed
```

---

### Task 6: Prove debug launch log is present in source, build output, and runtime debug file

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx` if current log is missing from source
- No new files unless needed for a temporary local script; remove temporary files before finishing

- [ ] **Step 1: Verify source contains sanitized log**

Check `src/tools/AgentTool/AgentTool.tsx` contains:

```ts
logForDebugging(
  `AgentTool launch params ${JSON.stringify(
    buildAgentLaunchDebugParamsForTesting({
```

Expected: present near the runAgent params assembly, before `runAgentParams` is used.

- [ ] **Step 2: Build binary**

Run:

```bash
make build
```

Expected: build completes and writes `./built-claude`.

- [ ] **Step 3: Verify build output contains the log string**

Run a Node-based local string check, because direct grep may be unreliable on large bundles:

```bash
node - <<'NODE'
const fs = require('fs')
const paths = ['dist/cli.js', 'built-claude']
for (const path of paths) {
  if (!fs.existsSync(path)) continue
  const content = fs.readFileSync(path)
  console.log(path, content.includes(Buffer.from('AgentTool launch params')))
}
NODE
```

Expected: `dist/cli.js true`. `built-claude` may be binary; if it prints `false`, do not treat that alone as failure if runtime debug emits the log.

- [ ] **Step 4: Run print-mode launch with debug file**

Run:

```bash
./built-claude --debug --debug-file /tmp/agenttool-print-debug.log --print 'Use the Agent tool with subagent_type "general purpose" and prompt "Reply with READY only". Use description "Print normalized check". Do not use any other tools.' --dangerously-skip-permissions
```

Expected stdout includes:

```text
READY
```

- [ ] **Step 5: Verify runtime debug file contains sanitized launch params**

Run:

```bash
node - <<'NODE'
const fs = require('fs')
const p = '/tmp/agenttool-print-debug.log'
const s = fs.readFileSync(p, 'utf8')
const lines = s.split('\n').filter(line => line.includes('AgentTool launch params'))
console.log('launch-param-lines', lines.length)
for (const line of lines) {
  console.log(line.includes('Print normalized check') ? 'leaked-description' : 'description-redacted')
  console.log(line.includes('Reply with READY') ? 'leaked-prompt' : 'prompt-redacted')
  console.log(line.includes('"matchKind":"normalized"') ? 'has-normalized' : 'missing-normalized')
  console.log(line.includes('"selectedAgentType":"general-purpose"') ? 'has-agent-type' : 'missing-agent-type')
}
NODE
```

Expected:

```text
launch-param-lines 1
description-redacted
prompt-redacted
has-normalized
has-agent-type
```

If `launch-param-lines 0`, stop and debug build inclusion before continuing.

---

### Task 7: Run deterministic focused validation suite

**Files:**
- No production edits unless tests reveal a defect

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
bun src/tools/AgentTool/mcpAvailability.test.ts
bun src/tools/AgentTool/agentProgressPayload.test.ts
bun src/tools/AgentTool/agentLaunchParams.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
bun src/tools/AgentTool/subagentDepth.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected each prints its `... passed` line.

- [ ] **Step 2: Run lint**

Run:

```bash
bun run lint
```

Expected: exits 0.

- [ ] **Step 3: Run diff whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit 0.

- [ ] **Step 4: Build**

Run:

```bash
make build
```

Expected: exits 0 and produces `./built-claude`.

---

### Task 8: Run serious binary-side AgentTool validation

**Files:**
- No production edits unless validation reveals a defect
- Artifacts: `/tmp/agenttool-interactive-debug.log`, `/tmp/agenttool-print-debug.log`

- [ ] **Step 1: Start built binary with debug file in InteractiveTerminal**

Open an InteractiveTerminal session with:

```bash
/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/built-claude --debug --debug-file /tmp/agenttool-interactive-debug.log --dangerously-skip-permissions
```

Expected: Claude Code prompt appears.

- [ ] **Step 2: Validate invalid type path**

Send this binary-side prompt:

```text
Use the Agent tool with subagent_type "definitely-missing-agent" and prompt "Reply READY". Do not use any other tools.
```

Expected visible result contains:

```text
Agent type 'definitely-missing-agent' not found. Available agents:
```

- [ ] **Step 3: Validate normalized sync launch path**

Send this binary-side prompt:

```text
Use the Agent tool with subagent_type "general purpose" and prompt "Reply with READY only". Use description "Interactive normalized check". Do not use any other tools.
```

Expected visible result includes:

```text
general purpose(Interactive normalized check)
READY
```

- [ ] **Step 4: Validate async launch path**

Send this binary-side prompt:

```text
Use the Agent tool with run_in_background true, subagent_type "general purpose", description "Interactive async check", and prompt "Reply with READY only". Do not use any other tools.
```

Expected visible result includes:

```text
Backgrounded agent
Agent "Interactive async check" completed
READY
```

- [ ] **Step 5: Validate deterministic `cwd` + `worktree` early failure with direct unit harness, not model discretion**

Do not rely on the model to choose exact tool arguments. The direct test from Task 3 is the deterministic validation for this branch:

```bash
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected:

```text
AgentTool.nesting.test.ts passed
```

Record this as assistant-side direct Tool API validation, not binary-side model-discretion validation.

- [ ] **Step 6: Close InteractiveTerminal session**

Close the session cleanly.

- [ ] **Step 7: Inspect debug file for launch params without printing secrets**

Run the same local summary script from Task 6 Step 5 against `/tmp/agenttool-interactive-debug.log`:

```bash
node - <<'NODE'
const fs = require('fs')
const p = '/tmp/agenttool-interactive-debug.log'
const s = fs.readFileSync(p, 'utf8')
const lines = s.split('\n').filter(line => line.includes('AgentTool launch params'))
console.log('launch-param-lines', lines.length)
for (const line of lines) {
  console.log(line.includes('Interactive normalized check') ? 'leaked-description' : 'description-redacted')
  console.log(line.includes('Reply with READY') ? 'leaked-prompt' : 'prompt-redacted')
  console.log(line.includes('"selectedAgentType":"general-purpose"') ? 'has-agent-type' : 'missing-agent-type')
}
NODE
```

Expected at least two launch-param lines from sync and async launches, no raw prompt/description leaks.

---

### Task 9: Final review and handoff

**Files:**
- No edits unless review finds a defect

- [ ] **Step 1: Check git status**

Run:

```bash
git status --short
```

Expected: only intended files are modified/untracked.

- [ ] **Step 2: Review diff**

Run:

```bash
git diff -- src/types/tools.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/agentTypeResolver.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/AgentTool.nesting.test.ts src/tools/AgentTool/agentTypeResolver.test.ts src/tools/AgentTool/asyncLifecycleOrdering.test.ts
```

Expected: diff contains only recover parity improvements and tests.

- [ ] **Step 3: Review untracked test files**

Run:

```bash
git status --short src/tools/AgentTool docs/superpowers/plans
```

Expected includes new tests and this plan file. Do not commit.

- [ ] **Step 4: Report verification succinctly**

Final report must include:

```markdown
## 完成
- resolver parity: <pass/fail>
- progress resolvedModel parity: <pass/fail>
- runAgent params parity: <pass/fail or skipped with reason>
- cwd/worktree intentional divergence: <pass/fail>
- anti-hang validation: <pass/fail>
- debug launch params in runtime log: <pass/fail>

## 验证
- `bun ...`: pass
- `bun run lint`: pass
- `git diff --check`: pass
- `make build`: pass
- InteractiveTerminal binary-side checks: pass

## 未做
- 未创建 commit，等待用户明确批准。
```

---

## Self-Review

**Spec coverage:**
- `resolvedModel progress` covered by Task 1.
- `resolver parity` covered by Task 2.
- `runAgent params` covered by Task 4.
- `cwd/worktree intentional divergence` covered by Task 3 and Task 8 Step 5.
- `sync auto-background / anti-hang` covered by Task 5.
- `debug log build/runtime validation` covered by Task 6 and Task 8.
- `serious interactive validation` covered by Task 8.

**Placeholder scan:** No TBD/TODO/fill-in placeholders are present. Conditional steps explicitly say when to skip and what to report.

**Type consistency:** `resolvedModel`, `agentType`, `description`, `worktreeBranch`, `spawnedBySkill`, and `onMcpServersBlocked` names match the existing/recover names used in the plan.
