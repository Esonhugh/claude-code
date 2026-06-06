# Official Dynamic Workflows Runtime Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next official-compatible Dynamic Workflows runtime layer: first-statement `meta` parsing, official event helpers, runtime globals, same-session resume cache, and facade/session integration.

**Architecture:** Keep the existing `WorkflowFacadeTool` and `runWorkflowPlan` path, but split official compatibility concerns into small modules. `workflowScriptParser.ts` validates official script shape, `workflowEvents.ts` centralizes event names, `workflowRuntimeGlobals.ts` builds official globals over a plan-building adapter, and `workflowResumeCache.ts` provides prefix-cache behavior that can be used by the facade and later by a true streaming scheduler.

**Tech Stack:** TypeScript ESM, Node.js `vm`, Node assert-based test files bundled by `scripts/run-workflow-tests.mjs`, existing `WorkflowTool` types, existing `.claude/workflow-runs` persistence.

---

## File structure

- Create: `src/tools/WorkflowTool/workflowScriptParser.ts` — official script parser and pure-literal `meta` validator.
- Create: `src/tools/WorkflowTool/workflowScriptParser.test.ts` — parser validation tests.
- Create: `src/tools/WorkflowTool/workflowEvents.ts` — official event constructors and event-name constants.
- Create: `src/tools/WorkflowTool/workflowEvents.test.ts` — event helper tests.
- Create: `src/tools/WorkflowTool/workflowResumeCache.ts` — same-session unchanged-prefix cache helpers.
- Create: `src/tools/WorkflowTool/workflowResumeCache.test.ts` — cache hit/miss behavior tests.
- Create: `src/tools/WorkflowTool/workflowRuntimeGlobals.ts` — official globals for `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`, and `budget`.
- Create: `src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts` — runtime helper behavior tests.
- Modify: `src/tools/WorkflowTool/workflowSpec.ts` — add event timestamps/cache metadata and optional workflow `meta` field.
- Modify: `src/tools/WorkflowTool/workflowDsl.ts` — use official parser for `export const meta` scripts while keeping the existing legacy declarative loader path.
- Modify: `src/tools/WorkflowTool/workflowDsl.test.ts` — add official script tests.
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts` — persist `meta`, event timestamps, and resume cache entries.
- Modify: `src/tools/WorkflowTool/runWorkflow.ts` — emit events via `workflowEvents.ts` helpers.
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts` — pass resume metadata and official script output through the same run path.
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts` — assert official-style inline scripts and session metadata.
- Modify: `scripts/run-workflow-tests.mjs` — include the new test files.
- Modify: `docs/official-dynamic-workflows-binary-analysis.md` — note implemented coverage after code is in place.
- Modify: `docs/workflow-compatibility-experiments.md` — update runtime compatibility rows after verification.

---

### Task 1: Add official workflow script parser

**Files:**
- Create: `src/tools/WorkflowTool/workflowScriptParser.ts`
- Create: `src/tools/WorkflowTool/workflowScriptParser.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing parser test**

Create `src/tools/WorkflowTool/workflowScriptParser.test.ts`:

```ts
import assert from 'node:assert/strict'

import {
  parseWorkflowScript,
  WorkflowScriptParseError,
} from './workflowScriptParser.js'

const validScript = `export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
}

phase('Scan')
const flaky = await agent('Find flaky tests')
return flaky
`

const cases: Array<[string, RegExp]> = [
  ['const x = 1\nexport const meta = { name: "x", description: "y" }', /must be the FIRST statement/],
  ['export let meta = { name: "x", description: "y" }', /export const meta/],
  ['export const meta = { name: "", description: "y" }', /meta\.name/],
  ['export const meta = { name: "x", description: "" }', /meta\.description/],
  ['export const meta = { name: "x", description: "y", value: compute() }', /pure literal/],
  ['export const meta = { name: "x", description: "y", ...extra }', /pure literal/],
  ['export const meta = { name: `x ${value}`, description: "y" }', /pure literal/],
  ['export const meta = { ["name"]: "x", description: "y" }', /pure literal/],
  ['export const meta: any = { name: "x", description: "y" }', /plain JavaScript/],
]

const parsed = parseWorkflowScript(validScript)
assert.deepEqual(parsed.meta, {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
})
assert.equal(parsed.scriptBody.startsWith("phase('Scan')"), true)

for (const [source, pattern] of cases) {
  assert.throws(
    () => parseWorkflowScript(source),
    (error: unknown) => {
      assert.equal(error instanceof WorkflowScriptParseError, true)
      assert.match(String((error as Error).message), pattern)
      return true
    },
  )
}

console.log('workflowScriptParser.test.ts passed')
```

- [ ] **Step 2: Run the parser test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowScriptParser.test.ts
```

Expected: FAIL with `Cannot find module './workflowScriptParser.js'`.

- [ ] **Step 3: Implement the parser module**

Create `src/tools/WorkflowTool/workflowScriptParser.ts`:

```ts
export type WorkflowMetaPhase = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowScriptMeta = {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowMetaPhase[]
}

export type ParsedWorkflowScript = {
  meta: WorkflowScriptMeta
  scriptBody: string
}

export class WorkflowScriptParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowScriptParseError'
  }
}

