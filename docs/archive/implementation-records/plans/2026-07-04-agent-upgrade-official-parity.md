# Agent Upgrade Official Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `AgentTool` lifecycle behavior closer to official Claude Code while preserving local safety divergences around async completion ordering.

**Architecture:** Add small, focused helpers around agent type resolution and MCP availability, then thread their results through the existing `AgentTool.tsx` lifecycle without rewriting `runAgent`. Keep async completion ordering in `runAsyncAgentLifecycle` as an intentional local divergence and cover it with tests.

**Tech Stack:** TypeScript, React/Ink tool UI, Bun scripts, Node `assert`-style tests, local `built-claude` and `official-claude` interactive validation.

---

## Pre-flight Notes

- Follow `CLAUDE.md`: use `bun`, not `npm`; do not commit until the user explicitly approves.
- Edit the original repository directly; do not create a worktree for this task.
- This plan intentionally creates focused helper files because `src/tools/AgentTool/AgentTool.tsx` is already large and the spec explicitly asks for small resolver/checker boundaries.
- Before claiming completion, run `bun run lint`, targeted tests, `make build`, and an InteractiveTerminal parity check using `./official-claude --dangerously-skip-permissions` and `./built-claude --dangerously-skip-permissions`.

## File Structure

### Create

- `src/tools/AgentTool/agentTypeResolver.ts`
  - Normalize `subagent_type`, distinguish exact/normalized/ambiguous/denied/unknown outcomes, and format user-facing errors.
- `src/tools/AgentTool/agentTypeResolver.test.ts`
  - Unit tests for exact, normalized, ambiguous, denied, allowed-agent filtering, and unknown cases.
- `src/tools/AgentTool/mcpAvailability.ts`
  - Extract MCP server names from both app-state tools and current tool pool, then check `requiredMcpServers` against the merged set.
- `src/tools/AgentTool/mcpAvailability.test.ts`
  - Unit tests for app-state-only, tool-pool-only, missing, dedupe, and filtered-tool cases.
- `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`
  - Direct test of `runAsyncAgentLifecycle()` proving `completeAgentTask()` happens before slow notification embellishments.
- `src/tools/AgentTool/agentProgressPayload.test.ts`
  - Focused test for sync `agent_progress` payload shape if an existing direct `AgentTool.call()` harness can be built in one file. If this becomes too brittle, use the InteractiveTerminal parity task as the full-flow check and keep this test scoped to payload construction only after extracting a tiny helper.

### Modify

- `src/tools/AgentTool/AgentTool.tsx`
  - Replace inline agent lookup at `AgentTool.tsx:495-549` with `resolveAgentType()`.
  - Move `cwd` + `isolation: "worktree"` validation before any worktree creation/task registration; current check is at `AgentTool.tsx:672-676`.
  - Replace required MCP server check at `AgentTool.tsx:566-640` with merged checker.
  - Enrich `runAgentParams` at `AgentTool.tsx:902-945` with safe metadata fields already accepted or newly added to `runAgent()`.
  - Enrich sync `agent_progress` payloads at `AgentTool.tsx:1115-1123` and `AgentTool.tsx:1527-1537` with `agentType` and `description`.
  - Change async-launched text at `AgentTool.tsx:1780-1785` to avoid encouraging `Read`/`tail` of the complete JSONL transcript.
- `src/tools/AgentTool/runAgent.ts`
  - Extend `runAgent()` parameter type with safe metadata fields (`name`, `toolUseId`, `spawnedBySkill`, optional `onMcpServersBlocked`) only if they can be threaded without behavior changes.
  - Keep existing MCP server initialization cleanup behavior.
- `src/tools/AgentTool/agentToolUtils.ts`
  - Keep completion-before-classifier ordering at `agentToolUtils.ts:600-627` unchanged.
  - Add optional notification callback handling only if needed for MCP blocked notification.
- `src/tools/AgentTool/loadAgentsDir.ts`
  - Reuse `hasRequiredMcpServers()` from `loadAgentsDir.ts:231-244`; do not duplicate matching rules.
- `src/types/tools.ts`
  - Extend `AgentToolProgress` to include optional `agentType?: string` and `description?: string` if not already present.
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
  - No lifecycle behavior change expected; only import in tests.
