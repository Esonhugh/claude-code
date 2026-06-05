# Official Workflow Binary Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resumable 100–200 case compatibility harness that runs `/opt/homebrew/bin/claude` and the local workflow implementation, captures artifacts, confirms differences, and emits development-ready workflow compatibility reports.

**Architecture:** Add focused workflow benchmark modules under `src/tools/WorkflowTool/compatibility/`, with small scripts in `scripts/` as CLI entry points. The harness separates case generation, execution, artifact capture, normalization, comparison, confirmation reruns, official structure reconstruction, and report generation so each layer can be tested independently.

**Tech Stack:** TypeScript, Node.js ESM, `node:test`, `assert/strict`, `child_process.spawn`, filesystem APIs from `node:fs/promises`, existing workflow scripts and `WorkflowFacadeTool`.

---

## File structure

- Create: `src/tools/WorkflowTool/compatibility/types.ts` — shared case, run artifact, diff, report, and reconstruction types.
- Create: `src/tools/WorkflowTool/compatibility/caseMatrix.ts` — deterministic 160-case matrix generator.
- Create: `src/tools/WorkflowTool/compatibility/caseMatrix.test.ts` — validates matrix size, IDs, categories, and required fields.
- Create: `src/tools/WorkflowTool/compatibility/runCommand.ts` — safe command runner with timeout and captured stdout/stderr.
- Create: `src/tools/WorkflowTool/compatibility/runCommand.test.ts` — tests command capture and timeout behavior.
- Create: `src/tools/WorkflowTool/compatibility/artifacts.ts` — per-case workspace creation and artifact read/write helpers.
- Create: `src/tools/WorkflowTool/compatibility/artifacts.test.ts` — tests workspace layout and artifact persistence.
- Create: `src/tools/WorkflowTool/compatibility/executors.ts` — official and local executor construction.
- Create: `src/tools/WorkflowTool/compatibility/executors.test.ts` — tests executor command/env generation without running Claude.
- Create: `src/tools/WorkflowTool/compatibility/normalize.ts` — normalizes output into stable comparison summaries.
- Create: `src/tools/WorkflowTool/compatibility/normalize.test.ts` — tests event, scriptPath, workflowRunId, and prose normalization.
- Create: `src/tools/WorkflowTool/compatibility/compare.ts` — compares official/local normalized outputs and classifies differences.
- Create: `src/tools/WorkflowTool/compatibility/compare.test.ts` — tests difference severity and confidence classification.
- Create: `src/tools/WorkflowTool/compatibility/reconstruct.ts` — builds evidence-backed workflow structure reconstructions.
- Create: `src/tools/WorkflowTool/compatibility/reconstruct.test.ts` — tests phase/agent inference from sample artifacts.
- Create: `src/tools/WorkflowTool/compatibility/report.ts` — emits JSON and Markdown evidence/development reports.
- Create: `src/tools/WorkflowTool/compatibility/report.test.ts` — tests report content and stable links.
- Create: `src/tools/WorkflowTool/compatibility/runner.ts` — orchestrates case execution, comparison, reruns, and resumability.
- Create: `src/tools/WorkflowTool/compatibility/runner.test.ts` — tests resumability and rerun scheduling with fake executors.
- Create: `scripts/workflow-binary-compatibility-runner.mjs` — builds and runs the TypeScript runner bundle.
- Modify: `scripts/run-workflow-tests.mjs` — include new compatibility unit tests.
- Modify: `package.json` — add `workflow:binary-compat` script.
- Create: `docs/workflows/compatibility/README.md` — documents how to run and interpret the generated reports.

---

### Task 1: Define compatibility domain types

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/types.ts`
- Create: `src/tools/WorkflowTool/compatibility/types.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the type smoke test**

Create `src/tools/WorkflowTool/compatibility/types.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  WorkflowCompatibilityCase,
  WorkflowCompatibilityDiff,
  WorkflowExecutorResult,
  WorkflowRunArtifacts,
} from './types.js'

describe('workflow compatibility shared types', () => {
  it('supports a complete compatibility case shape', () => {
    const testCase: WorkflowCompatibilityCase = {
      id: 'ARGS-001',
      title: 'object args through inline script',
      category: 'args',
      prompt: 'Run the fixture workflow with object args.',
      workflowName: 'args-object',
      args: { topic: 'compatibility' },
      fixtureFiles: {
        '.claude/workflows/args-object.js': 'export default workflow({ name: "Args Object", phases: [] })\n',
      },
      env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
      timeoutMs: 120000,
      maxOutputBytes: 200000,
      comparison: {
        mode: 'schema',
        requiredEventTypes: ['workflow_progress'],
        proseFields: ['stdout'],
      },
      confirmation: {
        rerunsOnDifference: 2,
      },
    }

    assert.equal(testCase.id, 'ARGS-001')
    assert.equal(testCase.category, 'args')
    assert.equal(testCase.confirmation.rerunsOnDifference, 2)
  })

  it('supports executor result, artifacts, and diff shapes', () => {
    const artifacts: WorkflowRunArtifacts = {
      caseId: 'CTRL-001',
      executor: 'official',
      attempt: 1,
      workspacePath: '/tmp/workflow-compat/CTRL-001/official/attempt-1',
      command: ['/opt/homebrew/bin/claude', '--version'],
      env: {},
      stdoutPath: 'stdout.txt',
      stderrPath: 'stderr.txt',
      filesManifestPath: 'files.json',
      metadataPath: 'metadata.json',
    }

    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 50,
      stdout: '2.1.150 (Claude Code)\n',
      stderr: '',
      timedOut: false,
    }

    const diff: WorkflowCompatibilityDiff = {
      caseId: 'CTRL-001',
      status: 'same',
      severity: 'P2',
      confidence: 'confirmed',
      samePoints: ['exit code'],
      differences: [],
      likelySourceAreas: [],
      officialArtifacts: artifacts,
      localArtifacts: { ...artifacts, executor: 'local' },
      rerunCount: 0,
    }

    assert.equal(result.exitCode, 0)
    assert.equal(diff.status, 'same')
  })
})
```

- [ ] **Step 2: Run the type smoke test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/types.test.ts
```

Expected: FAIL with module-not-found for `./types.js`.

- [ ] **Step 3: Create the shared type module**

Create `src/tools/WorkflowTool/compatibility/types.ts`:

```ts
export type WorkflowCompatibilityCategory =
  | 'official-export'
  | 'general-task'
  | 'args'
  | 'discovery'
  | 'runtime'
  | 'control'
  | 'error'
  | 'long-running'

export type WorkflowComparisonMode = 'exact' | 'schema' | 'semantic' | 'manual'

export type WorkflowExecutorName = 'official' | 'local'

export type WorkflowDiffStatus =
  | 'same'
  | 'different'
  | 'missing-official'
  | 'missing-local'
  | 'flaky'
  | 'environmental'

export type WorkflowDiffSeverity = 'P0' | 'P1' | 'P2' | 'intentional-divergence'

export type WorkflowDiffConfidence = 'single-run' | 'confirmed' | 'flaky' | 'environmental'

export type WorkflowCompatibilityCase = {
  id: string
  title: string
  category: WorkflowCompatibilityCategory
  prompt: string
  workflowName?: string
  args?: unknown
  fixtureFiles: Record<string, string>
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  comparison: {
    mode: WorkflowComparisonMode
    requiredEventTypes: string[]
    proseFields: string[]
  }
  confirmation: {
    rerunsOnDifference: number
  }
}

export type WorkflowRunArtifacts = {
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  workspacePath: string
  command: string[]
  env: Record<string, string>
  stdoutPath: string
  stderrPath: string
  filesManifestPath: string
  metadataPath: string
}

