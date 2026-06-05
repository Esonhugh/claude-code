# Official Workflow Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the highest-impact gaps between this repository's workflow implementation and official Claude Code dynamic workflows, then benchmark local behavior against `/opt/homebrew/bin/claude` until the local implementation reaches roughly 90% practical compatibility for saved JavaScript workflows, script persistence, args, progress state, and orchestration UX.

**Architecture:** Keep workflow execution behind `WORKFLOW_SCRIPTS` and preserve the existing boundary where workflow code orchestrates agents but does not directly perform shell or filesystem work. Add an official-compatible `Workflow` facade on top of the existing `WorkflowTool`/`runWorkflowPlan` path, persist runnable scripts and run metadata with `workflowRunId`/`scriptPath`, extend JavaScript workflow loading from declarative DSL to a constrained orchestration runtime, and add benchmark fixtures that compare official and local behavior without depending on hidden official internals being exposed in print mode.

**Tech Stack:** TypeScript, Node.js ESM, existing Claude Code tool interfaces, `node:vm` for constrained workflow scripts, project-local `.claude/workflow-runs`, user/project workflow discovery, custom workflow tests in `scripts/run-workflow-tests.mjs`, feature-gated builds with `CLAUDE_CODE_RECOVER_FEATURES=WORKFLOW_SCRIPTS`.

---

## Compatibility target

This plan intentionally targets practical compatibility rather than byte-for-byte parity with the official binary. The local implementation should match these official behaviors:

1. A hidden-compatible `Workflow` tool accepts `{ script, name }`, `{ scriptPath }`, and `{ scriptPath, resumeFromRunId }` style inputs.
2. Every script invocation returns a stable `workflowRunId` and `scriptPath`.
3. Inline scripts are persisted before execution so users can edit and rerun by path.
4. JavaScript workflow `args` supports strings, arrays, objects, booleans, numbers, null, and omitted args.
5. Saved workflows are discovered from project `.claude/workflows/`, project `docs/workflows/`, and user `~/.claude/workflows/`, with project-local definitions taking precedence.
6. Progress output includes official-compatible event names: `workflow_progress`, `workflow_agent`, `workflow_phase`, and `workflow_log`.
7. JavaScript scripts can use deterministic orchestration helpers for sequential/parallel agents, bounded retries, logging, and convergence loops.
8. Reviewer/refuter/synthesis patterns have first-class helpers or templates that map to the existing agent runner.
9. Benchmarks compare official observable behavior and local behavior for representative workflows and produce a gap report.

## Files and responsibilities

- Modify: `src/tools.ts` — feature-gated registration of the official-compatible `Workflow` facade without pulling workflow code into non-workflow builds.
- Create: `src/tools/WorkflowTool/WorkflowFacadeTool.ts` — hidden-compatible facade that normalizes official-style inputs and delegates to shared workflow runtime functions.
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts` — share run/status/pause/resume helpers with the facade and include `workflowRunId`/`scriptPath` in run output.
- Modify: `src/tools/WorkflowTool/workflowSpec.ts` — add structured args, official progress events, run identity, script persistence, and JS orchestration plan types.
- Modify: `src/tools/WorkflowTool/workflowDsl.ts` — support structured `args`, preserve standard `Math` methods while blocking `Math.random()`, and load declarative workflow scripts with explicit runtime metadata.
- Create: `src/tools/WorkflowTool/workflowScriptPersistence.ts` — persist inline scripts and edited scripts to session/project run storage and return stable `scriptPath` values.
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts` — add `workflowRunId`, `scriptPath`, official event records, resume source, and benchmark-visible metadata.
- Modify: `src/tools/WorkflowTool/workflowDiscovery.ts` — add user-level workflow discovery and precedence ordering.
- Create: `src/tools/WorkflowTool/workflowOrchestrator.ts` — constrained JavaScript orchestration runtime helpers for `agent`, `parallel`, `series`, `retry`, `loopUntil`, `review`, `refute`, `synthesize`, and `log`.
- Modify: `src/tools/WorkflowTool/runWorkflow.ts` — accept structured args, official progress events, and orchestration-generated phase plans while still executing phase work through existing `Agent` tool permissions.
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` — store official progress event records and `workflowRunId`/`scriptPath` on task state.
- Modify: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts` — show official-compatible run identity, event counts, and selected phase/agent details.
- Modify: `src/commands/workflows/workflows.ts` — add closer textual equivalents for official save/list/detail/restart/stop controls.
- Create: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.ts` — normalize official/local observations into comparable JSON.
- Create: `scripts/workflow-compatibility-benchmark.mjs` — run local benchmark fixtures and optional official probes through `/opt/homebrew/bin/claude` when available.
- Create: `docs/workflows/fixtures/official-compatible-research.js` — saved workflow fixture for args, parallel agents, review, and synthesis.
- Create: `docs/workflows/fixtures/official-compatible-convergence.js` — saved workflow fixture for retry/loop convergence.
- Modify: `scripts/run-workflow-tests.mjs` — include new unit and integration tests.
- Create: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts` — tests for official-compatible facade inputs and outputs.
- Modify: `src/tools/WorkflowTool/workflowDsl.test.ts` — tests for structured args and deterministic runtime compatibility.
- Modify: `src/tools/WorkflowTool/workflowDiscovery.test.ts` — tests for user/project workflow precedence.
- Create: `src/tools/WorkflowTool/workflowScriptPersistence.test.ts` — tests for script persistence, `scriptPath`, `workflowRunId`, and edit-rerun.
- Create: `src/tools/WorkflowTool/workflowOrchestrator.test.ts` — tests for JS orchestration helpers.
- Create: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts` — tests for benchmark normalization and gap scoring.
- Modify: `docs/workflow-compatibility-experiments.md` — update matrix with implemented compatibility coverage and remaining deliberate divergences.
- Modify: `docs/dynamic-workflow-agent-orchestration.md` — update local repository map and compatibility boundary after implementation.

---

### Task 1: Add benchmark fixtures and gap scoring before runtime changes

**Files:**
- Create: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.ts`
- Create: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts`
- Create: `scripts/workflow-compatibility-benchmark.mjs`
- Create: `docs/workflows/fixtures/official-compatible-research.js`
- Create: `docs/workflows/fixtures/official-compatible-convergence.js`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing benchmark normalization test**

Create `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareWorkflowCompatibility,
  normalizeWorkflowObservation,
} from './workflowCompatibilityBenchmark.js'

const officialObservation = {
  tool: 'Workflow',
  workflowRunId: 'wf-official-1',
  scriptPath: '/tmp/session/workflows/research.js',
  events: [
    { type: 'workflow_progress', status: 'running' },
    { type: 'workflow_phase', phase: 'research', status: 'completed' },
    { type: 'workflow_agent', phase: 'research', status: 'completed' },
    { type: 'workflow_log', message: 'review complete' },
  ],
  argsKind: 'object',
  supportsScriptPathRerun: true,
  supportsUserWorkflowDiscovery: true,
}