- `docs/superpowers/specs/2026-07-03-agent-upgrade-design.md`
  - Do not modify unless implementation discovers a required intentional divergence that must be recorded.

---

## Task 1: Official lifecycle parity gate

**Files:**
- Read: `docs/agent-update-plan.md`
- Read: `docs/superpowers/specs/2026-07-03-agent-upgrade-design.md`
- Read: `src/tools/AgentTool/AgentTool.tsx`
- Read: `src/tools/AgentTool/runAgent.ts`
- Read: `src/tools/AgentTool/agentToolUtils.ts`
- Read: `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- Read: `src/tools/AgentTool/loadAgentsDir.ts`
- Output evidence in final implementation notes, not a new doc unless a migration candidate appears.

- [ ] **Step 1: Inspect current local lifecycle boundaries**

Confirm these local anchors still match the spec:

```text
AgentTool selection: src/tools/AgentTool/AgentTool.tsx:495-549
MCP required-server check: src/tools/AgentTool/AgentTool.tsx:566-640
cwd/worktree validation: src/tools/AgentTool/AgentTool.tsx:672-676
worker tool pool assembly: src/tools/AgentTool/AgentTool.tsx:856-868
worktree creation: src/tools/AgentTool/AgentTool.tsx:870-885
runAgent params: src/tools/AgentTool/AgentTool.tsx:902-945
async-from-start lifecycle call: src/tools/AgentTool/AgentTool.tsx:1031-1055
sync progress payload: src/tools/AgentTool/AgentTool.tsx:1115-1123 and 1527-1537
async launched text: src/tools/AgentTool/AgentTool.tsx:1780-1785
async completion-before-notification: src/tools/AgentTool/agentToolUtils.ts:600-627
backgrounded completion-before-notification: src/tools/AgentTool/AgentTool.tsx:1317-1368
```

- [ ] **Step 2: Compare official binary behavior with local behavior**

Use InteractiveTerminal, not tmux, unless the user explicitly asks for tmux. Launch both binaries separately:

```text
./official-claude --dangerously-skip-permissions
./built-claude --dangerously-skip-permissions
```

Use equivalent prompts that exercise:

```text
Use the Agent tool with subagent_type "general purpose" and a trivial prompt: say ready.
Use the Agent tool with run_in_background true and a trivial prompt: wait briefly then say ready.
Use the Agent tool with an invalid subagent_type "definitely-missing-agent".
```

Capture the terminal output paths from InteractiveTerminal read/save output.

Expected result:

```text
No evidence of an official architecture-level lifecycle rewrite that requires migration, or a clear list of migration candidates.
```

- [ ] **Step 3: Decide the gate result**

If no migration candidate appears, continue with this plan. If a migration candidate appears, stop and ask the user whether to expand scope. Use this matrix in the response:

```markdown
| Dimension | Local current implementation | Official current behavior | Behavior parity | Structural parity | Handling |
| --- | --- | --- | --- | --- | --- |
| schema/input |  |  |  |  | local patch |
| agent type selection |  |  |  |  | local patch |
| permission/tools assembly |  |  |  |  | local patch |
| MCP required server |  |  |  |  | local patch |
| sync lifecycle |  |  |  |  | local patch |
| async lifecycle |  |  |  |  | intentional divergence |
| foreground→background |  |  |  |  | intentional divergence |
| task registry/completion |  |  |  |  | intentional divergence |
| worktree/cwd cleanup |  |  |  |  | local patch |
| progress events |  |  |  |  | local patch |
| result mapping |  |  |  |  | local patch |
| classifier/cleanup order | Complete task before classifier/cleanup |  |  |  | intentional divergence |
```

- [ ] **Step 4: Checkpoint**

Run:

```bash
git diff -- docs/superpowers/plans/2026-07-04-agent-upgrade-official-parity.md src/tools/AgentTool src/tasks/LocalAgentTask src/types/tools.ts
```

Expected: no code changes yet.

---

## Task 2: Add agent type resolver tests

**Files:**
- Create: `src/tools/AgentTool/agentTypeResolver.test.ts`
- Create later: `src/tools/AgentTool/agentTypeResolver.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `src/tools/AgentTool/agentTypeResolver.test.ts`:

```ts
import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resolveAgentTypeForTesting } from './agentTypeResolver.js'

function agent(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `Use ${agentType}`,
    source: 'projectSettings',
    baseDir: '/tmp/agents',
    getSystemPrompt: () => `You are ${agentType}`,
  }
}

const permissionContext = getEmptyToolPermissionContext()

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'code-reviewer',
    activeAgents: [agent('code-reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'code-reviewer',
)

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'Code Reviewer',
    activeAgents: [agent('code-reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'code-reviewer',
)

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'code_reviewer',
    activeAgents: [agent('Code-Reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'Code-Reviewer',
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'ab',
      activeAgents: [agent('a-b'), agent('a_b')],
      allowedAgentTypes: undefined,
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'ab' is ambiguous") &&
    error.message.includes('a-b') &&
    error.message.includes('a_b'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'plan',
      activeAgents: [agent('Plan')],
      allowedAgentTypes: ['Explore'],
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'plan' is not available") &&
    error.message.includes('Explore'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'missing-agent',
      activeAgents: [agent('general-purpose'), agent('code-reviewer')],
      allowedAgentTypes: undefined,
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'missing-agent' not found") &&
    error.message.includes('general-purpose') &&
    error.message.includes('code-reviewer'),
)

console.log('agentTypeResolver.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
```

Expected:

```text
error: Cannot find module './agentTypeResolver.js'
```

---

## Task 3: Implement agent type resolver helper

**Files:**
- Create: `src/tools/AgentTool/agentTypeResolver.ts`
- Modify if needed: `src/tools/AgentTool/agentTypeResolver.test.ts`

- [ ] **Step 1: Add minimal resolver implementation**

Create `src/tools/AgentTool/agentTypeResolver.ts`:

```ts
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../../utils/permissions/permissions.js'
import { AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { ToolPermissionContext } from '../../Tool.js'

export type AgentTypeResolution = {
  agent: AgentDefinition
  matchKind: 'exact' | 'normalized'
  requestedType: string
}

function normalizeAgentType(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Dash_Punctuation}_]+/gu, '')
}

function formatAvailableAgents(agents: readonly AgentDefinition[]): string {
  return agents.map(a => a.agentType).join(', ') || 'none'
}

export function resolveAgentType({
  requestedType,
  activeAgents,
  allowedAgentTypes,
  permissionContext,
}: {
  requestedType: string
  activeAgents: readonly AgentDefinition[]
  allowedAgentTypes?: string[]
  permissionContext: ToolPermissionContext
}): AgentTypeResolution {
  const scopedAgents = allowedAgentTypes
    ? activeAgents.filter(a => allowedAgentTypes.includes(a.agentType))
    : [...activeAgents]
  const availableAgents = filterDeniedAgents(
    scopedAgents,
    permissionContext,
    AGENT_TOOL_NAME,
  )

  const exact = availableAgents.find(agent => agent.agentType === requestedType)
  if (exact) {
    return { agent: exact, matchKind: 'exact', requestedType }
  }

  const normalizedRequested = normalizeAgentType(requestedType)
  const normalizedMatches = availableAgents.filter(
    agent => normalizeAgentType(agent.agentType) === normalizedRequested,
  )

  if (normalizedMatches.length === 1) {
    return {
      agent: normalizedMatches[0]!,
      matchKind: 'normalized',
      requestedType,
    }
  }

  if (normalizedMatches.length > 1) {
    throw new Error(
      `Agent type '${requestedType}' is ambiguous. Matching agents: ${formatAvailableAgents(normalizedMatches)}`,
    )
  }

  const exactDenied = activeAgents.find(agent => agent.agentType === requestedType)
  const normalizedDenied = activeAgents.find(
    agent => normalizeAgentType(agent.agentType) === normalizedRequested,
  )
  const denied = exactDenied ?? normalizedDenied
  if (denied && !availableAgents.some(a => a.agentType === denied.agentType)) {
    const denyRule = getDenyRuleForAgent(
      permissionContext,
      AGENT_TOOL_NAME,
      denied.agentType,
    )
    if (denyRule) {
      throw new Error(
        `Agent type '${requestedType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${denied.agentType})' from ${denyRule.source ?? 'settings'}.`,
      )
    }
    throw new Error(
      `Agent type '${requestedType}' is not available in this context. Available agents: ${formatAvailableAgents(availableAgents)}`,
    )
  }

  throw new Error(
    `Agent type '${requestedType}' not found. Available agents: ${formatAvailableAgents(availableAgents)}`,
  )
}

export const resolveAgentTypeForTesting = resolveAgentType
```