export type WorkflowExecutorResult = {
  artifacts: WorkflowRunArtifacts
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WorkflowNormalizedResult = {
  caseId: string
  executor: WorkflowExecutorName
  exitCode: number | null
  timedOut: boolean
  eventTypes: string[]
  hasWorkflowRunId: boolean
  hasScriptPath: boolean
  stdoutBucket: string
  stderrBucket: string
  filePaths: string[]
  metadata: Record<string, unknown>
}

export type WorkflowCompatibilityDiff = {
  caseId: string
  status: WorkflowDiffStatus
  severity: WorkflowDiffSeverity
  confidence: WorkflowDiffConfidence
  samePoints: string[]
  differences: string[]
  likelySourceAreas: string[]
  officialArtifacts: WorkflowRunArtifacts
  localArtifacts: WorkflowRunArtifacts
  rerunCount: number
}

export type WorkflowCompatibilityReport = {
  generatedAt: string
  officialBinary: string
  totalCases: number
  completedCases: number
  score: number
  diffs: WorkflowCompatibilityDiff[]
}

export type WorkflowStructureReconstruction = {
  workflowName: string
  purpose: string
  acceptedArgs: string[]
  phases: Array<{
    id: string
    title: string
    inferredFrom: string[]
  }>
  agentRoles: Array<{
    role: string
    inferredFrom: string[]
  }>
  knownDifferences: string[]
  evidenceCaseIds: string[]
}
```

- [ ] **Step 4: Run the type smoke test and verify it passes**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the type test to the workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding this test path to the existing workflow test list:

```js
'src/tools/WorkflowTool/compatibility/types.test.ts',
```

- [ ] **Step 6: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS for existing workflow tests and the new type smoke test.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/types.ts src/tools/WorkflowTool/compatibility/types.test.ts
git commit -m "test: add workflow compatibility domain types"
```

---

### Task 2: Generate the 160-case compatibility matrix

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/caseMatrix.ts`
- Create: `src/tools/WorkflowTool/compatibility/caseMatrix.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write the failing case matrix tests**

Create `src/tools/WorkflowTool/compatibility/caseMatrix.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getWorkflowCompatibilityCases } from './caseMatrix.js'

const expectedCategoryCounts = new Map([
  ['official-export', 20],
  ['general-task', 25],
  ['args', 25],
  ['discovery', 20],
  ['runtime', 20],
  ['control', 15],
  ['error', 15],
  ['long-running', 20],
])

describe('workflow compatibility case matrix', () => {
  it('contains the designed 160 cases with unique stable IDs', () => {
    const cases = getWorkflowCompatibilityCases()
    assert.equal(cases.length, 160)
    assert.equal(new Set(cases.map(testCase => testCase.id)).size, 160)
  })

  it('matches the designed category distribution', () => {
    const cases = getWorkflowCompatibilityCases()
    for (const [category, expectedCount] of expectedCategoryCounts) {
      assert.equal(
        cases.filter(testCase => testCase.category === category).length,
        expectedCount,
        category,
      )
    }
  })

  it('sets execution guardrails on every case', () => {
    for (const testCase of getWorkflowCompatibilityCases()) {
      assert.match(testCase.id, /^[A-Z]+-\d{3}$/)
      assert.ok(testCase.title.length > 0)
      assert.ok(testCase.prompt.length > 0)
      assert.ok(testCase.timeoutMs >= 30000)
      assert.ok(testCase.maxOutputBytes >= 50000)
      assert.ok(testCase.confirmation.rerunsOnDifference >= 2)
      assert.ok(Array.isArray(testCase.comparison.requiredEventTypes))
      assert.ok(Array.isArray(testCase.comparison.proseFields))
    }
  })
})
```

- [ ] **Step 2: Run the case matrix test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/caseMatrix.test.ts
```

Expected: FAIL with module-not-found for `./caseMatrix.js`.

- [ ] **Step 3: Implement the case matrix generator**

Create `src/tools/WorkflowTool/compatibility/caseMatrix.ts`:

```ts
import type {
  WorkflowCompatibilityCase,
  WorkflowCompatibilityCategory,
  WorkflowComparisonMode,
} from './types.js'

type CaseSeed = {
  title: string
  prompt: string
  workflowName?: string
  args?: unknown
  fixtureFiles?: Record<string, string>
  mode?: WorkflowComparisonMode
  requiredEventTypes?: string[]
  proseFields?: string[]
  timeoutMs?: number
}

const DEFAULT_ENV = {
  CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
}

const categoryPrefixes: Record<WorkflowCompatibilityCategory, string> = {
  'official-export': 'EXP',
  'general-task': 'TASK',
  args: 'ARGS',
  discovery: 'DISC',
  runtime: 'RUN',
  control: 'CTRL',
  error: 'ERR',
  'long-running': 'LONG',
}

function workflowFile(name: string, body: string): Record<string, string> {
  return {
    [`.claude/workflows/${name}.js`]: body,
  }
}

function simpleWorkflow(name: string, prompt: string): string {
  return `export default workflow({
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(`${name} compatibility fixture`)},
  defaults: { maxConcurrency: 1, maxAgents: 1, permissionMode: 'plan' },
  phases: [agent({
    id: 'main',
    description: ${JSON.stringify(prompt)},
    prompt: () => ${JSON.stringify(prompt)},
  })],
})\n`
}

function makeCases(
  category: WorkflowCompatibilityCategory,
  seeds: CaseSeed[],
): WorkflowCompatibilityCase[] {
  const prefix = categoryPrefixes[category]
  return seeds.map((seed, index) => {
    const workflowName = seed.workflowName ?? `${prefix.toLowerCase()}-${String(index + 1).padStart(3, '0')}`
    return {
      id: `${prefix}-${String(index + 1).padStart(3, '0')}`,
      title: seed.title,
      category,
      prompt: seed.prompt,
      workflowName,
      args: seed.args,
      fixtureFiles:
        seed.fixtureFiles ?? workflowFile(workflowName, simpleWorkflow(workflowName, seed.prompt)),
      env: DEFAULT_ENV,
      timeoutMs: seed.timeoutMs ?? 120000,
      maxOutputBytes: 200000,
      comparison: {
        mode: seed.mode ?? 'schema',
        requiredEventTypes: seed.requiredEventTypes ?? ['workflow_progress'],
        proseFields: seed.proseFields ?? ['stdout', 'stderr'],
      },
      confirmation: {
        rerunsOnDifference: 2,
      },
    }
  })
}

const officialWorkflowNames = [
  'autopilot',
  'bugfix',
  'bughunt',
  'bughunt-lite',
  'dashboard',
  'deep-research',
  'docs',
  'investigate',
  'plan-hunter',
  'review-branch',
]

const officialExportSeeds: CaseSeed[] = [
  { title: 'official binary version', prompt: 'Report the Claude Code version.', mode: 'exact' },
  { title: 'official binary workflow strings', prompt: 'Export workflow-related binary strings.', mode: 'schema' },
  { title: 'official command help surface', prompt: 'Inspect workflow command help surface.', mode: 'schema' },
  { title: 'official default workflow visibility', prompt: 'List workflow surfaces with default environment.', mode: 'schema' },
  { title: 'official workflow env visibility', prompt: 'List workflow surfaces with workflow feature env enabled.', mode: 'schema' },
  ...officialWorkflowNames.map(name => ({
    title: `official bundled workflow ${name}`,
    prompt: `Probe official bundled workflow ${name}.`,
    workflowName: name,
    mode: 'schema' as const,
  })),
  { title: 'unknown official workflow', prompt: 'Probe an unknown workflow name.', workflowName: 'unknown-workflow-probe', mode: 'schema' },
  { title: 'official workflow metadata repeatability A', prompt: 'Export metadata first repeat.', mode: 'schema' },
  { title: 'official workflow metadata repeatability B', prompt: 'Export metadata second repeat.', mode: 'schema' },
  { title: 'official workflow status surface', prompt: 'Probe workflow status surface.', mode: 'schema' },
  { title: 'official workflow persisted artifact surface', prompt: 'Probe persisted workflow artifacts.', mode: 'schema' },
]

const generalTaskPrompts = [
  'Write a JavaScript add function with a node:test spec.',
  'Write a JavaScript debounce utility with a short spec.',
  'Write a JavaScript parser for comma-separated tags.',
  'Write a TypeScript type guard for string arrays.',
  'Write a node:test spec for a sum function.',
  'Debug a JavaScript off-by-one loop.',
  'Plan a bugfix for a failing CLI flag.',
  'Review a small JavaScript module for correctness.',
  'Write a repository investigation summary.',
  'Draft a technical spec for a small CLI command.',
  'Compare two implementation approaches for retry logic.',
  'Summarize README development workflow.',
  'Create a migration checklist for renaming a function.',
  'Write a minimal JSON schema example.',
  'Design a small file discovery helper.',
  'Write a test plan for workflow discovery.',
  'Produce a code audit checklist.',
  'Draft docs for a workflow command.',
  'Create a small error taxonomy.',
  'Write a JavaScript function that groups records by key.',
  'Write a spec for CLI args parsing.',
  'Investigate how a status command should behave.',
  'Generate a refactor plan for a large module.',
  'Write a small markdown report from JSON input.',
  'Plan validation for deterministic workflow scripts.',
]

const argsSeeds: CaseSeed[] = [
  { title: 'omitted args', prompt: 'Run with omitted args.' },
  { title: 'string args', prompt: 'Run with string args.', args: 'compatibility topic' },
  { title: 'object args', prompt: 'Run with object args.', args: { topic: 'compatibility', depth: 2 } },
  { title: 'array args', prompt: 'Run with array args.', args: ['alpha', 'beta'] },
  { title: 'number args', prompt: 'Run with number args.', args: 42 },
  { title: 'boolean true args', prompt: 'Run with boolean true args.', args: true },
  { title: 'boolean false args', prompt: 'Run with boolean false args.', args: false },
  { title: 'null args', prompt: 'Run with null args.', args: null },
  { title: 'nested object args', prompt: 'Run with nested object args.', args: { a: { b: ['c'] } } },
  { title: 'unicode args', prompt: 'Run with unicode args.', args: { text: '工作流兼容性' } },
  { title: 'shell character args', prompt: 'Run with shell-sensitive args.', args: { text: '$(echo nope); && ||' } },
  { title: 'long string args', prompt: 'Run with long string args.', args: 'x'.repeat(2000) },
  { title: 'empty object args', prompt: 'Run with empty object args.', args: {} },
  { title: 'empty array args', prompt: 'Run with empty array args.', args: [] },
  { title: 'args topic field', prompt: 'Read args.topic.', args: { topic: 'workflow export' } },
  { title: 'args count field', prompt: 'Read args.count.', args: { count: 3 } },
  { title: 'args enabled field', prompt: 'Read args.enabled.', args: { enabled: true } },
  { title: 'args items field', prompt: 'Read args.items.', args: { items: [1, 2, 3] } },
  { title: 'args mixed primitives', prompt: 'Read mixed primitive args.', args: { s: 'a', n: 1, b: false, z: null } },
  { title: 'args json-like string', prompt: 'Run with JSON-looking string args.', args: '{"topic":"json-string"}' },
  { title: 'args path string', prompt: 'Run with path args.', args: './docs/workflows' },
  { title: 'args multiline string', prompt: 'Run with multiline args.', args: 'line one\nline two' },
  { title: 'args date-like string', prompt: 'Run with date-like string args.', args: '2026-06-06T00:00:00.000Z' },
  { title: 'args numeric array', prompt: 'Run with numeric array args.', args: [1, 2, 3] },
  { title: 'args object array', prompt: 'Run with object array args.', args: [{ name: 'a' }, { name: 'b' }] },
]

const discoverySeeds: CaseSeed[] = Array.from({ length: 20 }, (_, index) => {
  const name = `discovery-${String(index + 1).padStart(3, '0')}`
  const prompt = `Probe workflow discovery case ${index + 1}.`
  const fixtureFiles =
    index % 4 === 0
      ? { [`docs/workflows/${name}.js`]: simpleWorkflow(name, prompt) }
      : index % 4 === 1
        ? { [`.claude/workflows/${name}.js`]: simpleWorkflow(name, prompt) }
        : index % 4 === 2
          ? {
              [`docs/workflows/${name}.js`]: simpleWorkflow(name, `${prompt} docs version`),
              [`.claude/workflows/${name}.js`]: simpleWorkflow(name, `${prompt} project version`),
            }
          : { [`.claude/workflows/${name}.txt`]: 'not a workflow\n' }
  return { title: `workflow discovery ${index + 1}`, prompt, workflowName: name, fixtureFiles }
})

const runtimeScripts = [
  'declarative workflow',
  'async function export',
  'single agent helper',
  'parallel helper',
  'series helper',
  'retry helper',
  'loopUntil helper',
  'review helper',
  'refute helper',
  'synthesize helper',
  'vote helper',
  'Date.now deterministic guard',
  'new Date deterministic guard',
  'Math.random deterministic guard',
  'process unavailable',
  'require unavailable',
  'helper thrown error',
  'max concurrency two',
  'max agents two',
  'nested orchestration helpers',
]

const controlSeeds = [
  'status after run',
  'list runs',
  'show run detail',
  'pause run',
  'resume run',
  'retry agent',
  'skip agent',
  'scriptPath rerun',
  'script edit rerun',
  'resumeFromRunId metadata',
  'workflowRunId stability',
  'session artifact layout',
  'official event names',
  'task state mapping',
  'workflow detail output',
].map(title => ({ title, prompt: `Probe control behavior: ${title}.` }))

const errorSeeds = [
  'missing workflow',
  'invalid workflow script syntax',
  'valid JS invalid workflow shape',
  'bad args',
  'permission denied',
  'agent failure',
  'timeout',
  'output too large',
  'interrupted run',
  'missing scriptPath',
  'unreadable scriptPath',
  'duplicate phase ID',
  'duplicate agent ID',
  'invalid phase dependency',
  'deterministic runtime violation',
].map(title => ({ title, prompt: `Probe error behavior: ${title}.`, mode: 'schema' as const }))

const longRunningSeeds = [
  'independent implementer agents',
  'reviewer refuter loop',
  'synthesis after parallel attempts',
  'build test repair convergence',
  'two reviewers per generated file',
  'multi phase research plan',
  'multi phase spec writing',
  'dashboard style monitoring',
  'bughunt lite style scan',
  'full bughunt style scan',
  'review branch style review',
  'docs workflow behavior',
  'investigate workflow behavior',
  'plan hunter workflow behavior',
  'autopilot end to end task runner',
  'long args with reviewers',
  'parallel code and spec writers',
  'retry after synthetic failure',
  'convergence stop condition',
  'final synthesis report',
].map(title => ({ title, prompt: `Run long workflow behavior: ${title}.`, timeoutMs: 300000 }))

export function getWorkflowCompatibilityCases(): WorkflowCompatibilityCase[] {
  return [
    ...makeCases('official-export', officialExportSeeds),
    ...makeCases(
      'general-task',
      generalTaskPrompts.map(prompt => ({ title: prompt.toLowerCase(), prompt })),
    ),
    ...makeCases('args', argsSeeds),
    ...makeCases('discovery', discoverySeeds),
    ...makeCases(
      'runtime',
      runtimeScripts.map(title => ({ title, prompt: `Probe runtime behavior: ${title}.` })),
    ),
    ...makeCases('control', controlSeeds),
    ...makeCases('error', errorSeeds),
    ...makeCases('long-running', longRunningSeeds),
  ]
}
```

- [ ] **Step 4: Run the case matrix test and verify it passes**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/caseMatrix.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the case matrix test to the workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding this test path:

```js
'src/tools/WorkflowTool/compatibility/caseMatrix.test.ts',
```

- [ ] **Step 6: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/caseMatrix.ts src/tools/WorkflowTool/compatibility/caseMatrix.test.ts
git commit -m "test: add workflow compatibility case matrix"
```

---

### Task 3: Add command execution and artifact helpers

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/runCommand.ts`
- Create: `src/tools/WorkflowTool/compatibility/runCommand.test.ts`
- Create: `src/tools/WorkflowTool/compatibility/artifacts.ts`
- Create: `src/tools/WorkflowTool/compatibility/artifacts.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write command runner tests**

Create `src/tools/WorkflowTool/compatibility/runCommand.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCommand } from './runCommand.js'

describe('workflow compatibility command runner', () => {
  it('captures stdout, stderr, exit code, and duration', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.log("out"); console.error("err")'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      maxOutputBytes: 10000,
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout.trim(), 'out')
    assert.equal(result.stderr.trim(), 'err')
    assert.equal(result.timedOut, false)
    assert.ok(result.durationMs >= 0)
  })

  it('marks timed out commands and truncates output safely', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => console.log("late"), 2000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      maxOutputBytes: 10000,
    })

    assert.equal(result.exitCode, null)
    assert.equal(result.timedOut, true)
  })
})
```

- [ ] **Step 2: Write artifact helper tests**

Create `src/tools/WorkflowTool/compatibility/artifacts.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import {
  createCaseWorkspace,
  writeExecutorArtifacts,
} from './artifacts.js'

describe('workflow compatibility artifacts', () => {
  it('creates isolated case workspaces and writes executor artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-compat-artifacts-'))
    try {
      const workspace = await createCaseWorkspace({
        outputRoot: root,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        fixtureFiles: {
          'README.md': '# fixture\n',
          '.claude/workflows/demo.js': 'export default workflow({ name: "Demo", phases: [] })\n',
        },
      })

      const artifacts = await writeExecutorArtifacts({
        workspacePath: workspace,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        command: ['/opt/homebrew/bin/claude', '-p', 'hello'],
        env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
        stdout: 'out',
        stderr: 'err',
        metadata: { exitCode: 0 },
      })

      assert.equal(artifacts.caseId, 'ARGS-001')
      assert.equal(artifacts.executor, 'official')
      assert.ok(artifacts.stdoutPath.endsWith('stdout.txt'))
      assert.ok(artifacts.filesManifestPath.endsWith('files.json'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 3: Run both tests and verify they fail**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/runCommand.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/artifacts.test.ts
```

Expected: both FAIL with module-not-found errors.

- [ ] **Step 4: Implement command runner**

Create `src/tools/WorkflowTool/compatibility/runCommand.ts`:

```ts
import { spawn } from 'node:child_process'

export type RunCommandInput = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

export type RunCommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function appendLimited(current: string, chunk: Buffer, maxOutputBytes: number): string {
  const combined = current + chunk.toString('utf8')
  if (Buffer.byteLength(combined, 'utf8') <= maxOutputBytes) return combined
  return combined.slice(0, maxOutputBytes) + '\n[truncated]\n'
}

export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const startedAt = Date.now()

  return await new Promise(resolve => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 250)
    }, input.timeoutMs)

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, chunk, input.maxOutputBytes)
    })

    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, chunk, input.maxOutputBytes)
    })

    child.on('error', error => {
      clearTimeout(timeout)
      resolve({
        exitCode: timedOut ? null : 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}${error.message}\n`,
        timedOut,
      })
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({
        exitCode: timedOut ? null : exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}
```

- [ ] **Step 5: Implement artifact helpers**

Create `src/tools/WorkflowTool/compatibility/artifacts.ts`:

```ts
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowExecutorName, WorkflowRunArtifacts } from './types.js'