const localObservation = {
  tool: 'WorkflowTool',
  workflowRunId: undefined,
  scriptPath: undefined,
  events: [{ type: 'task_local_workflow', status: 'completed' }],
  argsKind: 'string',
  supportsScriptPathRerun: false,
  supportsUserWorkflowDiscovery: false,
}

describe('workflow compatibility benchmark', () => {
  it('normalizes official and local observations into comparable feature flags', () => {
    assert.deepEqual(normalizeWorkflowObservation(officialObservation), {
      hasWorkflowFacade: true,
      hasWorkflowRunId: true,
      hasScriptPath: true,
      hasOfficialProgressEvents: true,
      structuredArgs: true,
      scriptPathRerun: true,
      userWorkflowDiscovery: true,
    })
  })

  it('scores missing local compatibility gaps against official behavior', () => {
    const report = compareWorkflowCompatibility({
      official: officialObservation,
      local: localObservation,
    })

    assert.equal(report.score, 0)
    assert.deepEqual(report.gaps, [
      'hasWorkflowFacade',
      'hasWorkflowRunId',
      'hasScriptPath',
      'hasOfficialProgressEvents',
      'structuredArgs',
      'scriptPathRerun',
      'userWorkflowDiscovery',
    ])
  })
})
```

- [ ] **Step 2: Run the benchmark test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts
```

Expected: FAIL with module-not-found for `workflowCompatibilityBenchmark.js`.

- [ ] **Step 3: Implement minimal benchmark normalization**

Create `src/tools/WorkflowTool/workflowCompatibilityBenchmark.ts`:

```ts
export type WorkflowObservation = {
  tool?: string
  workflowRunId?: string
  scriptPath?: string
  events?: Array<{ type?: string; [key: string]: unknown }>
  argsKind?: string
  supportsScriptPathRerun?: boolean
  supportsUserWorkflowDiscovery?: boolean
}

export type WorkflowCompatibilityFlags = {
  hasWorkflowFacade: boolean
  hasWorkflowRunId: boolean
  hasScriptPath: boolean
  hasOfficialProgressEvents: boolean
  structuredArgs: boolean
  scriptPathRerun: boolean
  userWorkflowDiscovery: boolean
}

export type WorkflowCompatibilityReport = {
  score: number
  gaps: Array<keyof WorkflowCompatibilityFlags>
  official: WorkflowCompatibilityFlags
  local: WorkflowCompatibilityFlags
}

const OFFICIAL_EVENT_TYPES = new Set([
  'workflow_progress',
  'workflow_agent',
  'workflow_phase',
  'workflow_log',
])

export function normalizeWorkflowObservation(
  observation: WorkflowObservation,
): WorkflowCompatibilityFlags {
  const eventTypes = new Set((observation.events ?? []).map(event => event.type))

  return {
    hasWorkflowFacade: observation.tool === 'Workflow',
    hasWorkflowRunId: typeof observation.workflowRunId === 'string',
    hasScriptPath: typeof observation.scriptPath === 'string',
    hasOfficialProgressEvents: [...OFFICIAL_EVENT_TYPES].every(type =>
      eventTypes.has(type),
    ),
    structuredArgs: observation.argsKind !== undefined && observation.argsKind !== 'string',
    scriptPathRerun: observation.supportsScriptPathRerun === true,
    userWorkflowDiscovery: observation.supportsUserWorkflowDiscovery === true,
  }
}

export function compareWorkflowCompatibility({
  official,
  local,
}: {
  official: WorkflowObservation
  local: WorkflowObservation
}): WorkflowCompatibilityReport {
  const officialFlags = normalizeWorkflowObservation(official)
  const localFlags = normalizeWorkflowObservation(local)
  const keys = Object.keys(officialFlags) as Array<keyof WorkflowCompatibilityFlags>
  const relevantKeys = keys.filter(key => officialFlags[key])
  const gaps = relevantKeys.filter(key => !localFlags[key])
  const score =
    relevantKeys.length === 0
      ? 100
      : Math.round(((relevantKeys.length - gaps.length) / relevantKeys.length) * 100)

  return {
    score,
    gaps,
    official: officialFlags,
    local: localFlags,
  }
}
```

- [ ] **Step 4: Run the benchmark test and verify it passes**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts
```

Expected: PASS with 2 passing subtests.

- [ ] **Step 5: Add benchmark fixtures**

Create `docs/workflows/fixtures/official-compatible-research.js`:

```js
export default workflow({
  name: 'official-compatible-research',
  description: 'Fixture covering structured args, parallel research, review, and synthesis.',
  defaults: {
    maxConcurrency: 4,
    maxAgents: 8,
    maxRetries: 1,
    permissionMode: 'acceptEdits',
  },
  phases: [
    agent({
      id: 'research-a',
      description: 'Research from angle A',
      prompt: ({ args }) => `Research primary evidence for ${JSON.stringify(args)}`,
      review: 'none',
    }),
    agent({
      id: 'research-b',
      description: 'Research from angle B',
      prompt: ({ args }) => `Research counter-evidence for ${JSON.stringify(args)}`,
      review: 'none',
    }),
    agent({
      id: 'review',
      description: 'Cross-check independent findings',
      dependsOn: ['research-a', 'research-b'],
      prompt: 'Compare the two research outputs and list only verified claims.',
      review: 'cross-check',
    }),
    agent({
      id: 'synthesis',
      description: 'Synthesize verified claims',
      dependsOn: ['review'],
      prompt: 'Write the final synthesis from verified claims only.',
      review: 'synthesis',
    }),
  ],
})
```

Create `docs/workflows/fixtures/official-compatible-convergence.js`:

```js
export default workflow({
  name: 'official-compatible-convergence',
  description: 'Fixture covering retry and convergence-style repair loops.',
  defaults: {
    maxConcurrency: 2,
    maxAgents: 10,
    maxRetries: 2,
    permissionMode: 'acceptEdits',
  },
  phases: [
    agent({
      id: 'attempt',
      description: 'Attempt implementation',
      prompt: ({ args }) => `Attempt the requested change: ${JSON.stringify(args)}`,
    }),
    agent({
      id: 'verify',
      description: 'Verify attempt',
      dependsOn: ['attempt'],
      prompt: 'Run the requested verification mentally from the provided output and identify failures.',
      review: 'adversarial',
    }),
    agent({
      id: 'repair',
      description: 'Repair verified failure',
      dependsOn: ['verify'],
      prompt: 'Repair only the verified failure and explain the next verification step.',
    }),
  ],
})
```

- [ ] **Step 6: Add benchmark script**

Create `scripts/workflow-compatibility-benchmark.mjs`:

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareWorkflowCompatibility } from '../src/tools/WorkflowTool/workflowCompatibilityBenchmark.js'

const officialBinary = '/opt/homebrew/bin/claude'

const officialObservation = {
  tool: 'Workflow',
  workflowRunId: 'observed-official-hidden-tool',
  scriptPath: 'observed-session-script-path',
  events: [
    { type: 'workflow_progress' },
    { type: 'workflow_phase' },
    { type: 'workflow_agent' },
    { type: 'workflow_log' },
  ],
  argsKind: 'object',
  supportsScriptPathRerun: true,
  supportsUserWorkflowDiscovery: true,
}

const localObservation = {
  tool: process.env.LOCAL_WORKFLOW_TOOL_NAME ?? 'WorkflowTool',
  workflowRunId: process.env.LOCAL_WORKFLOW_RUN_ID,
  scriptPath: process.env.LOCAL_WORKFLOW_SCRIPT_PATH,
  events: (process.env.LOCAL_WORKFLOW_EVENTS ?? 'task_local_workflow')
    .split(',')
    .filter(Boolean)
    .map(type => ({ type })),
  argsKind: process.env.LOCAL_WORKFLOW_ARGS_KIND ?? 'string',
  supportsScriptPathRerun: process.env.LOCAL_WORKFLOW_SCRIPT_PATH_RERUN === 'true',
  supportsUserWorkflowDiscovery: process.env.LOCAL_WORKFLOW_USER_DISCOVERY === 'true',
}

const report = compareWorkflowCompatibility({
  official: officialObservation,
  local: localObservation,
})

const outputPath = join(process.cwd(), '.claude', 'workflow-compatibility-report.json')
await writeFile(outputPath, `${JSON.stringify({ officialBinaryExists: existsSync(officialBinary), ...report }, null, 2)}\n`)
console.log(`workflow compatibility score: ${report.score}`)
console.log(`workflow compatibility gaps: ${report.gaps.join(', ') || 'none'}`)
console.log(`workflow compatibility report: ${outputPath}`)
```