- [ ] **Step 2: Run resolver test**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
```

Expected:

```text
agentTypeResolver.test.ts passed
```

- [ ] **Step 3: Run existing nearby tests**

Run:

```bash
bun src/tools/AgentTool/subagentDepth.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected:

```text
subagentDepth.test.ts passed
```

`AgentTool.nesting.test.ts` should pass with its existing success output.

---

## Task 4: Wire resolver into AgentTool

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/tools/AgentTool/agentTypeResolver.test.ts`

- [ ] **Step 1: Import resolver**

In `src/tools/AgentTool/AgentTool.tsx`, add:

```ts
import { resolveAgentType } from './agentTypeResolver.js'
```

Remove now-unused imports if TypeScript reports them:

```ts
filterDeniedAgents
getDenyRuleForAgent
```

Keep `filterDeniedAgents` if still used in `prompt()`.

- [ ] **Step 2: Replace inline lookup**

Replace the non-fork selection block currently shaped like:

```ts
const allAgents = toolUseContext.options.agentDefinitions.activeAgents
const { allowedAgentTypes } = toolUseContext.options.agentDefinitions
const agents = filterDeniedAgents(...)
const found = agents.find(agent => agent.agentType === effectiveType)
...
selectedAgent = found
```

with:

```ts
const allAgents = toolUseContext.options.agentDefinitions.activeAgents
const { allowedAgentTypes } = toolUseContext.options.agentDefinitions
selectedAgent = resolveAgentType({
  requestedType: effectiveType,
  activeAgents: allAgents,
  allowedAgentTypes,
  permissionContext: appState.toolPermissionContext,
}).agent
```

- [ ] **Step 3: Run tests**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
bun src/tools/AgentTool/subagentDepth.test.ts
```

Expected: all pass.

- [ ] **Step 4: Check lint for this area**

Run:

```bash
bun run lint
```

Expected: no new lint errors. If lint fails, fix only errors caused by this task.

---

## Task 5: Add MCP availability checker tests

**Files:**
- Create: `src/tools/AgentTool/mcpAvailability.test.ts`
- Create later: `src/tools/AgentTool/mcpAvailability.ts`

- [ ] **Step 1: Write failing MCP checker tests**

Create `src/tools/AgentTool/mcpAvailability.test.ts`:

```ts
import assert from 'node:assert/strict'

import type { Tool } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import {
  getAvailableMcpServerNamesForTesting,
  getMissingRequiredMcpServersForTesting,
} from './mcpAvailability.js'

function mcpTool(name: string): Tool {
  return { name, async description() { return name } } as Tool
}

const agent: AgentDefinition = {
  agentType: 'needs-github',
  whenToUse: 'Use when GitHub MCP is required',
  source: 'projectSettings',
  baseDir: '/tmp/agents',
  requiredMcpServers: ['github'],
  getSystemPrompt: () => 'Use GitHub MCP',
}

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [mcpTool('mcp__github__search')],
    currentToolPool: [],
  }),
  ['github'],
)

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [],
    currentToolPool: [mcpTool('mcp__github__search')],
  }),
  ['github'],
)

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [mcpTool('mcp__github__search')],
    currentToolPool: [mcpTool('mcp__github__repo'), mcpTool('Read')],
  }),
  ['github'],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent,
    availableServers: ['github'],
  }),
  [],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent,
    availableServers: [],
  }),
  ['github'],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent: { ...agent, requiredMcpServers: ['git'] },
    availableServers: ['github-enterprise'],
  }),
  [],
)

console.log('mcpAvailability.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun src/tools/AgentTool/mcpAvailability.test.ts
```

Expected:

```text
error: Cannot find module './mcpAvailability.js'
```

---

## Task 6: Implement MCP availability checker and wire AgentTool

**Files:**
- Create: `src/tools/AgentTool/mcpAvailability.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`

- [ ] **Step 1: Add MCP helper**

Create `src/tools/AgentTool/mcpAvailability.ts`:

```ts
import type { Tools } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { hasRequiredMcpServers } from './loadAgentsDir.js'

function getMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const parts = toolName.split('__')
  return parts[1] || undefined
}

export function getAvailableMcpServerNames({
  appStateMcpTools,
  currentToolPool,
}: {
  appStateMcpTools: Tools
  currentToolPool: Tools
}): string[] {
  const names = new Set<string>()
  for (const tool of [...appStateMcpTools, ...currentToolPool]) {
    const name = getMcpServerName(tool.name)
    if (name) names.add(name)
  }
  return [...names]
}

export function getMissingRequiredMcpServers({
  agent,
  availableServers,
}: {
  agent: AgentDefinition
  availableServers: string[]
}): string[] {
  const required = agent.requiredMcpServers ?? []
  if (required.length === 0) return []
  if (hasRequiredMcpServers(agent, availableServers)) return []
  return required.filter(
    pattern =>
      !availableServers.some(server =>
        server.toLowerCase().includes(pattern.toLowerCase()),
      ),
  )
}

export const getAvailableMcpServerNamesForTesting = getAvailableMcpServerNames
export const getMissingRequiredMcpServersForTesting = getMissingRequiredMcpServers
```

- [ ] **Step 2: Run MCP test**

Run:

```bash
bun src/tools/AgentTool/mcpAvailability.test.ts
```

Expected:

```text
mcpAvailability.test.ts passed
```

- [ ] **Step 3: Import helper in AgentTool**

In `src/tools/AgentTool/AgentTool.tsx`, add:

```ts
import {
  getAvailableMcpServerNames,
  getMissingRequiredMcpServers,
} from './mcpAvailability.js'
```

Remove `hasRequiredMcpServers` from the `loadAgentsDir.js` import if it becomes unused.

- [ ] **Step 4: Replace final required-server calculation**

After pending-server wait, replace manual `serversWithTools` construction with:

```ts
const serversWithTools = getAvailableMcpServerNames({
  appStateMcpTools: currentAppState.mcp.tools,
  currentToolPool: toolUseContext.options.tools,
})
const missing = getMissingRequiredMcpServers({
  agent: selectedAgent,
  availableServers: serversWithTools,
})

if (missing.length > 0) {
  throw new Error(
    `Agent '${selectedAgent.agentType}' requires MCP servers matching: ${missing.join(', ')}. ` +
      `MCP servers with tools: ${serversWithTools.length > 0 ? serversWithTools.join(', ') : 'none'}. ` +
      `Use /mcp to configure and authenticate the required MCP servers.`,
  )
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun src/tools/AgentTool/mcpAvailability.test.ts
bun src/tools/AgentTool/agentTypeResolver.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: all pass.

---

## Task 7: Move cwd/worktree validation before side effects

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Test: add case to the most practical existing/new AgentTool test harness. If direct call harness is too large, validate with InteractiveTerminal in Task 13.

- [ ] **Step 1: Move validation immediately after selected agent constraints**

Keep this code after selected agent is known and before MCP waiting, analytics, worker tool assembly, task registration, and worktree creation:

```ts
const effectiveIsolation = isolation ?? selectedAgent.isolation
if (cwd && effectiveIsolation === 'worktree') {
  throw new Error('cwd is mutually exclusive with isolation: "worktree"')
}
```

Remove the later duplicate at the current location near `AgentTool.tsx:672-676`.

- [ ] **Step 2: Verify no side effects happen before this validation**

Check by reading the surrounding code. Between `selectedAgent` assignment and the moved validation, only these are allowed:

```text
in-process teammate background constraint
selectedAgent.background constraint
const effectiveIsolation = isolation ?? selectedAgent.isolation
```

No worktree creation, `registerAsyncAgent`, `registerAgentForeground`, `registerRemoteAgentTask`, or `runAgent` call may happen before the error.

- [ ] **Step 3: Run nearby tests and lint**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
bun src/tools/AgentTool/mcpAvailability.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
bun run lint
```

Expected: all pass.

---

## Task 8: Enrich sync agent progress payload