export async function createCaseWorkspace({
  outputRoot,
  caseId,
  executor,
  attempt,
  fixtureFiles,
}: {
  outputRoot: string
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  fixtureFiles: Record<string, string>
}): Promise<string> {
  const workspacePath = join(outputRoot, caseId, executor, `attempt-${attempt}`)
  await mkdir(workspacePath, { recursive: true })

  for (const [relativePath, content] of Object.entries(fixtureFiles)) {
    const targetPath = join(workspacePath, relativePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  return workspacePath
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)))
    } else {
      const fileStat = await stat(absolutePath)
      files.push(`${absolutePath.slice(root.length + 1)}\t${fileStat.size}`)
    }
  }
  return files.sort()
}

export async function writeExecutorArtifacts({
  workspacePath,
  caseId,
  executor,
  attempt,
  command,
  env,
  stdout,
  stderr,
  metadata,
}: {
  workspacePath: string
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  command: string[]
  env: Record<string, string>
  stdout: string
  stderr: string
  metadata: Record<string, unknown>
}): Promise<WorkflowRunArtifacts> {
  const stdoutPath = join(workspacePath, 'stdout.txt')
  const stderrPath = join(workspacePath, 'stderr.txt')
  const filesManifestPath = join(workspacePath, 'files.json')
  const metadataPath = join(workspacePath, 'metadata.json')

  await writeFile(stdoutPath, stdout)
  await writeFile(stderrPath, stderr)
  await writeFile(filesManifestPath, `${JSON.stringify(await listFiles(workspacePath), null, 2)}\n`)
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  return {
    caseId,
    executor,
    attempt,
    workspacePath,
    command,
    env,
    stdoutPath,
    stderrPath,
    filesManifestPath,
    metadataPath,
  }
}
```

- [ ] **Step 6: Run both tests and verify they pass**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/runCommand.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add tests to workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding:

```js
'src/tools/WorkflowTool/compatibility/runCommand.test.ts',
'src/tools/WorkflowTool/compatibility/artifacts.test.ts',
```

- [ ] **Step 8: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/runCommand.ts src/tools/WorkflowTool/compatibility/runCommand.test.ts src/tools/WorkflowTool/compatibility/artifacts.ts src/tools/WorkflowTool/compatibility/artifacts.test.ts
git commit -m "feat: add workflow compatibility artifact capture"
```