const META_PREFIX = /^\s*export\s+const\s+meta\s*=\s*/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function throwParse(message: string): never {
  throw new WorkflowScriptParseError(message)
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (quote === '`' && char === '$' && next === '{') {
        throwParse('meta must be a pure literal: template interpolation not allowed in meta')
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  throwParse('meta must be a pure literal: unterminated object literal')
}

function parseObjectLiteral(objectLiteral: string): unknown {
  if (/\.\.\./.test(objectLiteral)) {
    throwParse('meta must be a pure literal: spread not allowed in meta')
  }
  if (/=>|\bfunction\b/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: functions not allowed in meta')
  }
  if (/\[[^\]]+\]\s*:/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: computed keys not allowed in meta')
  }
  if (/`[^`]*\$\{/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: template interpolation not allowed in meta')
  }
  try {
    return Function(`"use strict"; return (${objectLiteral})`)() as unknown
  } catch (error) {
    throwParse(`meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertPlainLiteral(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertPlainLiteral(value[index], `${path}[${index}]`)
    }
    return
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throwParse(`meta must be a pure literal: ${path} is not a plain object`)
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key)) {
        throwParse(`meta must be a pure literal: reserved key ${key} not allowed in meta`)
      }
      assertPlainLiteral(nested, `${path}.${key}`)
    }
    return
  }

  throwParse(`meta must be a pure literal: ${path} has unsupported value`)
}

function normalizeMeta(value: unknown): WorkflowScriptMeta {
  assertPlainLiteral(value, 'meta')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwParse('meta must be a pure literal object')
  }
  const meta = value as Record<string, unknown>
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    throwParse('meta.name must be a non-empty string')
  }
  if (typeof meta.description !== 'string' || meta.description.length === 0) {
    throwParse('meta.description must be a non-empty string')
  }
  if (meta.title !== undefined && typeof meta.title !== 'string') {
    throwParse('meta.title must be a string when present')
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
    throwParse('meta.whenToUse must be a string when present')
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throwParse('meta.phases must be an array when present')
    for (const phase of meta.phases) {
      if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
        throwParse('meta.phases entries must be objects')
      }
      const candidate = phase as Record<string, unknown>
      if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
        throwParse('meta.phases entries require a non-empty title')
      }
      if (candidate.detail !== undefined && typeof candidate.detail !== 'string') {
        throwParse('meta.phases detail must be a string when present')
      }
      if (candidate.model !== undefined && typeof candidate.model !== 'string') {
        throwParse('meta.phases model must be a string when present')
      }
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
    ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    ...(Array.isArray(meta.phases) ? { phases: meta.phases as WorkflowMetaPhase[] } : {}),
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  if (/^\s*export\s+const\s+meta\s*:/.test(source)) {
    throwParse('Workflow scripts must be plain JavaScript; TypeScript syntax fails to parse.')
  }
  const match = META_PREFIX.exec(source)
  if (!match) {
    if (/export\s+const\s+meta\s*=/.test(source)) {
      throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
    }
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }
  const objectStart = match[0].length
  if (source[objectStart] !== '{') {
    throwParse('meta must be a pure literal object')
  }
  const objectEnd = findObjectEnd(source, objectStart)
  const objectLiteral = source.slice(objectStart, objectEnd)
  const meta = normalizeMeta(parseObjectLiteral(objectLiteral))
  const scriptBody = source.slice(objectEnd).replace(/^[;\s]*/, '')
  return { meta, scriptBody }
}
```

- [ ] **Step 4: Run the parser test and verify it passes**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowScriptParser.test.ts
```

Expected: PASS and prints `workflowScriptParser.test.ts passed`.

- [ ] **Step 5: Add parser test to the workflow test runner**

Modify `scripts/run-workflow-tests.mjs` and add this entry after `workflowDiscovery.test.ts`:

```js
'src/tools/WorkflowTool/workflowScriptParser.test.ts',
```

- [ ] **Step 6: Run all workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit parser changes**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/workflowScriptParser.ts src/tools/WorkflowTool/workflowScriptParser.test.ts
git commit -m "feat: add official workflow script parser"
```

---

### Task 2: Centralize official workflow events

**Files:**
- Create: `src/tools/WorkflowTool/workflowEvents.ts`
- Create: `src/tools/WorkflowTool/workflowEvents.test.ts`
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing event helper test**

Create `src/tools/WorkflowTool/workflowEvents.test.ts`:

```ts
import assert from 'node:assert/strict'

import {
  createWorkflowAgentEvent,
  createWorkflowLogEvent,
  createWorkflowPhaseEvent,
  createWorkflowProgressEvent,
  WORKFLOW_EVENT_TYPES,
} from './workflowEvents.js'

assert.deepEqual(WORKFLOW_EVENT_TYPES, [
  'workflow_progress',
  'workflow_phase',
  'workflow_agent',
  'workflow_log',
])

assert.deepEqual(
  createWorkflowProgressEvent({
    workflowRunId: 'wf_test',
    status: 'running',
    completedAgents: 1,
    totalAgents: 3,
    timestamp: 10,
  }),
  {
    type: 'workflow_progress',
    workflowRunId: 'wf_test',
    status: 'running',
    completedAgents: 1,
    totalAgents: 3,
    timestamp: 10,
  },
)

assert.deepEqual(
  createWorkflowPhaseEvent({
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    status: 'completed',
    timestamp: 11,
  }),
  {
    type: 'workflow_phase',
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    status: 'completed',
    timestamp: 11,
  },
)

assert.deepEqual(
  createWorkflowAgentEvent({
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    agentId: 'agent-1',
    status: 'completed',
    cacheHit: true,
    timestamp: 12,
  }),
  {
    type: 'workflow_agent',
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    agentId: 'agent-1',
    status: 'completed',
    cacheHit: true,
    timestamp: 12,
  },
)

assert.deepEqual(
  createWorkflowLogEvent({
    workflowRunId: 'wf_test',
    message: 'started',
    timestamp: 13,
  }),
  {
    type: 'workflow_log',
    workflowRunId: 'wf_test',
    message: 'started',
    timestamp: 13,
  },
)

console.log('workflowEvents.test.ts passed')
```

- [ ] **Step 2: Run the event test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowEvents.test.ts
```

Expected: FAIL with `Cannot find module './workflowEvents.js'`.

- [ ] **Step 3: Implement event helpers**

Create `src/tools/WorkflowTool/workflowEvents.ts`:

```ts
import type { WorkflowProgressEvent } from './workflowSpec.js'

export const WORKFLOW_EVENT_TYPES = [
  'workflow_progress',
  'workflow_phase',
  'workflow_agent',
  'workflow_log',
] as const

export function createWorkflowProgressEvent(input: {
  workflowRunId: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  completedAgents: number
  totalAgents: number
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_progress',
    workflowRunId: input.workflowRunId,
    status: input.status,
    completedAgents: input.completedAgents,
    totalAgents: input.totalAgents,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowPhaseEvent(input: {
  workflowRunId: string
  phaseId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_phase',
    workflowRunId: input.workflowRunId,
    phaseId: input.phaseId,
    status: input.status,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowAgentEvent(input: {
  workflowRunId: string
  phaseId: string
  agentId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  cacheHit?: boolean
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_agent',
    workflowRunId: input.workflowRunId,
    phaseId: input.phaseId,
    agentId: input.agentId,
    status: input.status,
    ...(input.cacheHit !== undefined ? { cacheHit: input.cacheHit } : {}),
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowLogEvent(input: {
  workflowRunId: string
  message: string
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_log',
    workflowRunId: input.workflowRunId,
    message: input.message,
    timestamp: input.timestamp ?? Date.now(),
  }
}
```

- [ ] **Step 4: Extend the event type**

Modify `src/tools/WorkflowTool/workflowSpec.ts` so every `WorkflowProgressEvent` union member includes `timestamp: number`, and the `workflow_agent` member includes optional `cacheHit?: boolean`:

```ts
export type WorkflowProgressEvent =
  | {
      type: 'workflow_progress'
      workflowRunId: string
      status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
      completedAgents: number
      totalAgents: number
      timestamp: number
    }
  | {
      type: 'workflow_phase'
      workflowRunId: string
      phaseId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
      timestamp: number
    }
  | {
      type: 'workflow_agent'
      workflowRunId: string
      phaseId: string
      agentId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
      cacheHit?: boolean
      timestamp: number
    }
  | {
      type: 'workflow_log'
      workflowRunId: string
      message: string
      timestamp: number
    }
```

- [ ] **Step 5: Use helpers in the existing runner**

Modify `src/tools/WorkflowTool/runWorkflow.ts` imports:

```ts
import {
  createWorkflowAgentEvent,
  createWorkflowLogEvent,
  createWorkflowPhaseEvent,
  createWorkflowProgressEvent,
} from './workflowEvents.js'
```

Replace inline event object creation with helper calls. For example:

```ts
await emit(createWorkflowProgressEvent({
  workflowRunId,
  status: 'running',
  completedAgents: 0,
  totalAgents: plan.totalAgents,
}))

await emit(createWorkflowLogEvent({
  workflowRunId,
  message: `Workflow started: ${plan.name}`,
}))
```

And for phase/agent completion:

```ts
await emit(createWorkflowPhaseEvent({
  workflowRunId,
  phaseId: phase.id,
  status: 'completed',
}))

await emit(createWorkflowAgentEvent({
  workflowRunId,
  phaseId: phase.id,
  agentId: result.agentId,
  status: result.status,
}))
```

- [ ] **Step 6: Add event test to the workflow runner**

Modify `scripts/run-workflow-tests.mjs` and add after `workflowSpec.test.ts`:

```js
'src/tools/WorkflowTool/workflowEvents.test.ts',
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowEvents.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: both commands PASS.

- [ ] **Step 8: Commit event changes**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/workflowSpec.ts src/tools/WorkflowTool/workflowEvents.ts src/tools/WorkflowTool/workflowEvents.test.ts src/tools/WorkflowTool/runWorkflow.ts
git commit -m "feat: centralize workflow progress events"
```

---

### Task 3: Add same-session resume cache helpers

**Files:**
- Create: `src/tools/WorkflowTool/workflowResumeCache.ts`
- Create: `src/tools/WorkflowTool/workflowResumeCache.test.ts`
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing resume cache test**

Create `src/tools/WorkflowTool/workflowResumeCache.test.ts`:

```ts
import assert from 'node:assert/strict'

import {
  createAgentCallIdentity,
  createWorkflowResumeCursor,
  recordResumeCacheEntry,
  type WorkflowResumeCacheEntry,
} from './workflowResumeCache.js'

const firstIdentity = createAgentCallIdentity({
  index: 0,
  phase: 'Scan',
  prompt: 'Find files',
  opts: { label: 'scan', schema: { type: 'object' } },
})
const secondIdentity = createAgentCallIdentity({
  index: 1,
  phase: 'Verify',
  prompt: 'Verify files',
  opts: { label: 'verify' },
})

const priorEntries: WorkflowResumeCacheEntry[] = [
  recordResumeCacheEntry({
    index: 0,
    identity: firstIdentity,
    phase: 'Scan',
    label: 'scan',
    result: { files: ['a.ts'] },
  }),
  recordResumeCacheEntry({
    index: 1,
    identity: secondIdentity,
    phase: 'Verify',
    label: 'verify',
    result: 'verified',
  }),
]

const cursor = createWorkflowResumeCursor(priorEntries)
assert.deepEqual(cursor.lookup(0, firstIdentity), {
  cacheHit: true,
  result: { files: ['a.ts'] },
})
assert.deepEqual(cursor.lookup(1, secondIdentity), {
  cacheHit: true,
  result: 'verified',
})

const changedIdentity = createAgentCallIdentity({
  index: 2,
  phase: 'Synthesize',
  prompt: 'Synthesize changed prompt',
  opts: { label: 'synthesize' },
})
assert.deepEqual(cursor.lookup(2, changedIdentity), { cacheHit: false })
assert.deepEqual(cursor.lookup(0, firstIdentity), { cacheHit: false })

assert.notEqual(
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find files', opts: { label: 'scan' } }),
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find changed files', opts: { label: 'scan' } }),
)

console.log('workflowResumeCache.test.ts passed')
```

- [ ] **Step 2: Run the resume cache test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowResumeCache.test.ts
```

Expected: FAIL with `Cannot find module './workflowResumeCache.js'`.

- [ ] **Step 3: Implement resume cache helpers**

Create `src/tools/WorkflowTool/workflowResumeCache.ts`:

```ts
import { createHash } from 'node:crypto'

export type WorkflowResumeCacheEntry = {
  index: number
  identity: string
  phase?: string
  label?: string
  result: unknown
  completedAt: number
}

export type WorkflowResumeLookup =
  | { cacheHit: true; result: unknown }
  | { cacheHit: false }

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createAgentCallIdentity(input: {
  index: number
  phase?: string
  prompt: string
  opts?: unknown
}): string {
  return sha256(stableJson(input))
}

export function recordResumeCacheEntry(input: {
  index: number
  identity: string
  phase?: string
  label?: string
  result: unknown
  completedAt?: number
}): WorkflowResumeCacheEntry {
  return {
    index: input.index,
    identity: input.identity,
    phase: input.phase,
    label: input.label,
    result: input.result,
    completedAt: input.completedAt ?? Date.now(),
  }
}

export function createWorkflowResumeCursor(entries: WorkflowResumeCacheEntry[]) {
  let prefixBroken = false
  const byIndex = new Map(entries.map(entry => [entry.index, entry]))

  return {
    lookup(index: number, identity: string): WorkflowResumeLookup {
      if (prefixBroken) return { cacheHit: false }
      const entry = byIndex.get(index)
      if (!entry || entry.identity !== identity) {
        prefixBroken = true
        return { cacheHit: false }
      }
      return { cacheHit: true, result: entry.result }
    },
  }
}
```

- [ ] **Step 4: Extend run session shape with cache entries**

Modify `src/tools/WorkflowTool/workflowRunSessions.ts`:

```ts
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'

export type WorkflowRunSession = {
  taskId: string
  workflowRunId: string
  workflowName: string
  status: 'running' | 'completed' | 'failed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
  runtime?: WorkflowDryRunPlan['runtime']
  sourcePath?: string
  runScriptSnapshot?: string
  startedAt: number
  updatedAt: number
  results: WorkflowAgentResult[]
  events: WorkflowProgressEvent[]
  error?: string
}
```

In `startWorkflowRunSession`, initialize:

```ts
resumeCacheEntries: [],
```

- [ ] **Step 5: Add resume cache test to runner**

Modify `scripts/run-workflow-tests.mjs` and add after `workflowEvents.test.ts`:

```js
'src/tools/WorkflowTool/workflowResumeCache.test.ts',
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowResumeCache.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: both commands PASS.

- [ ] **Step 7: Commit resume cache helpers**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/workflowRunSessions.ts src/tools/WorkflowTool/workflowResumeCache.ts src/tools/WorkflowTool/workflowResumeCache.test.ts
git commit -m "feat: add workflow resume cache helpers"
```

---

### Task 4: Add official runtime globals as a plan-building adapter

**Files:**
- Create: `src/tools/WorkflowTool/workflowRuntimeGlobals.ts`
- Create: `src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing runtime globals test**

Create `src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts`:

```ts
import assert from 'node:assert/strict'

import { createWorkflowRuntimeGlobals } from './workflowRuntimeGlobals.js'

const logs: string[] = []
const globals = createWorkflowRuntimeGlobals({
  args: { topic: 'workflow runtime' },
  workflowRunId: 'wf_runtime',
  budgetTotal: 10,
  log: message => logs.push(message),
})

assert.deepEqual(globals.args, { topic: 'workflow runtime' })
assert.equal(globals.budget.total, 10)
assert.equal(globals.budget.spent(), 0)
assert.equal(globals.budget.remaining(), 10)

globals.phase('Scan')
globals.log('started')
assert.deepEqual(logs, ['started'])

const first = await globals.agent('Find files', {
  label: 'scan',
  schema: { type: 'object' },
})
assert.deepEqual(first, { label: 'scan', output: '{{agent:scan}}' })

const parallel = await globals.parallel([
  () => globals.agent('A', { label: 'a' }),
  () => globals.agent('B', { label: 'b' }),
])
assert.deepEqual(parallel.map(item => item && item.label), ['a', 'b'])

const pipeline = await globals.pipeline(
  ['one', 'two'],
  item => globals.agent(`stage1 ${item}`, { label: `stage1-${item}` }),
  (prior, original) => globals.agent(`stage2 ${prior?.label} ${original}`, { label: `stage2-${original}` }),
)
assert.deepEqual(pipeline.map(item => item && item.label), ['stage2-one', 'stage2-two'])

assert.throws(() => globals.Date.now(), /Date\.now\(\) \/ new Date\(\) are unavailable/)
assert.throws(() => globals.Math.random(), /Math\.random\(\) is unavailable/)
assert.equal(globals.Math.max(1, 3, 2), 3)

const spec = globals.toWorkflowSpec({
  name: 'official-runtime',
  description: 'Official runtime adapter',
})
assert.equal(spec.name, 'official-runtime')
assert.deepEqual(spec.phases.map(phase => phase.id), [
  'scan',
  'a',
  'b',
  'stage1-one',
  'stage2-one',
  'stage1-two',
  'stage2-two',
])
assert.equal(spec.phases[0]?.description, 'scan')
assert.equal(spec.phases[0]?.prompt, 'Find files')

console.log('workflowRuntimeGlobals.test.ts passed')
```

- [ ] **Step 2: Run the runtime globals test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts
```

Expected: FAIL with `Cannot find module './workflowRuntimeGlobals.js'`.

- [ ] **Step 3: Implement runtime globals**

Create `src/tools/WorkflowTool/workflowRuntimeGlobals.ts`:

```ts
import type { WorkflowArgs, WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

export const DATE_ERROR = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'
export const RANDOM_ERROR = 'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.'

export type WorkflowRuntimeAgentOptions = {
  label?: string
  phase?: string
  schema?: object
  model?: string
  isolation?: 'worktree'
  agentType?: string
}

export type WorkflowRuntimeAgentResult = {
  label: string
  output: string
}

type PipelineStage<TInput, TOutput> = (
  value: TInput,
  original: unknown,
  index: number,
) => Promise<TOutput> | TOutput

function createWorkflowMath(): Math {
  const workflowMath = Object.create(Math) as Math
  Object.defineProperty(workflowMath, 'random', {
    value: () => {
      throw new Error(RANDOM_ERROR)
    },
  })
  return Object.freeze(workflowMath)
}

function WorkflowDate(): never {
  throw new Error(DATE_ERROR)
}

export function createWorkflowRuntimeGlobals({
  args,
  workflowRunId,
  budgetTotal = null,
  log,
}: {
  args?: WorkflowArgs
  workflowRunId: string
  budgetTotal?: number | null
  log?: (message: string) => void
}) {
  const phases: WorkflowPhaseSpec[] = []
  let currentPhase: string | undefined
  let callIndex = 0
  let spent = 0

  function nextLabel(opts: WorkflowRuntimeAgentOptions | undefined): string {
    return opts?.label || `agent-${callIndex + 1}`
  }

  const globals = {
    args,
    Date: Object.assign(WorkflowDate, { now: WorkflowDate, parse: Date.parse, UTC: Date.UTC }),
    Math: createWorkflowMath(),
    budget: {
      total: budgetTotal,
      spent: () => spent,
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - spent)),
    },
    phase(title: string): void {
      currentPhase = title
    },
    log(message: string): void {
      log?.(message)
    },
    async agent(
      prompt: string,
      opts?: WorkflowRuntimeAgentOptions,
    ): Promise<WorkflowRuntimeAgentResult> {
      if (budgetTotal !== null && spent >= budgetTotal) {
        throw new Error('WorkflowBudgetExceededError')
      }
      const label = nextLabel(opts)
      callIndex += 1
      spent += 1
      phases.push({
        id: label,
        description: label,
        prompt,
        ...(opts?.phase || currentPhase ? { dependsOn: undefined } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.agentType ? { agentType: opts.agentType } : {}),
      })
      return { label, output: `{{agent:${label}}}` }
    },
    async parallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
      return Promise.all(
        thunks.map(async thunk => {
          try {
            return await thunk()
          } catch {
            return null
          }
        }),
      )
    },
    async pipeline(items: unknown[], ...stages: PipelineStage<unknown, unknown>[]): Promise<unknown[]> {
      return Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item
          for (const stage of stages) {
            if (value === null) return null
            try {
              value = await stage(value, item, index)
            } catch {
              return null
            }
          }
          return value
        }),
      )
    },
    async workflow(): Promise<never> {
      throw new Error('workflow() child execution is not available in the plan-building adapter')
    },
    toWorkflowSpec(meta: { name: string; description: string }): WorkflowSpec {
      return {
        name: meta.name,
        description: meta.description,
        phases,
        runtime: { kind: 'javascript-worker', isolated: true },
      }
    },
  }

  return globals
}
```

- [ ] **Step 4: Run the runtime globals test**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts
```

Expected: PASS and prints `workflowRuntimeGlobals.test.ts passed`.

- [ ] **Step 5: Add runtime globals test to runner**

Modify `scripts/run-workflow-tests.mjs` and add after `workflowResumeCache.test.ts`:

```js
'src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts',
```

- [ ] **Step 6: Run all workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit runtime globals**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/workflowRuntimeGlobals.ts src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts
git commit -m "feat: add workflow runtime globals adapter"
```

---

### Task 5: Load official `export const meta` scripts in `workflowDsl.ts`

**Files:**
- Modify: `src/tools/WorkflowTool/workflowDsl.ts`
- Modify: `src/tools/WorkflowTool/workflowDsl.test.ts`
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`

- [ ] **Step 1: Add failing official script loader tests**

Append to `src/tools/WorkflowTool/workflowDsl.test.ts`:

```ts
const officialScriptPath = join(tempRoot, 'docs', 'workflows', 'official-meta.js')
await writeFile(
  officialScriptPath,
  `export const meta = {
    name: 'official-meta-workflow',
    description: 'Official-style metadata workflow',
    phases: [{ title: 'Scan', detail: 'Find files' }],
  }

  phase('Scan')
  await agent('Find files for ' + args.topic, { label: 'scan', schema: { type: 'object' } })
  log('scan registered')
  `,
)

const officialSpec = await loadWorkflowScriptSpec(officialScriptPath, { topic: 'runtime' })
assert.equal(officialSpec.name, 'official-meta-workflow')
assert.equal(officialSpec.description, 'Official-style metadata workflow')
assert.equal(officialSpec.phases[0]?.id, 'scan')
assert.equal(officialSpec.phases[0]?.prompt, 'Find files for runtime')
assert.deepEqual(officialSpec.meta?.phases, [{ title: 'Scan', detail: 'Find files' }])
assert.equal(officialSpec.runtime?.kind, 'javascript-worker')
```

- [ ] **Step 2: Run DSL tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDsl.test.ts
```

Expected: FAIL because `loadWorkflowScriptSpec` does not understand first-statement `export const meta` scripts.

- [ ] **Step 3: Add optional meta to workflow specs**

Modify `src/tools/WorkflowTool/workflowSpec.ts`:

```ts
import type { WorkflowScriptMeta } from './workflowScriptParser.js'

export type WorkflowSpec = {
  name: string
  description: string
  inputs?: WorkflowInputSpec[]
  defaults?: WorkflowDefaults
  phases: WorkflowPhaseSpec[]
  output?: WorkflowOutputSpec
  runtime?: WorkflowRuntimeSpec
  sourcePath?: string
  runScriptSnapshot?: string
  meta?: WorkflowScriptMeta
}

export type WorkflowDryRunPlan = {
  name: string
  description: string
  defaults: Required<Pick<WorkflowDefaults, 'maxConcurrency' | 'maxAgents' | 'maxRetries' | 'fanout' | 'concurrency' | 'review' | 'permissionMode' | 'execution'>> & Pick<WorkflowDefaults, 'agentType' | 'model'>
  phases: WorkflowDryRunPhase[]
  totalAgents: number
  output?: WorkflowOutputSpec
  runtime?: WorkflowRuntimeSpec
  sourcePath?: string
  runScriptSnapshot?: string
  meta?: WorkflowScriptMeta
}
```

Update `validateWorkflowSpec.ts` to copy `spec.meta` into the returned plan.

- [ ] **Step 4: Add official loader path to `workflowDsl.ts`**

Modify `src/tools/WorkflowTool/workflowDsl.ts` imports:

```ts
import { parseWorkflowScript } from './workflowScriptParser.js'
import { createWorkflowRuntimeGlobals } from './workflowRuntimeGlobals.js'
```

Add this function above `loadWorkflowScriptSpec`:

```ts
async function loadOfficialWorkflowScriptSpec({
  filePath,
  source,
  args,
}: {
  filePath: string
  source: string
  args?: WorkflowArgs
}): Promise<WorkflowSpec> {
  const parsed = parseWorkflowScript(source)
  const logs: string[] = []
  const globals = createWorkflowRuntimeGlobals({
    args,
    workflowRunId: 'dry-run',
    log: message => logs.push(message),
  })
  const sandbox = vm.createContext({
    args,
    agent: globals.agent,
    pipeline: globals.pipeline,
    parallel: globals.parallel,
    phase: globals.phase,
    log: globals.log,
    workflow: globals.workflow,
    budget: globals.budget,
    Date: globals.Date,
    Math: globals.Math,
  })
  const script = new vm.Script(`(async () => {\n${parsed.scriptBody}\n})()`, { filename: filePath })
  await script.runInContext(sandbox, { timeout: 1000 })
  return structuredClone({
    ...globals.toWorkflowSpec({
      name: parsed.meta.name,
      description: parsed.meta.description,
    }),
    meta: parsed.meta,
    runtime: {
      kind: 'javascript-worker' as const,
      sourcePath: filePath,
      isolated: true,
    },
    sourcePath: filePath,
    runScriptSnapshot: source,
  })
}
```

Then update `loadWorkflowScriptSpec` after reading `source`:

```ts
const source = await readFile(filePath, 'utf8')
if (/^\s*export\s+const\s+meta\s*=/.test(source)) {
  return loadOfficialWorkflowScriptSpec({ filePath, source, args: parsedArgs })
}
```

Keep the existing legacy `export default workflow(...)` path below this check.

- [ ] **Step 5: Run DSL tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDsl.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: both commands PASS.

- [ ] **Step 6: Commit official script loader**

```bash
git add src/tools/WorkflowTool/workflowSpec.ts src/tools/WorkflowTool/validateWorkflowSpec.ts src/tools/WorkflowTool/workflowDsl.ts src/tools/WorkflowTool/workflowDsl.test.ts
git commit -m "feat: load official workflow meta scripts"
```

---

### Task 6: Persist official meta and cache metadata in run sessions

**Files:**
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`

- [ ] **Step 1: Add failing facade session assertions**

In `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`, add an inline official-style script run after the existing inline script run assertions:

```ts
launchedPrompts.length = 0
const officialRun = await WorkflowFacadeTool.call(
  {
    name: 'official-inline',
    args: { topic: 'meta' },
    script: `export const meta = {
      name: 'official-inline',
      description: 'Official inline workflow',
      phases: [{ title: 'Scan', detail: 'Scan topic' }],
    }
    phase('Scan')
    await agent('scan ' + args.topic, { label: 'scan' })`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_official_inline' } } as never,
)

assert.match(String(officialRun.data), /Workflow completed: official-inline/)
const officialWorkflowRunId = String(officialRun.data).match(/Workflow run ID: (\S+)/)?.[1]
assert.ok(officialWorkflowRunId)
const officialSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', officialWorkflowRunId, 'session.json'), 'utf8'),
)
assert.deepEqual(officialSession.meta, {
  name: 'official-inline',
  description: 'Official inline workflow',
  phases: [{ title: 'Scan', detail: 'Scan topic' }],
})
assert.deepEqual(officialSession.resumeCacheEntries, [])
assert.deepEqual(launchedPrompts, ['scan meta\n\nWorkflow user input:\n{\n  "topic": "meta"\n}'])
```

- [ ] **Step 2: Run facade tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: FAIL because the session does not persist `meta` and `resumeCacheEntries`.

- [ ] **Step 3: Persist meta and cache fields**

Modify `src/tools/WorkflowTool/workflowRunSessions.ts`:

```ts
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'
import type { WorkflowScriptMeta } from './workflowScriptParser.js'

export type WorkflowRunSession = {
  taskId: string
  workflowRunId: string
  workflowName: string
  status: 'running' | 'completed' | 'failed'
  runArgs?: WorkflowArgs
  scriptPath?: string
  resumeFromRunId?: string
  meta?: WorkflowScriptMeta
  resumeCacheEntries: WorkflowResumeCacheEntry[]
  runtime?: WorkflowDryRunPlan['runtime']
  sourcePath?: string
  runScriptSnapshot?: string
  startedAt: number
  updatedAt: number
  results: WorkflowAgentResult[]
  events: WorkflowProgressEvent[]
  error?: string
}
```

In `startWorkflowRunSession`, add:

```ts
meta: plan.meta,
resumeCacheEntries: [],
```

- [ ] **Step 4: Run facade tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: both commands PASS.

- [ ] **Step 5: Commit run session metadata changes**

```bash
git add src/tools/WorkflowTool/workflowRunSessions.ts src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
git commit -m "feat: persist official workflow session metadata"
```

---

### Task 7: Add first-pass resume cache behavior to facade reruns

**Files:**
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`

- [ ] **Step 1: Add failing resume behavior test**

In `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`, after the official inline run from Task 6, add:

```ts
launchedPrompts.length = 0
const cachedRerun = await WorkflowFacadeTool.call(
  {
    scriptPath: officialSession.scriptPath,
    args: { topic: 'meta' },
    resumeFromRunId: officialWorkflowRunId,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_cached_rerun' } } as never,
)

assert.match(String(cachedRerun.data), /Workflow completed: official-inline/)
assert.deepEqual(launchedPrompts, [])
const cachedWorkflowRunId = String(cachedRerun.data).match(/Workflow run ID: (\S+)/)?.[1]
assert.ok(cachedWorkflowRunId)
const cachedSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', cachedWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(cachedSession.resumeFromRunId, officialWorkflowRunId)
assert.equal(cachedSession.events.some((event: { type: string; cacheHit?: boolean }) => event.type === 'workflow_agent' && event.cacheHit), true)
```

- [ ] **Step 2: Run facade tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: FAIL because reruns still launch the agent instead of returning cached results.

- [ ] **Step 3: Add run session loading helper**

Modify `src/tools/WorkflowTool/workflowRunSessions.ts`:

```ts
import { readFile } from 'node:fs/promises'

export async function loadWorkflowRunSession({
  cwd,
  workflowRunId,
}: {
  cwd: string
  workflowRunId: string
}): Promise<WorkflowRunSession | undefined> {
  try {
    return JSON.parse(await readFile(runSessionPath(cwd, workflowRunId), 'utf8')) as WorkflowRunSession
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Record cache entries when agents complete**

Modify `src/tools/WorkflowTool/runWorkflow.ts` imports:

```ts
import {
  createAgentCallIdentity,
  createWorkflowResumeCursor,
  recordResumeCacheEntry,
} from './workflowResumeCache.js'
import { loadWorkflowRunSession } from './workflowRunSessions.js'
```

Before execution, load prior cache entries:

```ts
const priorSession = resumeFromRunId
  ? await loadWorkflowRunSession({ cwd, workflowRunId: resumeFromRunId })
  : undefined
const resumeCursor = createWorkflowResumeCursor(priorSession?.resumeCacheEntries ?? [])
const resumeCacheEntries = []
let globalAgentIndex = 0
```

Inside `runPhaseAgent`, before launching the Agent tool, compute identity:

```ts
const identity = createAgentCallIdentity({
  index: globalAgentIndex,
  phase: phase.id,
  prompt: buildAgentPrompt(phase, resultsByPhase, runArgs),
  opts: {
    label: workflowAgentName(plan, phase, index),
    model: phase.model,
    agentType: phase.agentType,
    permissionMode: phase.permissionMode,
  },
})
const cacheLookup = resumeCursor.lookup(globalAgentIndex, identity)
if (cacheLookup.cacheHit) {
  const cachedResult = cacheLookup.result as WorkflowAgentResult
  resumeCacheEntries.push(recordResumeCacheEntry({
    index: globalAgentIndex,
    identity,
    phase: phase.id,
    label: cachedResult.agentId,
    result: cachedResult,
  }))
  globalAgentIndex += 1
  completeWorkflowAgent({ taskId: workflowTask.id, result: cachedResult, setAppState })
  await emit(createWorkflowAgentEvent({
    workflowRunId,
    phaseId: phase.id,
    agentId: cachedResult.agentId,
    status: cachedResult.status,
    cacheHit: true,
  }))
  return cachedResult
}
```

After a live result completes:

```ts
resumeCacheEntries.push(recordResumeCacheEntry({
  index: globalAgentIndex,
  identity,
  phase: phase.id,
  label: result.agentId,
  result,
}))
globalAgentIndex += 1
```

Thread these values through helper signatures as needed. Keep the first pass simple: cache only whole phase agent results from the existing plan runner.

- [ ] **Step 5: Persist cache entries at completion**

Modify `completeWorkflowRunSession` and `failWorkflowRunSession` calls to accept the accumulated `resumeCacheEntries`, then write them to the session:

```ts
await completeWorkflowRunSession({
  cwd,
  session: runSession,
  results: allResults,
  resumeCacheEntries,
})
```

Update `completeWorkflowRunSession` signature:

```ts
export async function completeWorkflowRunSession({
  cwd,
  session,
  results,
  resumeCacheEntries = session.resumeCacheEntries,
}: {
  cwd: string
  session: WorkflowRunSession
  results: WorkflowAgentResult[]
  resumeCacheEntries?: WorkflowResumeCacheEntry[]
}): Promise<void> {
  await writeWorkflowRunSession(cwd, {
    ...session,
    status: 'completed',
    updatedAt: Date.now(),
    results,
    resumeCacheEntries,
    error: undefined,
  })
}
```

- [ ] **Step 6: Run facade tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: both commands PASS, and rerun does not add a launched prompt for the unchanged first call.

- [ ] **Step 7: Commit resume integration**

```bash
git add src/tools/WorkflowTool/workflowRunSessions.ts src/tools/WorkflowTool/runWorkflow.ts src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
git commit -m "feat: resume unchanged workflow agent calls"
```

---

### Task 8: Update compatibility docs and final verification

**Files:**
- Modify: `docs/official-dynamic-workflows-binary-analysis.md`
- Modify: `docs/workflow-compatibility-experiments.md`
- Modify: `docs/dynamic-workflow-agent-orchestration.md`

- [ ] **Step 1: Update binary analysis implementation status**

In `docs/official-dynamic-workflows-binary-analysis.md`, add a short subsection under `## Implementation goals`:

```md
### Local implementation status

The next runtime compatibility pass implements parser-level and run-session compatibility for official-style scripts: first-statement `export const meta`, official event helpers, runtime globals, persisted metadata, and same-session unchanged-prefix resume for completed agent calls. It remains a clean-room compatibility layer and does not copy proprietary built-in workflow source.
```

- [ ] **Step 2: Update compatibility matrix rows**

In `docs/workflow-compatibility-experiments.md`, update the rows for script syntax, deterministic runtime guards, event names, and resume behavior to mention:

```md
Local now validates official-style `export const meta` scripts, stores official event names with timestamps, and supports same-session unchanged-prefix cache hits for completed plan-runner agent calls. Arbitrary JavaScript continuation checkpointing remains out of scope.
```

- [ ] **Step 3: Update architecture map**

In `docs/dynamic-workflow-agent-orchestration.md`, add the new modules to the local repository map:

```md
- `src/tools/WorkflowTool/workflowScriptParser.ts` validates official-style JavaScript workflow metadata.
- `src/tools/WorkflowTool/workflowRuntimeGlobals.ts` exposes official-compatible orchestration globals for plan-building scripts.
- `src/tools/WorkflowTool/workflowEvents.ts` centralizes official event names and payload constructors.
- `src/tools/WorkflowTool/workflowResumeCache.ts` implements same-session unchanged-prefix cache reuse for completed agent calls.
```

- [ ] **Step 4: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 5: Run typecheck/build verification**

Run:

```bash
npx tsc --noEmit --pretty false
npm run build
```

Expected: both commands complete successfully.

- [ ] **Step 6: Run git diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 7: Commit docs and final verification updates**

```bash
git add docs/official-dynamic-workflows-binary-analysis.md docs/workflow-compatibility-experiments.md docs/dynamic-workflow-agent-orchestration.md
git commit -m "docs: update workflow runtime compatibility status"
```

---

## Self-review checklist

- Spec coverage: parser, runtime globals, events, persistence, resume cache, facade integration, tests, and documentation are all mapped to tasks.
- Placeholder scan: this plan contains no open-ended placeholders; each task includes exact files, code, commands, and expected outcomes.
- Type consistency: new event fields use `timestamp`; resume cache entries use `WorkflowResumeCacheEntry`; official script metadata uses `WorkflowScriptMeta`; tests reference the same exported names defined in implementation steps.

## Execution notes

- Do not remove the legacy declarative `export default workflow(...)` loader path in this pass; existing fixtures depend on it.
- Keep all workflow script execution inside the constrained VM boundary.
- Do not expose `process`, `require`, filesystem, shell, or MCP objects to workflow scripts.
- Commit steps are written for a future implementation worker; skip commits unless the user explicitly authorizes commits in the active session.