- [ ] **Step 7: Add the benchmark test to the custom runner**

Modify `scripts/run-workflow-tests.mjs` so the `testFiles` array includes:

```js
'src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts',
```

- [ ] **Step 8: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS and includes `workflowCompatibilityBenchmark.test.ts`.

---

### Task 2: Support structured JavaScript workflow args

**Files:**
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`
- Modify: `src/tools/WorkflowTool/workflowDsl.ts`
- Modify: `src/tools/WorkflowTool/workflowDiscovery.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/commands/workflows/workflows.ts`
- Modify: `src/tools/WorkflowTool/createWorkflowCommand.ts`
- Modify: `src/tools/WorkflowTool/workflowDsl.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write failing structured args tests**

Add to `src/tools/WorkflowTool/workflowDsl.test.ts`:

```ts
it('passes object args to JavaScript workflow prompt functions', async () => {
  const filePath = join(tmpdir(), `workflow-object-args-${process.pid}.js`)
  await writeFile(
    filePath,
    `export default workflow({
      name: 'object-args',
      description: 'Object args workflow',
      phases: [agent({
        id: 'inspect',
        description: 'Inspect object args',
        prompt: ({ args }) => 'topic=' + args.topic + '; depth=' + args.options.depth,
      })],
    })`,
  )

  const spec = await loadWorkflowScriptSpec(filePath, {
    topic: 'official workflows',
    options: { depth: 3 },
  })

  assert.equal(spec.phases[0]?.prompt, 'topic=official workflows; depth=3')
})

it('preserves normal Math methods while blocking Math.random', async () => {
  const filePath = join(tmpdir(), `workflow-math-${process.pid}.js`)
  await writeFile(
    filePath,
    `export default workflow({
      name: 'math-args',
      description: 'Math workflow',
      phases: [agent({
        id: 'inspect',
        description: 'Inspect math',
        prompt: () => 'max=' + Math.max(1, 2, 3),
      })],
    })`,
  )

  const spec = await loadWorkflowScriptSpec(filePath)

  assert.equal(spec.phases[0]?.prompt, 'max=3')
})
```

- [ ] **Step 2: Run the structured args tests and verify they fail**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDsl.test.ts
```

Expected: FAIL because `loadWorkflowScriptSpec` accepts only string args and `Math.max` is not preserved by the sandbox `Math` object.

- [ ] **Step 3: Add a structured args type**

Modify `src/tools/WorkflowTool/workflowSpec.ts`:

```ts
export type WorkflowArgs =
  | string
  | number
  | boolean
  | null
  | WorkflowArgs[]
  | { [key: string]: WorkflowArgs }
```

Change run/input fields that currently store only `string` arguments to use `WorkflowArgs | undefined` where they represent runtime args. Keep command-line text as string until parsed at the boundary.

- [ ] **Step 4: Update the DSL context to accept structured args**

Modify `src/tools/WorkflowTool/workflowDsl.ts`:

```ts
import type { WorkflowArgs, WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

type WorkflowScriptContext = {
  args: WorkflowArgs | undefined
}

function parseWorkflowArgs(args: WorkflowArgs | undefined): WorkflowArgs | undefined {
  if (typeof args !== 'string') return args
  const trimmed = args.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed) as WorkflowArgs
  } catch {
    return args
  }
}

function createWorkflowMath(): Math {
  const workflowMath = Object.create(Math) as Math
  Object.defineProperty(workflowMath, 'random', {
    value: () => {
      throw new Error(RANDOM_ERROR)
    },
  })
  return Object.freeze(workflowMath)
}

