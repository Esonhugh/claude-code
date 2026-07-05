# AgentTool Recover RunAgent Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the local AgentTool -> runAgent parameter lifecycle with the recover v2.1.201 call chain where it is low-risk and currently consumed.

**Architecture:** Keep AgentTool orchestration in `AgentTool.tsx` and runAgent lifecycle persistence in `runAgent.ts`. First align metadata and attribution fields that recover demonstrably consumes (`name`, `toolUseId`, `spawnDepth`); then evaluate permission-mode `spawnMode` and async progress with focused tests before changing behavior. Do not implement `onModelRestricted` until the model resolver has an equivalent callback surface.

**Tech Stack:** TypeScript, Bun test scripts, existing AgentTool focused tests, built `./built-claude` binary for interactive validation.

---

## File Structure

- Modify: `src/tools/AgentTool/runAgent.ts`
  - Extend the production metadata builder to include recover-consumed fields: `name`, `toolUseId`, `spawnDepth`.
  - Destructure `name` and `toolUseId` from `runAgent()` so existing parameters are no longer inert.
  - Persist `spawnDepth` from current `toolUseContext` agent depth.
- Modify: `src/tools/AgentTool/AgentTool.nesting.test.ts`
  - Extend existing metadata tests to prove recover-style metadata is persisted and worktree/cwd precedence stays unchanged.
- Modify: `src/tools/AgentTool/AgentTool.tsx`
  - No immediate behavior change required for metadata; it already passes `name` and `toolUseId` into `runAgentParams`.
  - Only edit if focused tests expose missing type/shape wiring.
- Do not modify yet:
  - `src/utils/model/agent.ts` for `onModelRestricted`; no equivalent callback exists yet.
  - Default async behavior; recover defaults async more aggressively, but this repo intentionally keeps current behavior.

---

### Task 1: Persist recover-style runAgent metadata

**Files:**
- Modify: `src/tools/AgentTool/runAgent.ts:247-267`
- Test: `src/tools/AgentTool/AgentTool.nesting.test.ts:83-111`

- [ ] **Step 1: Extend the existing metadata test first**

Edit `src/tools/AgentTool/AgentTool.nesting.test.ts` so the first metadata assertion passes `name`, `toolUseId`, and `spawnDepth`:

```ts
assert.deepEqual(
  buildAgentMetadataForTesting({
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'agent-test',
    cwd: undefined,
    name: 'worker-name',
    toolUseId: 'toolu_metadata',
    spawnDepth: 2,
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'agent-test',
    name: 'worker-name',
    toolUseId: 'toolu_metadata',
    spawnDepth: 2,
  },
)
```

Keep the second assertion unchanged except it may explicitly omit `name`, `toolUseId`, and `spawnDepth`. This preserves the current rule that `cwd` is only written when `worktreePath` is absent.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: FAIL because `buildAgentMetadataForTesting()` does not yet include `name`, `toolUseId`, or `spawnDepth`.

- [ ] **Step 3: Extend the production metadata builder**

Edit `src/tools/AgentTool/runAgent.ts`:

```ts
export function buildAgentMetadataForTesting({
  agentType,
  description,
  worktreePath,
  worktreeBranch,
  cwd,
  name,
  toolUseId,
  spawnDepth,
}: {
  agentType: string
  description?: string
  worktreePath?: string
  worktreeBranch?: string
  cwd?: string
  name?: string
  toolUseId?: string
  spawnDepth?: number
}) {
  return {
    agentType,
    ...(worktreePath && { worktreePath }),
    ...(worktreeBranch && { worktreeBranch }),
    ...(!worktreePath && cwd && { cwd }),
    ...(description && { description }),
    ...(name && { name }),
    ...(toolUseId && { toolUseId }),
    ...(spawnDepth !== undefined && { spawnDepth }),
  }
}
```

This keeps the existing exported function name because it already exists in production code; do not introduce any new `ForTesting` helper.

- [ ] **Step 4: Destructure consumed parameters and write metadata**

Edit the `runAgent()` parameter destructuring in `src/tools/AgentTool/runAgent.ts`:

```ts
  cwd,
  description,
  name,
  toolUseId,
  onMcpServersBlocked,
```

Edit the `writeAgentMetadata()` call:

