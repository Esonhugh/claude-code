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
  { title: 'official binary version', prompt: 'Report the Claude Code version.', fixtureFiles: {}, mode: 'exact' },
  { title: 'official binary workflow strings', prompt: 'Export workflow-related binary strings.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official command help surface', prompt: 'Inspect workflow command help surface.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official default workflow visibility', prompt: 'List workflow surfaces with default environment.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official workflow env visibility', prompt: 'List workflow surfaces with workflow feature env enabled.', fixtureFiles: {}, mode: 'schema' },
  ...officialWorkflowNames.map(name => ({
    title: `official bundled workflow ${name}`,
    prompt: `Probe official bundled workflow ${name}.`,
    workflowName: name,
    fixtureFiles: {},
    mode: 'schema' as const,
  })),
  { title: 'unknown official workflow', prompt: 'Probe an unknown workflow name.', workflowName: 'unknown-workflow-probe', fixtureFiles: {}, mode: 'schema' },
  { title: 'official workflow metadata repeatability A', prompt: 'Export metadata first repeat.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official workflow metadata repeatability B', prompt: 'Export metadata second repeat.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official workflow status surface', prompt: 'Probe workflow status surface.', fixtureFiles: {}, mode: 'schema' },
  { title: 'official workflow persisted artifact surface', prompt: 'Probe persisted workflow artifacts.', fixtureFiles: {}, mode: 'schema' },
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