**Files:**
- Modify: `src/types/tools.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Create: `src/tools/AgentTool/agentProgressPayload.test.ts` only if a small helper is extracted.

- [ ] **Step 1: Read current progress type**

Open `src/types/tools.ts` and locate `AgentToolProgress`. Confirm it currently permits:

```ts
type: 'agent_progress'
message: ...
prompt: string
agentId?: ...
```

- [ ] **Step 2: Extend type with optional fields**

Add optional fields to the `AgentToolProgress` shape:

```ts
agentType?: string
description?: string
```

Do not remove existing fields.

- [ ] **Step 3: Update initial sync progress payload**

In `src/tools/AgentTool/AgentTool.tsx`, update the first progress payload to:

```ts
onProgress({
  toolUseID: `agent_${assistantMessage.message.id}`,
  data: {
    message: normalizedFirstMessage,
    type: 'agent_progress',
    prompt,
    agentId: syncAgentId,
    agentType: selectedAgent.agentType,
    description,
  },
})
```

- [ ] **Step 4: Update subsequent sync progress payloads**

In the later `onProgress()` call for tool_use/tool_result forwarding, update payload to:

```ts
onProgress({
  toolUseID: `agent_${assistantMessage.message.id}`,
  data: {
    message: m,
    type: 'agent_progress',
    prompt: '',
    agentId: syncAgentId,
    agentType: selectedAgent.agentType,
    description,
  },
})
```

- [ ] **Step 5: Run lint and type-sensitive tests**

Run:

```bash
bun run lint
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: no type/lint errors.

---

## Task 9: Make async launched text conservative

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`

- [ ] **Step 1: Replace async-launched instruction text**

In `mapToolResultToToolResultBlockParam()`, replace the `data.status === 'async_launched'` branch text construction with:

```ts
const prefix = `Async agent launched successfully.\nagentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`
const instructions = data.canReadOutputFile
  ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: ${data.outputFile}\nDo not proactively read or tail the transcript. Only inspect the output file if the user asks for progress or you need a specific result before continuing.`
  : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`
const text = `${prefix}\n${instructions}`
```

- [ ] **Step 2: Ensure forbidden wording is gone**

Search with Grep for this exact old phrase:

```text
If asked, you can check progress before completion by using
```

Expected: no matches.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: no lint errors.

---

## Task 10: Enrich runAgent params without behavior changes

**Files:**
- Modify: `src/tools/AgentTool/runAgent.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`

- [ ] **Step 1: Extend runAgent parameter type**

In `runAgent.ts`, add these optional destructured params after `description`:

```ts
  name,
  toolUseId,
  spawnedBySkill,
  onMcpServersBlocked,
```

Add matching type fields:

```ts
  /** Optional parent-provided name for SendMessage routing/attribution. */
  name?: string
  /** Parent tool_use id for attribution and notifications. */
  toolUseId?: string
  /** Whether this agent was spawned by a skill-triggered flow. */
  spawnedBySkill?: boolean
  /** Non-fatal notification hook for blocked/unavailable MCP servers. */
  onMcpServersBlocked?: (serverNames: string[]) => void | Promise<void>
```

Do not use these fields yet unless existing code has a clear target. Avoid `void name` placeholders; unused destructured params should not be destructured until needed if lint complains.

- [ ] **Step 2: Thread safe fields from AgentTool**

In `runAgentParams`, add only fields that are accepted by `runAgent()` and do not change behavior:

```ts
      name,
      toolUseId: toolUseContext.toolUseId,
      spawnedBySkill: false,
```

If `spawnedBySkill` has an existing source in current app state or tool context, use that instead of `false`. If no source exists, omit it rather than inventing behavior.

- [ ] **Step 3: Add non-fatal MCP blocked callback only if supported**

If implementation finds a reliable existing notification path, add:

```ts
      onMcpServersBlocked: serverNames => {
        logForDebugging(
          `Agent '${selectedAgent.agentType}' MCP servers blocked or unavailable: ${serverNames.join(', ')}`,
          { level: 'warn' },
        )
      },
```

If no blocked/unavailable event source exists in `runAgent.ts`, do not fabricate one. Record this as a deferred parity item in final notes.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
```

Expected: no unused variable or type errors.

---

## Task 11: Preserve and test async completion ordering

**Files:**
- Create: `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`
- Modify: `src/tools/AgentTool/agentToolUtils.ts` only if needed for testability; do not change ordering.