```ts
    buildAgentMetadataForTesting({
      agentType: agentDefinition.agentType,
      description,
      worktreePath,
      worktreeBranch,
      cwd,
      name,
      toolUseId,
      spawnDepth: getAgentOptionsSubagentDepthForTesting(toolUseContext),
    }),
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: PASS.

Run the full focused AgentTool set:

```bash
bun src/tools/AgentTool/agentLaunchParams.test.ts && bun src/tools/AgentTool/AgentTool.nesting.test.ts && bun src/tools/AgentTool/agentProgressPayload.test.ts && bun src/tools/AgentTool/agentTypeResolver.test.ts && bun src/tools/AgentTool/mcpAvailability.test.ts && bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts && bun src/tools/AgentTool/subagentDepth.test.ts
```

Expected: all listed tests PASS.

---

### Task 2: Analyze spawnMode without changing behavior yet

**Files:**
- Read only: `src/tools/AgentTool/AgentTool.tsx:480-545`
- Read only: `src/tools/AgentTool/runAgent.ts:483-552`

- [ ] **Step 1: Compare current permission-mode flow**

Inspect these current local flows:

```ts
mode: spawnMode,
const permissionMode = resolvePermissionMode(spawnMode, parentMode)
```

and runAgent permission override:

```ts
const agentPermissionMode = agentDefinition.permissionMode
```

- [ ] **Step 2: Compare recover flow**

Use the already identified recover lines:

```js
spawnMode: T
let ue = d0e(R, V);
let de = ue ?? e.permissionMode;
```

- [ ] **Step 3: Decide implementation boundary**

Do not implement a behavior change unless the local code has a single clear place to pass resolved spawn mode into runAgent without double-applying permission rules. If implemented later, add a test that `mode: 'plan'` affects the child permission context even when agentDefinition has no permissionMode.

Expected result for this plan execution: document the current difference in the final report, but do not change behavior in Task 2.

---

### Task 3: Analyze toolUseId async progress before changing behavior

**Files:**
- Read only first: `src/tools/AgentTool/runAgent.ts:827-889`
- Read only first: async task/progress helpers referenced from `src/tools/AgentTool/AgentTool.tsx:1092-1163`

- [ ] **Step 1: Confirm current async progress surface**

Inspect whether local async agents already write parent progress through task registry or notifications. Do not add a second progress channel if the existing one already covers UI requirements.

- [ ] **Step 2: Compare recover behavior**

Recover writes background progress only when both async and parent `toolUseId` exist:

```js
if (o && w && (xt.type === "assistant" || xt.type === "user")) {
  parentToolUseID: w,
  data: {
    type: "agent_progress",
    agentId: J,
    agentType: e.agentType,
    resolvedModel: z,
    ...(x && { description: x })
  }
}
```

- [ ] **Step 3: Defer implementation unless a missing local UI path is proven**

Expected result for this plan execution: keep `toolUseId` persisted in metadata from Task 1, and document async progress as a remaining follow-up unless a clear missing local progress sink is found.

---

### Task 4: Verify build and binary behavior

**Files:**
- No source edits expected beyond Task 1.

- [ ] **Step 1: Run lint and whitespace checks**

Run:

```bash
bun run lint
git diff --check
```

Expected: both PASS.

- [ ] **Step 2: Build binary**

Run:

```bash
make build
```

Expected: `./built-claude` is rebuilt successfully.

- [ ] **Step 3: Run binary-side Agent smoke test**

Launch via InteractiveTerminal:

```bash
./built-claude --debug --debug-file /tmp/agenttool-runagent-params.log --dangerously-skip-permissions
```

Submit a prompt that uses Agent exactly once:

```text
Use the Agent tool with subagent_type "general-purpose", description "metadata params check", and prompt "Reply exactly: metadata-ok". Do not use any other tools.
```

Expected: Agent completes and the visible answer contains `metadata-ok`.

- [ ] **Step 4: Inspect sanitized debug metadata only**

Extract only `AgentTool launch params` records from `/tmp/agenttool-runagent-params.log` with a local script. Expected fields:

```json
{
  "selectedAgentType": "general-purpose",
  "hasDescription": true,
  "descriptionLength": 21,
  "agentDepth": 1,
  "agentSystemPromptChars": 1288
}
```

Do not print raw transcript bodies.

---

## Self-Review

1. Spec coverage:
- recover metadata consumption: covered by Task 1.
- spawnMode permission semantics: analyzed in Task 2, intentionally not changed yet.
- toolUseId async progress: analyzed in Task 3, intentionally not duplicated unless a missing sink is proven.
- onModelRestricted: intentionally excluded because local model resolver lacks callback consumption.

2. Placeholder scan:
- No TBD/TODO/placeholders are present.
- Deferred items explicitly state why they are deferred and what evidence would be needed.

3. Type consistency:
- `name`, `toolUseId`, and `spawnDepth` are added consistently to `buildAgentMetadataForTesting()` input and output.
- Existing `cwd` vs `worktreePath` precedence remains unchanged.