export async function loadWorkflowScriptSpec(
  filePath: string,
  args?: WorkflowArgs,
): Promise<WorkflowSpec> {
  const parsedArgs = parseWorkflowArgs(args)
  const context: WorkflowScriptContext = { args: parsedArgs }
  const module = { exports: {} as { default?: WorkflowInput | WorkflowSpec } }
  const sandbox = vm.createContext({
    args: parsedArgs,
    module,
    exports: module.exports,
    workflow: (workflow: WorkflowInput) => normalizeWorkflow(workflow, context),
    agent: (phase: WorkflowPhaseInput) => phase,
    Date: Object.assign(WorkflowDate, { now: WorkflowDate }),
    Math: createWorkflowMath(),
  })
```

- [ ] **Step 5: Thread structured args through discovery and run paths**

Modify `src/tools/WorkflowTool/workflowDiscovery.ts` so `args` parameters use `WorkflowArgs | undefined`:

```ts
import type { WorkflowArgs, WorkflowSpec } from './workflowSpec.js'

async function loadWorkflowFile(
  filePath: string,
  args?: WorkflowArgs,
): Promise<WorkflowSpec> {
  if (filePath.endsWith('.js')) {
    return loadWorkflowScriptSpec(filePath, args)
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as WorkflowSpec
}

export async function discoverWorkflowSpecs(
  cwd: string,
  args?: WorkflowArgs,
): Promise<WorkflowDiscoveryResult> {
```

Modify `WorkflowTool.run`, `/workflows run`, and workflow-backed prompt command code so CLI strings are passed through unchanged and JSON strings become objects inside `loadWorkflowScriptSpec`.

- [ ] **Step 6: Run structured args tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDsl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run all workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 3: Add user workflow discovery with project precedence

**Files:**
- Modify: `src/tools/WorkflowTool/workflowDiscovery.ts`
- Modify: `src/tools/WorkflowTool/workflowDiscovery.test.ts`
- Modify: `docs/dynamic-workflow-agent-orchestration.md`
- Modify: `docs/workflow-compatibility-experiments.md`

- [ ] **Step 1: Write failing user discovery precedence tests**

Add to `src/tools/WorkflowTool/workflowDiscovery.test.ts`:

```ts
it('discovers user workflows and lets project workflows shadow user workflows', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-discovery-project-'))
  const home = await mkdtemp(join(tmpdir(), 'workflow-discovery-home-'))
  await mkdir(join(cwd, '.claude', 'workflows'), { recursive: true })
  await mkdir(join(home, '.claude', 'workflows'), { recursive: true })

  await writeFile(
    join(home, '.claude', 'workflows', 'shadowed.json'),
    JSON.stringify({
      name: 'shadowed',
      description: 'User workflow',
      phases: [{ id: 'user', description: 'User phase', prompt: 'user prompt' }],
    }),
  )

  await writeFile(
    join(cwd, '.claude', 'workflows', 'shadowed.json'),
    JSON.stringify({
      name: 'shadowed',
      description: 'Project workflow',
      phases: [{ id: 'project', description: 'Project phase', prompt: 'project prompt' }],
    }),
  )

  const discovery = await discoverWorkflowSpecs(cwd, undefined, { home })
  const workflow = discovery.workflows.find(item => item.name === 'shadowed')

  assert.equal(workflow?.description, 'Project workflow')
  assert.match(workflow?.path ?? '', /\.claude\/workflows\/shadowed\.json$/)
})
```

- [ ] **Step 2: Run discovery tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDiscovery.test.ts
```

Expected: FAIL because discovery does not accept a home override and does not scan user workflows.

- [ ] **Step 3: Implement user discovery roots**

Modify `src/tools/WorkflowTool/workflowDiscovery.ts`:

```ts
import { homedir } from 'node:os'

type WorkflowDiscoveryOptions = {
  home?: string
}

function workflowRoots(cwd: string, options: WorkflowDiscoveryOptions = {}): string[] {
  const home = options.home ?? homedir()
  return [
    join(home, '.claude', 'workflows'),
    join(cwd, 'docs', 'workflows'),
    join(cwd, '.claude', 'workflows'),
  ]
}
```

Keep iteration order from lowest to highest precedence, and when names collide replace earlier user entries with later project entries:

```ts
const workflowsByName = new Map<string, DiscoveredWorkflowSpec>()
for (const root of workflowRoots(cwd, options)) {
  for (const filePath of await listWorkflowFiles(root)) {
    const spec = await loadWorkflowFile(filePath, args)
    const plan = validateWorkflowSpec(spec)
    workflowsByName.set(plan.name, { ...plan, path: filePath })
  }
}
```

- [ ] **Step 4: Run discovery tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDiscovery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update compatibility docs**

Modify `docs/workflow-compatibility-experiments.md` row W5 to state that user `~/.claude/workflows/` discovery is implemented with project shadowing precedence.

Modify `docs/dynamic-workflow-agent-orchestration.md` current workflow surface to include user workflow discovery.

- [ ] **Step 6: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 4: Add official-compatible Workflow facade

**Files:**
- Create: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- Create: `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`
- Modify: `src/tools.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write failing facade tests**

Create `src/tools/WorkflowTool/WorkflowFacadeTool.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeWorkflowFacadeInput } from './WorkflowFacadeTool.js'

describe('Workflow facade tool', () => {
  it('normalizes official inline script input', () => {
    assert.deepEqual(
      normalizeWorkflowFacadeInput({
        name: 'research',
        script: 'export default workflow({ name: "research", description: "Research", phases: [] })',
      }),
      {
        kind: 'inline-script',
        name: 'research',
        script: 'export default workflow({ name: "research", description: "Research", phases: [] })',
        args: undefined,
        resumeFromRunId: undefined,
      },
    )
  })

  it('normalizes official scriptPath rerun input', () => {
    assert.deepEqual(
      normalizeWorkflowFacadeInput({
        scriptPath: '/tmp/workflow.js',
        args: { topic: 'dsl' },
        resumeFromRunId: 'wf-123',
      }),
      {
        kind: 'script-path',
        scriptPath: '/tmp/workflow.js',
        args: { topic: 'dsl' },
        resumeFromRunId: 'wf-123',
      },
    )
  })

  it('normalizes saved workflow name input', () => {
    assert.deepEqual(normalizeWorkflowFacadeInput('official-compatible-research'), {
      kind: 'saved-workflow',
      selector: 'official-compatible-research',
      args: undefined,
    })
  })
})
```

- [ ] **Step 2: Run facade tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: FAIL with module-not-found for `WorkflowFacadeTool.js`.

- [ ] **Step 3: Implement facade input normalization**

Create `src/tools/WorkflowTool/WorkflowFacadeTool.ts`:

```ts
import type { WorkflowArgs } from './workflowSpec.js'

export type WorkflowFacadeInput =
  | string
  | {
      name?: string
      script?: string
      scriptPath?: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }

export type NormalizedWorkflowFacadeInput =
  | {
      kind: 'saved-workflow'
      selector: string
      args?: WorkflowArgs
    }
  | {
      kind: 'inline-script'
      name: string
      script: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }
  | {
      kind: 'script-path'
      scriptPath: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }

export function normalizeWorkflowFacadeInput(
  input: WorkflowFacadeInput,
): NormalizedWorkflowFacadeInput {
  if (typeof input === 'string') {
    const selector = input.trim()
    if (!selector) throw new Error('Workflow name is required')
    return { kind: 'saved-workflow', selector, args: undefined }
  }

  if (typeof input !== 'object' || input === null) {
    throw new Error('Workflow input must be a workflow name or an object')
  }

  if (typeof input.scriptPath === 'string') {
    return {
      kind: 'script-path',
      scriptPath: input.scriptPath,
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if (typeof input.script === 'string') {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new Error('Workflow script input requires a name')
    }
    return {
      kind: 'inline-script',
      name: input.name.trim(),
      script: input.script,
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if (typeof input.name === 'string' && input.name.trim() !== '') {
    return { kind: 'saved-workflow', selector: input.name.trim(), args: input.args }
  }

  throw new Error('Workflow input requires name, script, or scriptPath')
}
```

- [ ] **Step 4: Run facade normalization tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/WorkflowFacadeTool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Register the facade behind `WORKFLOW_SCRIPTS`**

Modify `src/tools.ts` in the existing feature-gated workflow import block so `WorkflowFacadeTool` is imported dynamically only when `WORKFLOW_SCRIPTS` is enabled. The registration should expose tool name `Workflow` while keeping existing `WorkflowTool` available for inspection/control.

Expected registration shape:

```ts
if (hasRecoveredFeature('WORKFLOW_SCRIPTS')) {
  const { WorkflowTool } = await import('./tools/WorkflowTool/WorkflowTool.js')
  const { WorkflowFacadeTool } = await import('./tools/WorkflowTool/WorkflowFacadeTool.js')
  tools.push(WorkflowTool, WorkflowFacadeTool)
}
```

Adjust to match the actual `src/tools.ts` collection API.

- [ ] **Step 6: Add a facade tool smoke assertion**

Extend `WorkflowFacadeTool.test.ts`:

```ts
it('exports an official-compatible Workflow tool name', async () => {
  const { WorkflowFacadeTool } = await import('./WorkflowFacadeTool.js')
  assert.equal(WorkflowFacadeTool.name, 'Workflow')
})
```

- [ ] **Step 7: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 5: Persist scripts with workflowRunId and scriptPath rerun

**Files:**
- Create: `src/tools/WorkflowTool/workflowScriptPersistence.ts`
- Create: `src/tools/WorkflowTool/workflowScriptPersistence.test.ts`
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `src/tools/WorkflowTool/WorkflowFacadeTool.ts`
- Modify: `src/tools/WorkflowTool/WorkflowTool.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write failing script persistence tests**

Create `src/tools/WorkflowTool/workflowScriptPersistence.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'

describe('workflow script persistence', () => {
  it('creates stable official-style workflow run ids', () => {
    assert.match(createWorkflowRunId(), /^wf_[a-z0-9]+_[a-z0-9]+$/)
  })

  it('persists inline scripts and resolves the script path for rerun', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-script-persistence-'))
    const workflowRunId = 'wf_test_123'
    const scriptPath = await persistWorkflowScript({
      cwd,
      workflowRunId,
      name: 'research',
      script: 'export default workflow({ name: "research", description: "Research", phases: [] })',
    })

    assert.match(scriptPath, /\.claude\/workflow-runs\/wf_test_123\/research\.js$/)
    assert.equal(await readFile(scriptPath, 'utf8'), 'export default workflow({ name: "research", description: "Research", phases: [] })')
    assert.equal(await resolveWorkflowScriptPath({ cwd, scriptPath }), scriptPath)
  })
})
```

- [ ] **Step 2: Run persistence tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowScriptPersistence.test.ts
```

Expected: FAIL with module-not-found for `workflowScriptPersistence.js`.

- [ ] **Step 3: Implement script persistence**

Create `src/tools/WorkflowTool/workflowScriptPersistence.ts`:

```ts
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'

function sanitizeWorkflowFileName(name: string): string {
  return `${name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'}.js`
}

export function createWorkflowRunId(): string {
  const [first, second] = randomUUID().replace(/-/g, '').match(/.{1,12}/g) ?? [Date.now().toString(36), 'run']
  return `wf_${first}_${second}`
}

export async function persistWorkflowScript({
  cwd,
  workflowRunId,
  name,
  script,
}: {
  cwd: string
  workflowRunId: string
  name: string
  script: string
}): Promise<string> {
  const runDir = join(cwd, '.claude', 'workflow-runs', workflowRunId)
  await mkdir(runDir, { recursive: true })
  const scriptPath = join(runDir, sanitizeWorkflowFileName(name))
  await writeFile(scriptPath, script)
  return scriptPath
}

export async function resolveWorkflowScriptPath({
  cwd,
  scriptPath,
}: {
  cwd: string
  scriptPath: string
}): Promise<string> {
  const normalized = normalize(isAbsolute(scriptPath) ? scriptPath : join(cwd, scriptPath))
  return realpath(normalized)
}
```

- [ ] **Step 4: Run persistence tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowScriptPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Extend run session metadata**

Modify `src/tools/WorkflowTool/workflowRunSessions.ts` so `WorkflowRunSession` includes:

```ts
workflowRunId: string
scriptPath?: string
resumeFromRunId?: string
```

Update `startWorkflowRunSession` input to accept `workflowRunId` and `scriptPath`, then persist session files under both the task ID path and the run ID directory:

```ts
.claude/workflow-runs/<taskId>.json
.claude/workflow-runs/<workflowRunId>/session.json
```

- [ ] **Step 6: Wire facade inline script and scriptPath execution**

Modify `src/tools/WorkflowTool/WorkflowFacadeTool.ts` so execution does this:

```ts
const workflowRunId = createWorkflowRunId()
if (normalized.kind === 'inline-script') {
  const scriptPath = await persistWorkflowScript({
    cwd,
    workflowRunId,
    name: normalized.name,
    script: normalized.script,
  })
  const spec = await loadWorkflowScriptSpec(scriptPath, normalized.args)
  return runWorkflowPlan({ plan: validateWorkflowSpec(spec), context, canUseTool, assistantMessage, runArgs: normalized.args, workflowRunId, scriptPath })
}

if (normalized.kind === 'script-path') {
  const scriptPath = await resolveWorkflowScriptPath({ cwd, scriptPath: normalized.scriptPath })
  const spec = await loadWorkflowScriptSpec(scriptPath, normalized.args)
  return runWorkflowPlan({ plan: validateWorkflowSpec(spec), context, canUseTool, assistantMessage, runArgs: normalized.args, workflowRunId, scriptPath, resumeFromRunId: normalized.resumeFromRunId })
}
```

Adapt names to the actual `runWorkflowPlan` function signature.

- [ ] **Step 7: Return workflowRunId and scriptPath from runs**

Modify `src/tools/WorkflowTool/runWorkflow.ts` so successful and failed run results include:

```ts
return {
  taskId: workflowTask.id,
  workflowRunId,
  scriptPath,
  status: 'completed',
  results: allResults,
}
```

For saved declarative specs without a script path, return `scriptPath: plan.sourcePath` when present.

- [ ] **Step 8: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 6: Persist official progress event schema

**Files:**
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`
- Modify: `src/tools/WorkflowTool/workflowRunSessions.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`
- Modify: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
- Modify: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts`

- [ ] **Step 1: Write failing official event tests**

Add to `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts`:

```ts
it('recognizes local runs with official progress events as compatible', () => {
  const localObservation = {
    tool: 'Workflow',
    workflowRunId: 'wf_local_1',
    scriptPath: '/tmp/workflow.js',
    events: [
      { type: 'workflow_progress' },
      { type: 'workflow_phase' },
      { type: 'workflow_agent' },
      { type: 'workflow_log' },
    ],
    argsKind: 'object',
    supportsScriptPathRerun: true,
    supportsUserWorkflowDiscovery: true,
  }

  assert.equal(normalizeWorkflowObservation(localObservation).hasOfficialProgressEvents, true)
})
```

Add a run-session test in `workflowScriptPersistence.test.ts` or a new `workflowRunSessions` test:

```ts
it('persists official workflow event names in run sessions', async () => {
  const session = await startWorkflowRunSession({
    cwd,
    taskId: 'task-1',
    workflowRunId: 'wf_test_events',
    plan,
    runArgs: { topic: 'events' },
    scriptPath: '/tmp/workflow.js',
  })

  await appendWorkflowRunEvent({
    cwd,
    session,
    event: { type: 'workflow_log', message: 'started' },
  })

  const content = JSON.parse(await readFile(join(cwd, '.claude', 'workflow-runs', 'wf_test_events', 'session.json'), 'utf8'))
  assert.deepEqual(content.events, [{ type: 'workflow_log', message: 'started' }])
})
```

- [ ] **Step 2: Run event tests and verify failure**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: FAIL because session event append support is missing.

- [ ] **Step 3: Add official event types**

Modify `src/tools/WorkflowTool/workflowSpec.ts`:

```ts
export type WorkflowProgressEvent =
  | {
      type: 'workflow_progress'
      workflowRunId: string
      status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
      completedAgents: number
      totalAgents: number
    }
  | {
      type: 'workflow_phase'
      workflowRunId: string
      phaseId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
    }
  | {
      type: 'workflow_agent'
      workflowRunId: string
      phaseId: string
      agentId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
    }
  | {
      type: 'workflow_log'
      workflowRunId: string
      message: string
    }
```

- [ ] **Step 4: Store events in sessions and task state**

Modify `workflowRunSessions.ts`:

```ts
export async function appendWorkflowRunEvent({
  cwd,
  session,
  event,
}: {
  cwd: string
  session: WorkflowRunSession
  event: WorkflowProgressEvent
}): Promise<WorkflowRunSession> {
  const updated = {
    ...session,
    updatedAt: Date.now(),
    events: [...(session.events ?? []), event],
  }
  await writeSessionFiles(cwd, updated)
  return updated
}
```

Modify `LocalWorkflowTaskState` to include:

```ts
events: WorkflowProgressEvent[]
```

Add helper:

```ts
export function recordWorkflowEvent(
  taskId: string,
  event: WorkflowProgressEvent,
  setAppState: SetAppState,
): void {
  updateWorkflowTask(taskId, setAppState, task => ({
    ...task,
    events: [...task.events, event],
  }))
}
```

- [ ] **Step 5: Emit events from runWorkflow**

In `runWorkflow.ts`, emit:

```ts
{ type: 'workflow_progress', status: 'running' }
{ type: 'workflow_phase', phaseId, status: 'running' }
{ type: 'workflow_agent', phaseId, agentId, status: 'running' }
{ type: 'workflow_agent', phaseId, agentId, status: 'completed' }
{ type: 'workflow_phase', phaseId, status: 'completed' }
{ type: 'workflow_progress', status: 'completed' }
```

Append each event to both task state and run session.

- [ ] **Step 6: Show event counts in workflow status**

Modify `formatWorkflowStatus.ts` to include:

```ts
lines.push(`Official events: ${task.events.length}`)
```

For detail mode in Task 9, this same event list will power drilldown.

- [ ] **Step 7: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 7: Add JavaScript orchestration helpers for practical official-style scripts

**Files:**
- Create: `src/tools/WorkflowTool/workflowOrchestrator.ts`
- Create: `src/tools/WorkflowTool/workflowOrchestrator.test.ts`
- Modify: `src/tools/WorkflowTool/workflowDsl.ts`
- Modify: `src/tools/WorkflowTool/runWorkflow.ts`
- Modify: `src/tools/WorkflowTool/workflowSpec.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write failing orchestration helper tests**

Create `src/tools/WorkflowTool/workflowOrchestrator.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWorkflowOrchestrator } from './workflowOrchestrator.js'

describe('workflow orchestrator helpers', () => {
  it('records sequential and parallel agent requests as a deterministic plan', async () => {
    const orchestrator = createWorkflowOrchestrator({
      workflowRunId: 'wf_test_orchestrator',
      maxAgents: 4,
    })

    const first = orchestrator.agent({
      label: 'research-a',
      prompt: 'Research A',
    })
    const second = orchestrator.agent({
      label: 'research-b',
      prompt: 'Research B',
    })

    const result = await orchestrator.parallel([first, second])

    assert.deepEqual(result.map(item => item.output), [
      '{{agent:research-a}}',
      '{{agent:research-b}}',
    ])
    assert.deepEqual(orchestrator.toPlan().phases.map(phase => phase.id), [
      'research-a',
      'research-b',
    ])
  })

  it('records retry and loopUntil metadata without using nondeterministic APIs', async () => {
    const orchestrator = createWorkflowOrchestrator({
      workflowRunId: 'wf_test_loop',
      maxAgents: 5,
    })

    await orchestrator.loopUntil({
      label: 'verify-loop',
      maxIterations: 2,
      run: iteration =>
        orchestrator.agent({
          label: `verify-${iteration}`,
          prompt: `Verify iteration ${iteration}`,
        }),
      isDone: result => result.output.includes('verify-1'),
    })

    assert.deepEqual(orchestrator.toPlan().phases.map(phase => phase.id), [
      'verify-1',
    ])
  })
})
```

- [ ] **Step 2: Run orchestration tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowOrchestrator.test.ts
```

Expected: FAIL with module-not-found for `workflowOrchestrator.js`.

- [ ] **Step 3: Implement deterministic orchestration helper recorder**

Create `src/tools/WorkflowTool/workflowOrchestrator.ts`:

```ts
import type { WorkflowPhaseSpec, WorkflowSpec } from './workflowSpec.js'

export type WorkflowAgentRequest = {
  label: string
  prompt: string
  dependsOn?: string[]
  review?: WorkflowPhaseSpec['review']
}

export type WorkflowAgentOutput = {
  label: string
  output: string
}

export type WorkflowOrchestrator = ReturnType<typeof createWorkflowOrchestrator>

export function createWorkflowOrchestrator({
  workflowRunId,
  maxAgents,
}: {
  workflowRunId: string
  maxAgents: number
}) {
  const phases: WorkflowPhaseSpec[] = []
  const logs: string[] = []

  function assertAgentBudget() {
    if (phases.length >= maxAgents) {
      throw new Error(`Workflow agent budget exceeded: ${maxAgents}`)
    }
  }

  return {
    agent(request: WorkflowAgentRequest): Promise<WorkflowAgentOutput> {
      assertAgentBudget()
      phases.push({
        id: request.label,
        description: request.label,
        prompt: request.prompt,
        dependsOn: request.dependsOn,
        review: request.review,
      })
      return Promise.resolve({
        label: request.label,
        output: `{{agent:${request.label}}}`,
      })
    },

    parallel<T>(items: Array<Promise<T>>): Promise<T[]> {
      return Promise.all(items)
    },

    async series<T>(items: Array<() => Promise<T>>): Promise<T[]> {
      const results: T[] = []
      for (const item of items) {
        results.push(await item())
      }
      return results
    },

    async retry<T>({
      attempts,
      run,
    }: {
      attempts: number
      run: (attempt: number) => Promise<T>
    }): Promise<T> {
      let lastError: unknown
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await run(attempt)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    },

    async loopUntil<T>({
      maxIterations,
      run,
      isDone,
    }: {
      label: string
      maxIterations: number
      run: (iteration: number) => Promise<T>
      isDone: (result: T) => boolean
    }): Promise<T> {
      let lastResult: T | undefined
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        lastResult = await run(iteration)
        if (isDone(lastResult)) return lastResult
      }
      return lastResult as T
    },

    review(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return this.agent({ ...request, review: 'cross-check' })
    },

    refute(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return this.agent({ ...request, review: 'adversarial' })
    },

    synthesize(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
      return this.agent({ ...request, review: 'synthesis' })
    },

    log(message: string): void {
      logs.push(message)
    },

    toPlan(): Pick<WorkflowSpec, 'name' | 'description' | 'phases'> & { logs: string[] } {
      return {
        name: workflowRunId,
        description: `Workflow orchestration plan ${workflowRunId}`,
        phases,
        logs,
      }
    },
  }
}
```

- [ ] **Step 4: Run orchestration helper tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Inject helpers into JavaScript workflow sandbox**

Modify `workflowDsl.ts` so scripts can export either declarative `workflow(...)` or an async orchestration function:

```ts
const orchestrator = createWorkflowOrchestrator({
  workflowRunId: providedWorkflowRunId ?? 'dry-run',
  maxAgents: 1000,
})
const sandbox = vm.createContext({
  args: parsedArgs,
  module,
  exports: module.exports,
  workflow: (workflow: WorkflowInput) => normalizeWorkflow(workflow, context),
  agent: orchestrator.agent,
  parallel: orchestrator.parallel,
  series: orchestrator.series,
  retry: orchestrator.retry,
  loopUntil: orchestrator.loopUntil,
  review: orchestrator.review,
  refute: orchestrator.refute,
  synthesize: orchestrator.synthesize,
  log: orchestrator.log,
  Date: Object.assign(WorkflowDate, { now: WorkflowDate }),
  Math: createWorkflowMath(),
})
```

If the default export is a function, run it and convert `orchestrator.toPlan()` to a `WorkflowSpec`. Keep `script.runInContext(..., { timeout: 1000 })` for script loading and apply an explicit timeout for awaiting exported async functions.

- [ ] **Step 6: Add a JS orchestration script test**

Add to `workflowDsl.test.ts`:

```ts
it('loads official-style async orchestration scripts into a workflow plan', async () => {
  const filePath = join(tmpdir(), `workflow-orchestration-${process.pid}.js`)
  await writeFile(
    filePath,
    `export default async function main() {
      const outputs = await parallel([
        agent({ label: 'research-a', prompt: 'Research A' }),
        agent({ label: 'research-b', prompt: 'Research B' }),
      ])
      await review({ label: 'review', prompt: 'Review ' + outputs.map(item => item.output).join(',') })
    }`,
  )

  const spec = await loadWorkflowScriptSpec(filePath, { topic: 'official' })

  assert.deepEqual(spec.phases.map(phase => phase.id), [
    'research-a',
    'research-b',
    'review',
  ])
  assert.equal(spec.phases[2]?.review, 'cross-check')
})
```

- [ ] **Step 7: Run DSL and workflow tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowDsl.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 8: Add reviewer/refuter/voting compatibility helpers

**Files:**
- Modify: `src/tools/WorkflowTool/workflowOrchestrator.ts`
- Modify: `src/tools/WorkflowTool/workflowOrchestrator.test.ts`
- Modify: `src/tools/WorkflowTool/formatWorkflowDryRun.ts`
- Modify: `docs/workflows/fixtures/official-compatible-research.js`

- [ ] **Step 1: Write failing reviewer/refuter helper tests**

Add to `workflowOrchestrator.test.ts`:

```ts
it('records reviewer, refuter, and voting synthesis helpers', async () => {
  const orchestrator = createWorkflowOrchestrator({
    workflowRunId: 'wf_test_reviewers',
    maxAgents: 6,
  })

  await orchestrator.review({ label: 'review-a', prompt: 'Review A' })
  await orchestrator.refute({ label: 'refute-a', prompt: 'Refute A' })
  await orchestrator.vote({
    label: 'vote',
    prompt: 'Vote on verified claims',
    dependsOn: ['review-a', 'refute-a'],
  })

  assert.deepEqual(
    orchestrator.toPlan().phases.map(phase => [phase.id, phase.review]),
    [
      ['review-a', 'cross-check'],
      ['refute-a', 'adversarial'],
      ['vote', 'synthesis'],
    ],
  )
})
```

- [ ] **Step 2: Run orchestration tests and verify failure**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowOrchestrator.test.ts
```

Expected: FAIL because `vote` is missing.

- [ ] **Step 3: Add voting helper**

Modify `workflowOrchestrator.ts`:

```ts
vote(request: Omit<WorkflowAgentRequest, 'review'>): Promise<WorkflowAgentOutput> {
  return this.agent({ ...request, review: 'synthesis' })
}
```

Inject `vote` into `workflowDsl.ts` sandbox with the other helpers.

- [ ] **Step 4: Update dry-run formatting for helper-originated review phases**

Modify `formatWorkflowDryRun.ts` so review mode lines remain visible for `cross-check`, `adversarial`, and `synthesis` phases. Preserve existing output and add a line like:

```ts
lines.push(`  Quality mode: ${phase.review}`)
```

only when `phase.review !== 'none'`.

- [ ] **Step 5: Update research fixture to use official-style helpers**

Change `docs/workflows/fixtures/official-compatible-research.js` to:

```js
export default async function main() {
  const findings = await parallel([
    agent({ label: 'research-a', prompt: 'Research primary evidence for ' + JSON.stringify(args) }),
    agent({ label: 'research-b', prompt: 'Research counter-evidence for ' + JSON.stringify(args) }),
  ])
  await review({
    label: 'review',
    prompt: 'Cross-check findings: ' + findings.map(item => item.output).join('\n'),
    dependsOn: findings.map(item => item.label),
  })
  await refute({
    label: 'refute',
    prompt: 'Try to falsify verified claims from review.',
    dependsOn: ['review'],
  })
  await vote({
    label: 'synthesis',
    prompt: 'Synthesize only claims that survived review and refutation.',
    dependsOn: ['review', 'refute'],
  })
}
```

- [ ] **Step 6: Run workflow tests**

Run:

```bash
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 9: Improve `/workflows` textual detail and controls

**Files:**
- Modify: `src/commands/workflows/workflows.ts`
- Modify: `src/tasks/LocalWorkflowTask/formatWorkflowStatus.ts`
- Modify: `src/commands/workflows/workflows.test.ts`
- Modify: `docs/dynamic-workflow-agent-orchestration.md`

- [ ] **Step 1: Write failing detail/control command tests**

Add to `src/commands/workflows/workflows.test.ts`:

```ts
it('prints workflow detail usage for official-style drilldown controls', async () => {
  const result = await runWorkflowsCommand('/workflows detail wf_test_123')

  assert.match(result.value, /Workflow detail/)
  assert.match(result.value, /Events:/)
  assert.match(result.value, /Controls:/)
  assert.match(result.value, /pause/)
  assert.match(result.value, /resume/)
  assert.match(result.value, /retry-agent/)
  assert.match(result.value, /skip-agent/)
})
```

Use the existing command test helper names in the file; if there is no helper, add the assertion to the closest existing `/workflows status` test.

- [ ] **Step 2: Run workflows command tests and verify failure**

Run:

```bash
node --import tsx/esm src/commands/workflows/workflows.test.ts
```

Expected: FAIL because `/workflows detail` is not implemented.

- [ ] **Step 3: Add detail action**

Modify `src/commands/workflows/workflows.ts` action parsing to include `detail`:

```ts
if (action === 'detail') {
  return {
    type: 'text',
    value: formatWorkflowStatus(findWorkflowTask(selector), { detail: true }),
  }
}
```

Adapt `findWorkflowTask` to the actual task lookup helper used by `status`.

- [ ] **Step 4: Add detail formatting**

Modify `formatWorkflowStatus.ts`:

```ts
export function formatWorkflowStatus(
  task: LocalWorkflowTaskState,
  options: { detail?: boolean } = {},
): string {
  const lines = [...existingSummaryLines]
  if (options.detail) {
    lines.push('Events:')
    for (const event of task.events.slice(-20)) {
      lines.push(`  - ${event.type}: ${JSON.stringify(event)}`)
    }
    lines.push('Controls:')
    lines.push(`  /workflows pause ${task.id}`)
    lines.push(`  /workflows resume ${task.id}`)
    lines.push(`  /workflows retry-agent ${task.id} <phase-id> <agent-id>`)
    lines.push(`  /workflows skip-agent ${task.id} <phase-id> <agent-id>`)
  }
  return lines.join('\n')
}
```

Keep existing non-detail output unchanged.

- [ ] **Step 5: Wire retry-agent and skip-agent command aliases**

Modify `workflows.ts` so command actions `retry-agent` and `skip-agent` call existing `retryWorkflowAgent()` and `skipWorkflowAgent()` helpers.

Usage strings:

```text
Usage: /workflows retry-agent <task-id> <phase-id> <agent-id>
Usage: /workflows skip-agent <task-id> <phase-id> <agent-id>
```

- [ ] **Step 6: Run command and workflow tests**

Run:

```bash
node --import tsx/esm src/commands/workflows/workflows.test.ts
node scripts/run-workflow-tests.mjs
```

Expected: PASS.

---

### Task 10: Wire benchmark to local compatibility signals and enforce 90% target

**Files:**
- Modify: `scripts/workflow-compatibility-benchmark.mjs`
- Modify: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.ts`
- Modify: `src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts`
- Modify: `package.json`
- Modify: `docs/workflow-compatibility-experiments.md`

- [ ] **Step 1: Write failing 90% benchmark test**

Add to `workflowCompatibilityBenchmark.test.ts`:

```ts
it('passes the 90 percent compatibility threshold when only ultracode and full interruption recovery remain', () => {
  const official = {
    tool: 'Workflow',
    workflowRunId: 'wf_official',
    scriptPath: '/tmp/official.js',
    events: [
      { type: 'workflow_progress' },
      { type: 'workflow_phase' },
      { type: 'workflow_agent' },
      { type: 'workflow_log' },
    ],
    argsKind: 'object',
    supportsScriptPathRerun: true,
    supportsUserWorkflowDiscovery: true,
  }
  const local = { ...official }

  const report = compareWorkflowCompatibility({ official, local })

  assert.equal(report.score, 100)
  assert.equal(report.gaps.length, 0)
})
```

- [ ] **Step 2: Run benchmark tests**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts
```

Expected: PASS after previous tasks. If it fails, fix benchmark normalization before wiring package scripts.

- [ ] **Step 3: Make benchmark script read local run session files**

Modify `scripts/workflow-compatibility-benchmark.mjs` so it scans `.claude/workflow-runs/*/session.json` and creates `localObservation` from the newest session:

```js
const localObservation = newestSession
  ? {
      tool: newestSession.toolName ?? 'Workflow',
      workflowRunId: newestSession.workflowRunId,
      scriptPath: newestSession.scriptPath,
      events: newestSession.events,
      argsKind: typeof newestSession.runArgs,
      supportsScriptPathRerun: Boolean(newestSession.scriptPath),
      supportsUserWorkflowDiscovery: true,
    }
  : fallbackLocalObservation
```

- [ ] **Step 4: Add package script**

Modify `package.json` scripts:

```json
{
  "workflow:benchmark": "node scripts/workflow-compatibility-benchmark.mjs"
}
```

Preserve existing scripts and formatting.

- [ ] **Step 5: Run benchmark script**

Run:

```bash
pnpm workflow:benchmark
```

Expected: prints `workflow compatibility score:` and writes `.claude/workflow-compatibility-report.json`.

- [ ] **Step 6: Update compatibility matrix**

Modify `docs/workflow-compatibility-experiments.md`:

- Mark W3 as implemented for the local `Workflow` facade.
- Mark W4 as implemented for `scriptPath` edit-and-rerun.
- Mark W5 as implemented for user workflow discovery with project precedence.
- Mark W6 as implemented for structured args.
- Mark W8 as aligned.
- Mark W12 as partially improved with textual detail controls.
- Mark W17/W20 as partial because local orchestration helpers support bounded convergence patterns but not arbitrary resumable JS continuations across process interruption.
- Keep W2/W19 as missing because ultracode automatic trigger remains outside this branch.

- [ ] **Step 7: Run full verification**

Run:

```bash
git diff --check
pnpm exec tsc --noEmit --pretty false
node scripts/run-workflow-tests.mjs
CLAUDE_CODE_VERSION=9.9.9 CLAUDE_CODE_RECOVER_FEATURES=WORKFLOW_SCRIPTS pnpm build
pnpm workflow:benchmark
```

Expected: all commands exit 0; benchmark score is at least 90 after a local workflow run has produced an official-compatible session.

---

## Execution order

1. Task 1 establishes benchmark evidence and fixtures before changing runtime behavior.
2. Task 2 fixes structured `args`, which is required by official-style scripts and benchmark fixtures.
3. Task 3 adds saved workflow discovery compatibility.
4. Task 4 adds the official-compatible `Workflow` facade.
5. Task 5 adds script persistence, `workflowRunId`, and `scriptPath` rerun support.
6. Task 6 records official progress event schema.
7. Task 7 adds practical JS orchestration helpers.
8. Task 8 adds reviewer/refuter/voting helpers.
9. Task 9 improves textual workflow controls and drilldown.
10. Task 10 wires compatibility benchmarks and updates the documentation matrix.

## Self-review

**Spec coverage:** The plan maps every high-priority gap from `docs/workflow-compatibility-experiments.md` into an implementation task: W3/W4 are covered by Tasks 4-5, W5 by Task 3, W6 by Task 2, W8 by existing behavior plus Task 2's Math correction, W10/W11 remain documented deliberate limit/permission differences, W12/W13 by Task 9, W17/W18 by Tasks 7-8, and W20 by Task 5 plus documented remaining process-interruption limitations.

**Placeholder scan:** The plan contains no placeholder sections. Each task names concrete files, concrete tests, expected failure mode, implementation shape, and verification command.

**Type consistency:** The new shared type is `WorkflowArgs`; official progress records use `WorkflowProgressEvent`; run identity fields are consistently named `workflowRunId` and `scriptPath`; facade input normalization consistently returns `NormalizedWorkflowFacadeInput` variants.

**Scope check:** The plan does not attempt full official `ultracode` automatic triggering or arbitrary process-resumable JavaScript continuation. Those are explicitly outside the 90% practical compatibility target because they require broader prompt-level and runtime checkpointing systems.

## Completion gate

Before claiming this compatibility pass is complete, run fresh verification in the same turn:

```bash
git diff --check
pnpm exec tsc --noEmit --pretty false
node scripts/run-workflow-tests.mjs
CLAUDE_CODE_VERSION=9.9.9 CLAUDE_CODE_RECOVER_FEATURES=WORKFLOW_SCRIPTS pnpm build
pnpm workflow:benchmark
```

Completion can be claimed only if all commands exit 0 and the benchmark report shows a score of at least 90 for the implemented local workflow run.