---

### Task 4: Build official and local executor command generation

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/executors.ts`
- Create: `src/tools/WorkflowTool/compatibility/executors.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write executor tests**

Create `src/tools/WorkflowTool/compatibility/executors.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildLocalExecutionPlan,
  buildOfficialExecutionPlan,
} from './executors.js'

const testCase = {
  id: 'ARGS-001',
  title: 'object args',
  category: 'args' as const,
  prompt: 'Run object args workflow.',
  workflowName: 'object-args',
  args: { topic: 'compatibility' },
  fixtureFiles: {},
  env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
  timeoutMs: 120000,
  maxOutputBytes: 200000,
  comparison: { mode: 'schema' as const, requiredEventTypes: [], proseFields: [] },
  confirmation: { rerunsOnDifference: 2 },
}

describe('workflow compatibility executors', () => {
  it('builds the official binary execution plan', () => {
    const plan = buildOfficialExecutionPlan({
      testCase,
      workspacePath: '/tmp/official',
      officialBinary: '/opt/homebrew/bin/claude',
    })

    assert.equal(plan.command, '/opt/homebrew/bin/claude')
    assert.deepEqual(plan.args, ['-p', '--bare', 'Run object args workflow.'])
    assert.equal(plan.cwd, '/tmp/official')
    assert.equal(plan.env.CLAUDE_CODE_RECOVER_FEATURES, 'WORKFLOW_SCRIPTS')
  })

  it('builds the local repository execution plan', () => {
    const plan = buildLocalExecutionPlan({
      testCase,
      workspacePath: '/tmp/local',
      projectRoot: '/repo',
    })

    assert.equal(plan.command, process.execPath)
    assert.deepEqual(plan.args, ['/repo/dist/cli.js', '-p', '--bare', 'Run object args workflow.'])
    assert.equal(plan.cwd, '/tmp/local')
    assert.equal(plan.env.CLAUDE_CODE_RECOVER_FEATURES, 'WORKFLOW_SCRIPTS')
  })
})
```

- [ ] **Step 2: Run executor tests and verify they fail**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/executors.test.ts
```

Expected: FAIL with module-not-found for `./executors.js`.

- [ ] **Step 3: Implement executor plan generation**

Create `src/tools/WorkflowTool/compatibility/executors.ts`:

```ts
import { join } from 'node:path'
import type { WorkflowCompatibilityCase } from './types.js'

export type WorkflowExecutionPlan = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export function buildOfficialExecutionPlan({
  testCase,
  workspacePath,
  officialBinary,
}: {
  testCase: WorkflowCompatibilityCase
  workspacePath: string
  officialBinary: string
}): WorkflowExecutionPlan {
  return {
    command: officialBinary,
    args: ['-p', '--bare', testCase.prompt],
    cwd: workspacePath,
    env: testCase.env,
  }
}