- [ ] **Step 1: Write test for completion-before-slow-worktree**

Create `src/tools/AgentTool/asyncLifecycleOrdering.test.ts`:

```ts
import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentToolResult } from './agentToolUtils.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { registerAsyncAgent, isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

function makeAssistantMessage() {
  return {
    type: 'assistant' as const,
    uuid: crypto.randomUUID(),
    requestId: 'req_test',
    message: {
      id: 'msg_test',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text' as const, text: 'done' }],
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: 'standard' as const,
        cache_creation: null,
      },
    },
  }
}

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
} as unknown as AppState

const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

registerAsyncAgent({
  agentId: 'agent-ordering-test',
  description: 'Ordering test',
  prompt: 'finish',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_test',
})

let resolveWorktree: (() => void) | undefined
const worktreeStarted = new Promise<void>(resolve => {
  resolveWorktree = resolve
})

const lifecycle = runAsyncAgentLifecycle({
  taskId: 'agent-ordering-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'finish',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Ordering test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_test',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-ordering-test',
  enableSummarization: false,
  getWorktreeResult: () =>
    new Promise(resolve => {
      resolveWorktree?.()
      setTimeout(() => resolve({}), 50)
    }),
})

await worktreeStarted

const task = state.tasks['agent-ordering-test']
assert.equal(isLocalAgentTask(task), true)
assert.equal(task.status, 'completed')
assert.equal((task.result as AgentToolResult).agentId, 'agent-ordering-test')

await lifecycle

console.log('asyncLifecycleOrdering.test.ts passed')
```

- [ ] **Step 2: Run test**

Run:

```bash
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
```

Expected:

```text
asyncLifecycleOrdering.test.ts passed
```

If the minimal `AppState` shape is insufficient, add only the missing properties shown by the runtime error. Do not change production ordering to make the test easier.

---

## Task 12: Full static verification

**Files:**
- All changed files.

- [ ] **Step 1: Run all targeted tests**

Run:

```bash
bun src/tools/AgentTool/agentTypeResolver.test.ts
bun src/tools/AgentTool/mcpAvailability.test.ts
bun src/tools/AgentTool/asyncLifecycleOrdering.test.ts
bun src/tools/AgentTool/subagentDepth.test.ts
bun src/tools/AgentTool/AgentTool.nesting.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run lint**

Run:

```bash
bun run lint
```

Expected: no lint errors.

- [ ] **Step 3: Build binary**

Run:

```bash
make build
```

Expected:

```text
CLAUDE_CODE_VERSION=2.1.176 bun package:binary
...
./built-claude exists and is executable
```

- [ ] **Step 4: Inspect diff**

Run:

```bash
git diff -- src/tools/AgentTool src/tasks/LocalAgentTask src/types/tools.ts docs/superpowers/plans/2026-07-04-agent-upgrade-official-parity.md
```

Expected:

```text
Only planned files changed. No debug logs, no skipped tests, no unrelated formatting churn.
```

---

## Task 13: Interactive parity validation

**Files:**
- No code changes expected.
- Capture InteractiveTerminal output paths in final notes.

- [ ] **Step 1: Start official Claude**

Use InteractiveTerminal open with:

```bash
./official-claude --dangerously-skip-permissions
```

Send prompt:

```text
Use the Agent tool with subagent_type "general purpose" and prompt "Reply with READY only". Use description "Parity check".
```

Expected:

```text
Official either normalizes to general-purpose or returns a clear not-found/available-agents error. Record exact behavior.
```

- [ ] **Step 2: Start built Claude**

Use InteractiveTerminal open with:

```bash
./built-claude --dangerously-skip-permissions
```

Send the same prompt:

```text
Use the Agent tool with subagent_type "general purpose" and prompt "Reply with READY only". Use description "Parity check".
```

Expected after this implementation:

```text
Built Claude accepts normalized "general purpose" as general-purpose, unless official parity gate showed a different required behavior.
```

- [ ] **Step 3: Validate async launched text**

In built Claude, send:

```text
Use the Agent tool with run_in_background true, description "Async parity", and prompt "Reply with READY after one short step".
```

Expected:

```text
The tool result includes task id / output file and says completion notification will arrive.
The text does not encourage proactively reading or tailing the full transcript.
```

- [ ] **Step 4: Validate cwd/worktree mutual exclusion**

If `cwd` is visible in this build’s Agent schema, send a direct tool-use inducing prompt:

```text
Try to launch an Agent with cwd set to the current repository path and isolation set to "worktree". Report the exact error.
```

Expected:

```text
cwd is mutually exclusive with isolation: "worktree"
```

No worktree directory should be created and no agent task should be registered.

- [ ] **Step 5: Validate invalid and ambiguous type messaging**

Send:

```text
Use the Agent tool with subagent_type "definitely-missing-agent" and prompt "Reply READY".
```

Expected:

```text
Error lists available agents and does not start an agent.
```

Ambiguous matching requires controlled agent definitions. If not available in current config, rely on `agentTypeResolver.test.ts` for the ambiguous branch.

---

## Task 14: Final review and user handoff

**Files:**
- All changed files.

- [ ] **Step 1: Review spec coverage**

Confirm each spec item maps to completed work:

```text
1. normalized matching + ambiguous prompt -> agentTypeResolver.ts/test + AgentTool wiring
2. async text avoids full JSONL encouragement -> AgentTool mapToolResult text
3. miss error improved -> agentTypeResolver.ts/test
4. required MCP server merges current tool pool -> mcpAvailability.ts/test + AgentTool wiring
5. runAgentParams context fields -> runAgent.ts + AgentTool runAgentParams
6. MCP blocked/unavailable notification -> implemented if event source exists, otherwise documented as deferred with reason
7. async completion order preserved -> asyncLifecycleOrdering.test.ts
8. sync progress payload agentType/description -> src/types/tools.ts + AgentTool progress payloads
9. cwd/worktree early validation -> AgentTool validation moved before side effects
```

- [ ] **Step 2: Check intentional divergences**

Confirm final notes explicitly state:

```text
The local async lifecycle intentionally completes the task before classifier/worktree cleanup/notification so TaskOutput(block=true) is not blocked by slow cleanup. Covered by asyncLifecycleOrdering.test.ts.
```

- [ ] **Step 3: Verify no forbidden changes**

Run:

```bash
git status --short
git diff --check
```

Expected:

```text
Only planned files changed.
No whitespace errors.
No commit created.
```

- [ ] **Step 4: Handoff response**

Report concisely in Chinese:

```markdown
完成：
- Agent type resolver 支持 exact/normalized/ambiguous/denied/unknown。
- required MCP server 检查合并 app state 与当前 tool pool。
- cwd + worktree 提前失败。
- async launched 文案不再鼓励读取完整 transcript。
- sync progress payload 包含 agentType/description。
- 保留 async task 先 completed 的 intentional divergence，并加测试。

验证：
- `bun ...`
- `bun run lint`
- `make build`
- InteractiveTerminal official/built parity: <capture paths>

未完成/风险：
- <如果 MCP blocked callback 无可靠事件源，在这里说明>
```

Do not commit unless the user explicitly asks.

---

## Self-Review

### Spec coverage

- Agent type resolver: covered by Tasks 2-4.
- MCP checker: covered by Tasks 5-6.
- cwd/worktree early validation: covered by Task 7 and Task 13.
- runAgent params enrichment: covered by Task 10.
- MCP blocked notification: covered by Task 10 with an explicit no-fabrication rule.
- Async text: covered by Task 9 and Task 13.
- Lifecycle ordering divergence: covered by Task 11.
- Progress payload: covered by Task 8.
- Official lifecycle parity gate: covered by Task 1 and Task 13.

### Placeholder scan

No `TBD`, `TODO`, `implement later`, or “similar to” placeholders are used as implementation instructions. The only conditional branch is MCP blocked notification, because the current code must be inspected for a real event source before implementation.

### Type consistency

- `resolveAgentType()` returns `{ agent, matchKind, requestedType }` and `AgentTool.tsx` uses `.agent`.
- `getAvailableMcpServerNames()` accepts `Tools` for both app-state MCP tools and current tool pool.
- `getMissingRequiredMcpServers()` reuses `AgentDefinition.requiredMcpServers` and the existing `hasRequiredMcpServers()` matching semantics.
- `runAgent()` metadata fields are optional and must not change behavior unless connected to existing lifecycle code.