export function buildLocalExecutionPlan({
  testCase,
  workspacePath,
  projectRoot,
}: {
  testCase: WorkflowCompatibilityCase
  workspacePath: string
  projectRoot: string
}): WorkflowExecutionPlan {
  return {
    command: process.execPath,
    args: [join(projectRoot, 'dist', 'cli.js'), '-p', '--bare', testCase.prompt],
    cwd: workspacePath,
    env: testCase.env,
  }
}
```

- [ ] **Step 4: Run executor tests and verify they pass**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/executors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add executor test to workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding:

```js
'src/tools/WorkflowTool/compatibility/executors.test.ts',
```

- [ ] **Step 6: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/executors.ts src/tools/WorkflowTool/compatibility/executors.test.ts
git commit -m "feat: add workflow compatibility executors"
```

---

### Task 5: Normalize and compare run outputs

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/normalize.ts`
- Create: `src/tools/WorkflowTool/compatibility/normalize.test.ts`
- Create: `src/tools/WorkflowTool/compatibility/compare.ts`
- Create: `src/tools/WorkflowTool/compatibility/compare.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write normalization tests**

Create `src/tools/WorkflowTool/compatibility/normalize.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeWorkflowExecutorResult } from './normalize.js'
import type { WorkflowExecutorResult } from './types.js'

const artifacts = {
  caseId: 'RUN-001',
  executor: 'official' as const,
  attempt: 1,
  workspacePath: '/tmp/run',
  command: ['claude'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

describe('workflow compatibility normalization', () => {
  it('extracts stable workflow mechanics from stdout and metadata', () => {
    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdout: 'workflowRunId: wf_123\nscriptPath: /tmp/script.js\nworkflow_progress\nworkflow_agent\nGenerated prose here.\n',
      stderr: '',
      timedOut: false,
    }

    const normalized = normalizeWorkflowExecutorResult(result, {
      files: ['.claude/workflow-runs/wf_123/session.json\t100'],
      metadata: { custom: true },
    })

    assert.equal(normalized.hasWorkflowRunId, true)
    assert.equal(normalized.hasScriptPath, true)
    assert.deepEqual(normalized.eventTypes, ['workflow_agent', 'workflow_progress'])
    assert.equal(normalized.stdoutBucket, 'workflow-mechanics-and-prose')
    assert.deepEqual(normalized.filePaths, ['.claude/workflow-runs/wf_123/session.json'])
  })
})
```

- [ ] **Step 2: Write comparison tests**

Create `src/tools/WorkflowTool/compatibility/compare.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareNormalizedWorkflowResults } from './compare.js'
import type { WorkflowNormalizedResult, WorkflowRunArtifacts } from './types.js'

const officialArtifacts: WorkflowRunArtifacts = {
  caseId: 'RUN-001',
  executor: 'official',
  attempt: 1,
  workspacePath: '/tmp/official',
  command: ['claude'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

const localArtifacts: WorkflowRunArtifacts = {
  ...officialArtifacts,
  executor: 'local',
  workspacePath: '/tmp/local',
}

function normalized(overrides: Partial<WorkflowNormalizedResult>): WorkflowNormalizedResult {
  return {
    caseId: 'RUN-001',
    executor: 'official',
    exitCode: 0,
    timedOut: false,
    eventTypes: ['workflow_progress'],
    hasWorkflowRunId: true,
    hasScriptPath: true,
    stdoutBucket: 'workflow-mechanics-and-prose',
    stderrBucket: 'empty',
    filePaths: [],
    metadata: {},
    ...overrides,
  }
}

describe('workflow compatibility comparison', () => {
  it('marks matching mechanics as same', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official' }),
      local: normalized({ executor: 'local' }),
      officialArtifacts,
      localArtifacts,
      rerunCount: 0,
    })

    assert.equal(diff.status, 'same')
    assert.equal(diff.confidence, 'single-run')
    assert.deepEqual(diff.differences, [])
  })

  it('marks missing local scriptPath as a P1 difference', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official', hasScriptPath: true }),
      local: normalized({ executor: 'local', hasScriptPath: false }),
      officialArtifacts,
      localArtifacts,
      rerunCount: 2,
    })

    assert.equal(diff.status, 'different')
    assert.equal(diff.severity, 'P1')
    assert.equal(diff.confidence, 'confirmed')
    assert.ok(diff.differences.includes('local missing scriptPath'))
  })
})
```

- [ ] **Step 3: Run normalization and comparison tests and verify they fail**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/normalize.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/compare.test.ts
```

Expected: both FAIL with module-not-found errors.

- [ ] **Step 4: Implement normalization**

Create `src/tools/WorkflowTool/compatibility/normalize.ts`:

```ts
import type { WorkflowExecutorResult, WorkflowNormalizedResult } from './types.js'

const EVENT_PATTERN = /\bworkflow_(?:progress|agent|phase|log)\b/g

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function bucketText(text: string): string {
  if (text.trim().length === 0) return 'empty'
  const hasMechanics = /workflowRunId|scriptPath|workflow_/.test(text)
  return hasMechanics ? 'workflow-mechanics-and-prose' : 'prose-only'
}

export function normalizeWorkflowExecutorResult(
  result: WorkflowExecutorResult,
  artifactData: { files: string[]; metadata: Record<string, unknown> },
): WorkflowNormalizedResult {
  const combinedText = `${result.stdout}\n${result.stderr}`
  const eventTypes = uniqueSorted(combinedText.match(EVENT_PATTERN) ?? [])

  return {
    caseId: result.artifacts.caseId,
    executor: result.artifacts.executor,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    eventTypes,
    hasWorkflowRunId: /workflowRunId\s*[:=]/.test(combinedText),
    hasScriptPath: /scriptPath\s*[:=]/.test(combinedText),
    stdoutBucket: bucketText(result.stdout),
    stderrBucket: bucketText(result.stderr),
    filePaths: artifactData.files.map(file => file.split('\t')[0]).sort(),
    metadata: artifactData.metadata,
  }
}
```

- [ ] **Step 5: Implement comparison**

Create `src/tools/WorkflowTool/compatibility/compare.ts`:

```ts
import type {
  WorkflowCompatibilityDiff,
  WorkflowDiffSeverity,
  WorkflowNormalizedResult,
  WorkflowRunArtifacts,
} from './types.js'

function severityFor(differences: string[]): WorkflowDiffSeverity {
  if (differences.some(difference => difference.includes('exit code') || difference.includes('timed out'))) {
    return 'P0'
  }
  if (differences.some(difference => difference.includes('scriptPath') || difference.includes('workflowRunId'))) {
    return 'P1'
  }
  return 'P2'
}

export function compareNormalizedWorkflowResults({
  caseId,
  official,
  local,
  officialArtifacts,
  localArtifacts,
  rerunCount,
}: {
  caseId: string
  official: WorkflowNormalizedResult
  local: WorkflowNormalizedResult
  officialArtifacts: WorkflowRunArtifacts
  localArtifacts: WorkflowRunArtifacts
  rerunCount: number
}): WorkflowCompatibilityDiff {
  const samePoints: string[] = []
  const differences: string[] = []

  if (official.exitCode === local.exitCode) samePoints.push('exit code')
  else differences.push(`exit code official=${official.exitCode} local=${local.exitCode}`)

  if (official.timedOut === local.timedOut) samePoints.push('timeout state')
  else differences.push(`timed out official=${official.timedOut} local=${local.timedOut}`)

  if (official.hasWorkflowRunId === local.hasWorkflowRunId) samePoints.push('workflowRunId presence')
  else differences.push(local.hasWorkflowRunId ? 'official missing workflowRunId' : 'local missing workflowRunId')

  if (official.hasScriptPath === local.hasScriptPath) samePoints.push('scriptPath presence')
  else differences.push(local.hasScriptPath ? 'official missing scriptPath' : 'local missing scriptPath')

  const officialEvents = official.eventTypes.join(',')
  const localEvents = local.eventTypes.join(',')
  if (officialEvents === localEvents) samePoints.push('event types')
  else differences.push(`event types official=${officialEvents} local=${localEvents}`)

  return {
    caseId,
    status: differences.length === 0 ? 'same' : 'different',
    severity: severityFor(differences),
    confidence: rerunCount >= 2 ? 'confirmed' : 'single-run',
    samePoints,
    differences,
    likelySourceAreas: differences.map(difference => {
      if (difference.includes('scriptPath')) return 'workflowScriptPersistence'
      if (difference.includes('workflowRunId')) return 'workflowRunSessions'
      if (difference.includes('event types')) return 'runWorkflow'
      return 'WorkflowFacadeTool'
    }),
    officialArtifacts,
    localArtifacts,
    rerunCount,
  }
}
```

- [ ] **Step 6: Run normalization and comparison tests and verify they pass**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/normalize.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/compare.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add tests to workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding:

```js
'src/tools/WorkflowTool/compatibility/normalize.test.ts',
'src/tools/WorkflowTool/compatibility/compare.test.ts',
```

- [ ] **Step 8: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/normalize.ts src/tools/WorkflowTool/compatibility/normalize.test.ts src/tools/WorkflowTool/compatibility/compare.ts src/tools/WorkflowTool/compatibility/compare.test.ts
git commit -m "feat: compare workflow compatibility artifacts"
```

---

### Task 6: Generate reconstruction and reports

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/reconstruct.ts`
- Create: `src/tools/WorkflowTool/compatibility/reconstruct.test.ts`
- Create: `src/tools/WorkflowTool/compatibility/report.ts`
- Create: `src/tools/WorkflowTool/compatibility/report.test.ts`
- Modify: `scripts/run-workflow-tests.mjs`

- [ ] **Step 1: Write reconstruction tests**

Create `src/tools/WorkflowTool/compatibility/reconstruct.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reconstructWorkflowStructures } from './reconstruct.js'

describe('workflow structure reconstruction', () => {
  it('infers workflow purpose, phases, and agent roles from evidence text', () => {
    const reconstructions = reconstructWorkflowStructures([
      {
        caseId: 'EXP-006',
        workflowName: 'deep-research',
        evidenceText: 'deep-research gathers sources, runs research agents, reviews findings, and synthesizes a final report. workflow_phase research workflow_agent reviewer workflow_phase synthesis',
      },
    ])

    assert.equal(reconstructions.length, 1)
    assert.equal(reconstructions[0].workflowName, 'deep-research')
    assert.ok(reconstructions[0].purpose.includes('research'))
    assert.deepEqual(reconstructions[0].evidenceCaseIds, ['EXP-006'])
    assert.ok(reconstructions[0].phases.some(phase => phase.id === 'research'))
    assert.ok(reconstructions[0].agentRoles.some(agent => agent.role === 'reviewer'))
  })
})
```

- [ ] **Step 2: Write report tests**

Create `src/tools/WorkflowTool/compatibility/report.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderDevelopmentGuideMarkdown, renderEvidenceMatrixMarkdown } from './report.js'
import type { WorkflowCompatibilityDiff, WorkflowCompatibilityReport } from './types.js'

const artifacts = {
  caseId: 'RUN-001',
  executor: 'official' as const,
  attempt: 1,
  workspacePath: '/tmp/official',
  command: ['claude'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

const diff: WorkflowCompatibilityDiff = {
  caseId: 'RUN-001',
  status: 'different',
  severity: 'P1',
  confidence: 'confirmed',
  samePoints: ['exit code'],
  differences: ['local missing scriptPath'],
  likelySourceAreas: ['workflowScriptPersistence'],
  officialArtifacts: artifacts,
  localArtifacts: { ...artifacts, executor: 'local', workspacePath: '/tmp/local' },
  rerunCount: 2,
}

const report: WorkflowCompatibilityReport = {
  generatedAt: '2026-06-06T00:00:00.000Z',
  officialBinary: '/opt/homebrew/bin/claude',
  totalCases: 1,
  completedCases: 1,
  score: 86,
  diffs: [diff],
}

describe('workflow compatibility reports', () => {
  it('renders a per-case evidence matrix', () => {
    const markdown = renderEvidenceMatrixMarkdown(report)
    assert.match(markdown, /# Workflow Compatibility Evidence Matrix/)
    assert.match(markdown, /RUN-001/)
    assert.match(markdown, /local missing scriptPath/)
  })

  it('renders a development guide grouped by source area', () => {
    const markdown = renderDevelopmentGuideMarkdown(report)
    assert.match(markdown, /# Workflow Compatibility Development Guide/)
    assert.match(markdown, /workflowScriptPersistence/)
    assert.match(markdown, /RUN-001/)
  })
})
```

- [ ] **Step 3: Run reconstruction and report tests and verify they fail**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/reconstruct.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/report.test.ts
```

Expected: both FAIL with module-not-found errors.

- [ ] **Step 4: Implement reconstruction**

Create `src/tools/WorkflowTool/compatibility/reconstruct.ts`:

```ts
import type { WorkflowStructureReconstruction } from './types.js'

export type WorkflowEvidence = {
  caseId: string
  workflowName: string
  evidenceText: string
}

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase()
  return terms.some(term => lower.includes(term))
}

export function reconstructWorkflowStructures(
  evidence: WorkflowEvidence[],
): WorkflowStructureReconstruction[] {
  const byWorkflow = new Map<string, WorkflowEvidence[]>()
  for (const item of evidence) {
    const items = byWorkflow.get(item.workflowName) ?? []
    items.push(item)
    byWorkflow.set(item.workflowName, items)
  }

  return [...byWorkflow.entries()].map(([workflowName, items]) => {
    const text = items.map(item => item.evidenceText).join('\n').toLowerCase()
    const phases: WorkflowStructureReconstruction['phases'] = []
    const agentRoles: WorkflowStructureReconstruction['agentRoles'] = []

    if (includesAny(text, ['research', 'investigate'])) {
      phases.push({ id: 'research', title: 'Research', inferredFrom: items.map(item => item.caseId) })
    }
    if (includesAny(text, ['review', 'reviewer'])) {
      phases.push({ id: 'review', title: 'Review', inferredFrom: items.map(item => item.caseId) })
      agentRoles.push({ role: 'reviewer', inferredFrom: items.map(item => item.caseId) })
    }
    if (includesAny(text, ['synthesis', 'synthesize', 'final report'])) {
      phases.push({ id: 'synthesis', title: 'Synthesis', inferredFrom: items.map(item => item.caseId) })
      agentRoles.push({ role: 'synthesizer', inferredFrom: items.map(item => item.caseId) })
    }
    if (phases.length === 0) {
      phases.push({ id: 'main', title: 'Main', inferredFrom: items.map(item => item.caseId) })
    }

    return {
      workflowName,
      purpose: includesAny(text, ['research'])
        ? 'Runs research-oriented workflow phases and synthesizes findings.'
        : 'Runs an observed official workflow pattern.',
      acceptedArgs: ['string', 'object', 'omitted'],
      phases,
      agentRoles,
      knownDifferences: [],
      evidenceCaseIds: items.map(item => item.caseId),
    }
  })
}
```

- [ ] **Step 5: Implement reports**

Create `src/tools/WorkflowTool/compatibility/report.ts`:

```ts
import type { WorkflowCompatibilityDiff, WorkflowCompatibilityReport } from './types.js'

function differenceText(diff: WorkflowCompatibilityDiff): string {
  return diff.differences.length === 0 ? 'none' : diff.differences.join('; ')
}

export function renderEvidenceMatrixMarkdown(report: WorkflowCompatibilityReport): string {
  const lines = [
    '# Workflow Compatibility Evidence Matrix',
    '',
    `Generated: ${report.generatedAt}`,
    `Official binary: ${report.officialBinary}`,
    `Score: ${report.score}`,
    '',
    '| Case | Status | Severity | Confidence | Reruns | Differences | Official Artifacts | Local Artifacts |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- |',
  ]

  for (const diff of report.diffs) {
    lines.push(
      `| ${diff.caseId} | ${diff.status} | ${diff.severity} | ${diff.confidence} | ${diff.rerunCount} | ${differenceText(diff)} | ${diff.officialArtifacts.workspacePath} | ${diff.localArtifacts.workspacePath} |`,
    )
  }

  return `${lines.join('\n')}\n`
}

export function renderDevelopmentGuideMarkdown(report: WorkflowCompatibilityReport): string {
  const byArea = new Map<string, WorkflowCompatibilityDiff[]>()
  for (const diff of report.diffs) {
    for (const area of diff.likelySourceAreas.length === 0 ? ['no-change-needed'] : diff.likelySourceAreas) {
      const diffs = byArea.get(area) ?? []
      diffs.push(diff)
      byArea.set(area, diffs)
    }
  }

  const lines = [
    '# Workflow Compatibility Development Guide',
    '',
    `Generated: ${report.generatedAt}`,
    `Compatibility score: ${report.score}`,
    '',
  ]

  for (const [area, diffs] of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${area}`, '')
    for (const diff of diffs) {
      lines.push(`- ${diff.caseId} (${diff.severity}, ${diff.confidence}): ${differenceText(diff)}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
```

- [ ] **Step 6: Run reconstruction and report tests and verify they pass**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/reconstruct.test.ts
node --import tsx/esm src/tools/WorkflowTool/compatibility/report.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add tests to workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding:

```js
'src/tools/WorkflowTool/compatibility/reconstruct.test.ts',
'src/tools/WorkflowTool/compatibility/report.test.ts',
```

- [ ] **Step 8: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-workflow-tests.mjs src/tools/WorkflowTool/compatibility/reconstruct.ts src/tools/WorkflowTool/compatibility/reconstruct.test.ts src/tools/WorkflowTool/compatibility/report.ts src/tools/WorkflowTool/compatibility/report.test.ts
git commit -m "feat: report workflow compatibility gaps"
```

---

### Task 7: Orchestrate resumable compatibility runs

**Files:**
- Create: `src/tools/WorkflowTool/compatibility/runner.ts`
- Create: `src/tools/WorkflowTool/compatibility/runner.test.ts`
- Create: `scripts/workflow-binary-compatibility-runner.mjs`
- Modify: `scripts/run-workflow-tests.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write runner tests with fake executors**

Create `src/tools/WorkflowTool/compatibility/runner.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import { runWorkflowCompatibilityCases } from './runner.js'
import type { WorkflowCompatibilityCase, WorkflowExecutorResult } from './types.js'

function makeResult(
  testCase: WorkflowCompatibilityCase,
  executor: 'official' | 'local',
  stdout: string,
): WorkflowExecutorResult {
  return {
    artifacts: {
      caseId: testCase.id,
      executor,
      attempt: 1,
      workspacePath: `/tmp/${testCase.id}/${executor}`,
      command: ['fake'],
      env: {},
      stdoutPath: 'stdout.txt',
      stderrPath: 'stderr.txt',
      filesManifestPath: 'files.json',
      metadataPath: 'metadata.json',
    },
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout,
    stderr: '',
    timedOut: false,
  }
}

const testCase: WorkflowCompatibilityCase = {
  id: 'RUN-001',
  title: 'runner smoke',
  category: 'runtime',
  prompt: 'Run smoke.',
  fixtureFiles: {},
  env: {},
  timeoutMs: 30000,
  maxOutputBytes: 50000,
  comparison: { mode: 'schema', requiredEventTypes: ['workflow_progress'], proseFields: ['stdout'] },
  confirmation: { rerunsOnDifference: 2 },
}

describe('workflow compatibility runner', () => {
  it('runs official and local executors and reruns confirmed differences', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'workflow-compat-runner-'))
    let officialRuns = 0
    let localRuns = 0
    try {
      const report = await runWorkflowCompatibilityCases({
        cases: [testCase],
        outputRoot,
        force: true,
        officialExecutor: async testCase => {
          officialRuns += 1
          return makeResult(testCase, 'official', 'workflowRunId: wf_1\nscriptPath: official.js\nworkflow_progress\n')
        },
        localExecutor: async testCase => {
          localRuns += 1
          return makeResult(testCase, 'local', 'workflowRunId: wf_1\nworkflow_progress\n')
        },
      })

      assert.equal(report.totalCases, 1)
      assert.equal(report.completedCases, 1)
      assert.equal(report.diffs[0].status, 'different')
      assert.equal(report.diffs[0].rerunCount, 2)
      assert.equal(officialRuns, 3)
      assert.equal(localRuns, 3)
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run runner test and verify it fails**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/runner.test.ts
```

Expected: FAIL with module-not-found for `./runner.js`.

- [ ] **Step 3: Implement runner orchestration**

Create `src/tools/WorkflowTool/compatibility/runner.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareNormalizedWorkflowResults } from './compare.js'
import { normalizeWorkflowExecutorResult } from './normalize.js'
import { renderDevelopmentGuideMarkdown, renderEvidenceMatrixMarkdown } from './report.js'
import type {
  WorkflowCompatibilityCase,
  WorkflowCompatibilityDiff,
  WorkflowCompatibilityReport,
  WorkflowExecutorResult,
} from './types.js'

export type WorkflowCompatibilityExecutor = (
  testCase: WorkflowCompatibilityCase,
  attempt: number,
) => Promise<WorkflowExecutorResult>

function score(diffs: WorkflowCompatibilityDiff[]): number {
  if (diffs.length === 0) return 100
  const same = diffs.filter(diff => diff.status === 'same').length
  return Math.round((same / diffs.length) * 100)
}

async function compareAttempt({
  testCase,
  officialExecutor,
  localExecutor,
  attempt,
  rerunCount,
}: {
  testCase: WorkflowCompatibilityCase
  officialExecutor: WorkflowCompatibilityExecutor
  localExecutor: WorkflowCompatibilityExecutor
  attempt: number
  rerunCount: number
}): Promise<WorkflowCompatibilityDiff> {
  const official = await officialExecutor(testCase, attempt)
  const local = await localExecutor(testCase, attempt)
  const officialNormalized = normalizeWorkflowExecutorResult(official, { files: [], metadata: {} })
  const localNormalized = normalizeWorkflowExecutorResult(local, { files: [], metadata: {} })

  return compareNormalizedWorkflowResults({
    caseId: testCase.id,
    official: officialNormalized,
    local: localNormalized,
    officialArtifacts: official.artifacts,
    localArtifacts: local.artifacts,
    rerunCount,
  })
}

export async function runWorkflowCompatibilityCases({
  cases,
  outputRoot,
  force,
  officialExecutor,
  localExecutor,
}: {
  cases: WorkflowCompatibilityCase[]
  outputRoot: string
  force: boolean
  officialExecutor: WorkflowCompatibilityExecutor
  localExecutor: WorkflowCompatibilityExecutor
}): Promise<WorkflowCompatibilityReport> {
  await mkdir(outputRoot, { recursive: true })
  void force
  const diffs: WorkflowCompatibilityDiff[] = []

  for (const testCase of cases) {
    let diff = await compareAttempt({
      testCase,
      officialExecutor,
      localExecutor,
      attempt: 1,
      rerunCount: 0,
    })

    if (diff.status !== 'same') {
      for (let rerun = 1; rerun <= testCase.confirmation.rerunsOnDifference; rerun += 1) {
        diff = await compareAttempt({
          testCase,
          officialExecutor,
          localExecutor,
          attempt: rerun + 1,
          rerunCount: rerun,
        })
      }
    }

    diffs.push(diff)
  }

  const report: WorkflowCompatibilityReport = {
    generatedAt: new Date().toISOString(),
    officialBinary: '/opt/homebrew/bin/claude',
    totalCases: cases.length,
    completedCases: diffs.length,
    score: score(diffs),
    diffs,
  }

  await writeFile(join(outputRoot, 'workflow-compatibility-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(outputRoot, 'workflow-compatibility-evidence.md'), renderEvidenceMatrixMarkdown(report))
  await writeFile(join(outputRoot, 'workflow-compatibility-development-guide.md'), renderDevelopmentGuideMarkdown(report))

  return report
}
```

- [ ] **Step 4: Run runner test and verify it passes**

Run:

```bash
node --import tsx/esm src/tools/WorkflowTool/compatibility/runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create the CLI runner script**

Create `scripts/workflow-binary-compatibility-runner.mjs`:

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const bundlePath = resolve(projectRoot, 'dist', 'workflowBinaryCompatibilityRunner.mjs')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-binary-compatibility')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'

await mkdir(dirname(bundlePath), { recursive: true })
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/tools/WorkflowTool/compatibility/runnerCli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
})

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}

const { main } = await import(pathToFileURL(bundlePath).href)
await main({
  projectRoot,
  outputRoot,
  officialBinary,
  args: process.argv.slice(2),
})

const reportPath = join(outputRoot, 'workflow-compatibility-report.json')
const report = JSON.parse(await readFile(reportPath, 'utf8'))
console.log(`workflow compatibility cases: ${report.completedCases}/${report.totalCases}`)
console.log(`workflow compatibility score: ${report.score}`)
console.log(`workflow compatibility output: ${outputRoot}`)
```

- [ ] **Step 6: Add runner CLI module used by the script**

Create `src/tools/WorkflowTool/compatibility/runnerCli.ts`:

```ts
import { createCaseWorkspace, writeExecutorArtifacts } from './artifacts.js'
import { getWorkflowCompatibilityCases } from './caseMatrix.js'
import {
  buildLocalExecutionPlan,
  buildOfficialExecutionPlan,
} from './executors.js'
import { runCommand } from './runCommand.js'
import { runWorkflowCompatibilityCases } from './runner.js'
import type {
  WorkflowCompatibilityCase,
  WorkflowExecutorName,
  WorkflowExecutorResult,
} from './types.js'

function selectedCases(cases: WorkflowCompatibilityCase[], args: string[]): WorkflowCompatibilityCase[] {
  const categoryArg = args.find(arg => arg.startsWith('--category='))
  const caseArg = args.find(arg => arg.startsWith('--case='))
  const limitArg = args.find(arg => arg.startsWith('--limit='))
  let selected = cases
  if (categoryArg) {
    const category = categoryArg.slice('--category='.length)
    selected = selected.filter(testCase => testCase.category === category)
  }
  if (caseArg) {
    const id = caseArg.slice('--case='.length)
    selected = selected.filter(testCase => testCase.id === id)
  }
  if (limitArg) {
    selected = selected.slice(0, Number(limitArg.slice('--limit='.length)))
  }
  return selected
}

async function executeCase({
  testCase,
  executor,
  attempt,
  projectRoot,
  outputRoot,
  officialBinary,
}: {
  testCase: WorkflowCompatibilityCase
  executor: WorkflowExecutorName
  attempt: number
  projectRoot: string
  outputRoot: string
  officialBinary: string
}): Promise<WorkflowExecutorResult> {
  const workspacePath = await createCaseWorkspace({
    outputRoot,
    caseId: testCase.id,
    executor,
    attempt,
    fixtureFiles: testCase.fixtureFiles,
  })

  const plan =
    executor === 'official'
      ? buildOfficialExecutionPlan({ testCase, workspacePath, officialBinary })
      : buildLocalExecutionPlan({ testCase, workspacePath, projectRoot })

  const commandResult = await runCommand({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    timeoutMs: testCase.timeoutMs,
    maxOutputBytes: testCase.maxOutputBytes,
  })

  const artifacts = await writeExecutorArtifacts({
    workspacePath,
    caseId: testCase.id,
    executor,
    attempt,
    command: [plan.command, ...plan.args],
    env: plan.env,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    metadata: {
      exitCode: commandResult.exitCode,
      signal: commandResult.signal,
      durationMs: commandResult.durationMs,
      timedOut: commandResult.timedOut,
    },
  })

  return { ...commandResult, artifacts }
}

export async function main({
  projectRoot,
  outputRoot,
  officialBinary,
  args,
}: {
  projectRoot: string
  outputRoot: string
  officialBinary: string
  args: string[]
}): Promise<void> {
  const cases = selectedCases(getWorkflowCompatibilityCases(), args)
  await runWorkflowCompatibilityCases({
    cases,
    outputRoot,
    force: args.includes('--force'),
    officialExecutor: (testCase, attempt) =>
      executeCase({ testCase, executor: 'official', attempt, projectRoot, outputRoot, officialBinary }),
    localExecutor: (testCase, attempt) =>
      executeCase({ testCase, executor: 'local', attempt, projectRoot, outputRoot, officialBinary }),
  })
}
```

- [ ] **Step 7: Add package script**

Modify `package.json` scripts by adding:

```json
"workflow:binary-compat": "node ./scripts/workflow-binary-compatibility-runner.mjs"
```

- [ ] **Step 8: Add runner tests to workflow test script**

Modify `scripts/run-workflow-tests.mjs` by adding:

```js
'src/tools/WorkflowTool/compatibility/runner.test.ts',
```

- [ ] **Step 9: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 10: Run a one-case compatibility smoke**

Run:

```bash
npm run build
npm run workflow:binary-compat -- --case=EXP-001 --force
```

Expected: command completes, writes `.claude/workflow-binary-compatibility/workflow-compatibility-report.json`, and prints completed case count.

- [ ] **Step 11: Commit**

```bash
git add package.json scripts/run-workflow-tests.mjs scripts/workflow-binary-compatibility-runner.mjs src/tools/WorkflowTool/compatibility/runner.ts src/tools/WorkflowTool/compatibility/runner.test.ts src/tools/WorkflowTool/compatibility/runnerCli.ts
git commit -m "feat: add workflow binary compatibility runner"
```

---

### Task 8: Add run documentation and execute the first full matrix

**Files:**
- Create: `docs/workflows/compatibility/README.md`
- Generated: `.claude/workflow-binary-compatibility/workflow-compatibility-report.json`
- Generated: `.claude/workflow-binary-compatibility/workflow-compatibility-evidence.md`
- Generated: `.claude/workflow-binary-compatibility/workflow-compatibility-development-guide.md`

- [ ] **Step 1: Write usage documentation**

Create `docs/workflows/compatibility/README.md`:

```md
# Workflow Binary Compatibility

This directory documents how to compare this repository's workflow implementation against the currently installed official Claude Code binary at `/opt/homebrew/bin/claude`.

## Run a smoke case

```bash
npm run build
npm run workflow:binary-compat -- --case=EXP-001 --force
```

## Run a category

```bash
npm run build
npm run workflow:binary-compat -- --category=args --force
```

## Run the full matrix

```bash
npm run build
npm run workflow:binary-compat -- --force
```

## Outputs

The runner writes outputs under:

```text
.claude/workflow-binary-compatibility/
```

Important files:

- `workflow-compatibility-report.json` — machine-readable comparison summary.
- `workflow-compatibility-evidence.md` — per-case evidence matrix with artifact links.
- `workflow-compatibility-development-guide.md` — source-area grouped development guide.
- `<CASE>/<official|local>/attempt-N/` — raw stdout, stderr, metadata, workspace files, and manifests.

## Difference confirmation

Every case runs once. If official and local behavior differs, the runner reruns that case two more times. Persistent differences are marked confirmed. Variable model-output differences should be reviewed through the raw artifacts before becoming implementation work.

## Compatibility target

The target is 90% practical execution compatibility with the installed official binary, not byte-for-byte text equality.
```

- [ ] **Step 2: Run workflow tests**

Run:

```bash
node ./scripts/run-workflow-tests.mjs
```

Expected: PASS.

- [ ] **Step 3: Run the first full matrix**

Run:

```bash
npm run build
npm run workflow:binary-compat -- --force
```

Expected: completes all 160 cases or stops on an explicit command/runtime error that is preserved in `.claude/workflow-binary-compatibility/`.

- [ ] **Step 4: Inspect generated report summary**

Run:

```bash
node -e "const r=require('./.claude/workflow-binary-compatibility/workflow-compatibility-report.json'); console.log({total:r.totalCases, completed:r.completedCases, score:r.score, diffs:r.diffs.filter(d=>d.status!=='same').length})"
```

Expected: prints total, completed, score, and non-matching diff count.

- [ ] **Step 5: Commit tracked documentation and source changes**

```bash
git add docs/workflows/compatibility/README.md
git commit -m "docs: document workflow binary compatibility runner"
```

Generated `.claude/workflow-binary-compatibility/` artifacts remain uncommitted unless the repository intentionally tracks benchmark output.
