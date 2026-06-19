import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadWorkflowScriptSpec } from './workflowDsl.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-dsl-test-'))
await mkdir(join(tempRoot, 'docs', 'workflows'), { recursive: true })

const scriptPath = join(tempRoot, 'docs', 'workflows', 'js-research.js')
await writeFile(
  scriptPath,
  `
export default workflow({
  name: 'JS Research Workflow',
  description: 'Research using an official-style JavaScript workflow DSL.',
  defaults: {
    maxConcurrency: 2,
    maxAgents: 4,
    maxRetries: 1,
    permissionMode: 'plan',
    execution: 'team',
  },
  phases: [
    agent({
      id: 'research',
      description: 'Research the requested topic.',
      prompt: ({ args }) => 'Research topic: ' + args,
      fanout: 2,
      concurrency: 2,
    }),
    agent({
      id: 'synthesis',
      description: 'Synthesize verified findings.',
      prompt: 'Synthesize only verified claims.',
      dependsOn: ['research'],
      review: 'synthesis',
    }),
  ],
})
`,
)

const spec = await loadWorkflowScriptSpec(scriptPath, 'workflow DSL')
assert.equal(spec.name, 'JS Research Workflow')
assert.equal(spec.defaults?.execution, 'team')
assert.equal(spec.defaults?.maxRetries, 1)
assert.equal(spec.phases.length, 2)
assert.equal(spec.phases[0]!.prompt, 'Research topic: workflow DSL')
assert.deepEqual(spec.phases[1]!.dependsOn, ['research'])
assert.deepEqual(spec.runtime, {
  kind: 'javascript-worker',
  sourcePath: scriptPath,
  isolated: true,
})

const isolationPath = join(tempRoot, 'docs', 'workflows', 'js-isolation.js')
await writeFile(
  isolationPath,
  `
export default workflow({
  name: 'JS Isolation Workflow',
  description: 'Verify the workflow script cannot access Node globals.',
  phases: [
    agent({
      id: 'isolate',
      description: 'Check sandbox globals.',
      prompt: 'process=' + typeof process + ',require=' + typeof require,
    }),
  ],
})
`,
)
const isolatedSpec = await loadWorkflowScriptSpec(isolationPath)
assert.equal(isolatedSpec.phases[0]!.prompt, 'process=undefined,require=undefined')
assert.equal(isolatedSpec.runtime?.kind, 'javascript-worker')

const datePath = join(tempRoot, 'docs', 'workflows', 'js-date.js')
await writeFile(
  datePath,
  `
export default workflow({
  name: 'JS Date Workflow',
  description: 'Date APIs break resumable workflow scripts.',
  phases: [
    agent({
      id: 'date',
      description: 'Use Date.now.',
      prompt: 'now=' + Date.now(),
    }),
  ],
})
`,
)
await assert.rejects(
  () => loadWorkflowScriptSpec(datePath),
  /Date\.now\(\) \/ new Date\(\) are unavailable in workflow scripts/,
)

const randomPath = join(tempRoot, 'docs', 'workflows', 'js-random.js')
await writeFile(
  randomPath,
  `
export default workflow({
  name: 'JS Random Workflow',
  description: 'Random APIs break resumable workflow scripts.',
  phases: [
    agent({
      id: 'random',
      description: 'Use Math.random.',
      prompt: 'random=' + Math.random(),
    }),
  ],
})
`,
)
await assert.rejects(
  () => loadWorkflowScriptSpec(randomPath),
  /Math\.random\(\) is unavailable in workflow scripts/,
)

const objectArgsPath = join(tempRoot, 'docs', 'workflows', 'js-object-args.js')
await writeFile(
  objectArgsPath,
  `
export default workflow({
  name: 'JS Object Args Workflow',
  description: 'Use structured workflow args.',
  phases: [
    agent({
      id: 'inspect',
      description: 'Inspect object args.',
      prompt: ({ args }) => 'topic=' + args.topic + '; depth=' + args.options.depth,
    }),
  ],
})
`,
)
const objectArgsSpec = await loadWorkflowScriptSpec(objectArgsPath, {
  topic: 'official workflows',
  options: { depth: 3 },
})
assert.equal(
  objectArgsSpec.phases[0]!.prompt,
  'topic=official workflows; depth=3',
)

const mathPath = join(tempRoot, 'docs', 'workflows', 'js-math.js')
await writeFile(
  mathPath,
  `
export default workflow({
  name: 'JS Math Workflow',
  description: 'Use deterministic Math helpers.',
  phases: [
    agent({
      id: 'math',
      description: 'Use Math.max.',
      prompt: 'max=' + Math.max(1, 2, 3),
    }),
  ],
})
`,
)
const mathSpec = await loadWorkflowScriptSpec(mathPath)
assert.equal(mathSpec.phases[0]!.prompt, 'max=3')

const orchestrationPath = join(tempRoot, 'docs', 'workflows', 'js-orchestration.js')
await writeFile(
  orchestrationPath,
  `
export default async function main() {
  const outputs = await parallel([
    agent({ label: 'research-a', prompt: 'Research A' }),
    agent({ label: 'research-b', prompt: 'Research B' }),
  ])
  await review({
    label: 'review',
    prompt: 'Review ' + outputs.map(item => item.output).join(','),
    dependsOn: outputs.map(item => item.label),
  })
}
`,
)
const orchestrationSpec = await loadWorkflowScriptSpec(orchestrationPath, {
  topic: 'official',
})
assert.deepEqual(orchestrationSpec.phases.map(phase => phase.id), [
  'research-a',
  'research-b',
  'review',
])
assert.equal(orchestrationSpec.phases[2]!.review, 'cross-check')
assert.equal(orchestrationSpec.runtime?.kind, 'javascript-worker')

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
assert.equal(officialSpec.phases[0]?.id, 'Scan')
assert.equal(officialSpec.phases[0]?.prompt, 'Find files for runtime')
assert.deepEqual(officialSpec.phases[0]?.agentLabels, ['scan'])
assert.deepEqual(officialSpec.meta?.phases, [{ title: 'Scan', detail: 'Find files' }])
assert.equal(officialSpec.runtime?.kind, 'javascript-worker')

const officialModeVariantsPath = join(tempRoot, 'docs', 'workflows', 'official-mode-variants.js')
await writeFile(
  officialModeVariantsPath,
  `export const meta = {
    name: 'official-mode-variants',
    description: 'Official-style workflow with permission mode variants',
    phases: [{ title: 'Modes', detail: 'Run mode variants' }],
  }

  phase('Modes')
  await agent('bypass prompt', { label: 'bypass', mode: 'bypassPermissions' })
  await agent('dont ask prompt', { label: 'dont-ask', mode: 'dontAsk' })
  `,
)
const officialModeVariantsSpec = await loadWorkflowScriptSpec(officialModeVariantsPath)
assert.equal(officialModeVariantsSpec.phases[0]?.permissionMode, 'bypassPermissions')
assert.equal(officialModeVariantsSpec.phases[1]?.permissionMode, 'dontAsk')

const officialParallelPath = join(tempRoot, 'docs', 'workflows', 'official-parallel.js')
await writeFile(
  officialParallelPath,
  `export const meta = {
    name: 'official-parallel-workflow',
    description: 'Official-style workflow with grouped parallel agents',
    phases: [
      { title: 'Fanout', detail: 'Launch fanout agents' },
      { title: 'After', detail: 'Run after fanout' },
    ],
  }

  phase('Fanout')
  await parallel([1, 2, 3].map(i => () =>
    agent('fanout prompt ' + i, { label: 'fanout-' + i, phase: 'Fanout' })
  ))
  phase('After')
  await agent('after prompt', { label: 'after', phase: 'After' })
  `,
)

const officialParallelSpec = await loadWorkflowScriptSpec(officialParallelPath)
assert.equal(officialParallelSpec.phases.length, 2)
assert.equal(officialParallelSpec.phases[0]?.id, 'Fanout')
assert.equal(officialParallelSpec.phases[0]?.fanout, 3)
assert.equal(officialParallelSpec.phases[0]?.concurrency, 3)
assert.deepEqual(officialParallelSpec.phases[0]?.agentLabels, ['fanout-1', 'fanout-2', 'fanout-3'])
assert.deepEqual(officialParallelSpec.phases[0]?.agentPrompts, ['fanout prompt 1', 'fanout prompt 2', 'fanout prompt 3'])
assert.equal(officialParallelSpec.phases[1]?.id, 'After')
assert.deepEqual(officialParallelSpec.phases[1]?.dependsOn, ['Fanout'])
assert.deepEqual(officialParallelSpec.phases[1]?.agentLabels, ['after'])

const officialUrlPath = join(tempRoot, 'docs', 'workflows', 'official-url.js')
await writeFile(
  officialUrlPath,
  `export const meta = {
    name: 'official-url-workflow',
    description: 'Official-style workflow with URL normalization',
    phases: [{ title: 'Normalize', detail: 'Normalize source URL' }],
  }

  phase('Normalize')
  const host = new URL('https://www.example.com/path/').hostname.replace(/^www\\./, '')
  await agent('host=' + host, { label: 'normalize' })
  `,
)

const officialUrlSpec = await loadWorkflowScriptSpec(officialUrlPath)
assert.equal(officialUrlSpec.phases[0]?.prompt, 'host=example.com')

const childWorkflowPath = join(tempRoot, 'docs', 'workflows', 'official-child.js')
await writeFile(
  childWorkflowPath,
  `export const meta = {
    name: 'official-child-workflow',
    description: 'Official child workflow',
    phases: [{ title: 'Child', detail: 'Run child agent' }],
  }

  phase('Child')
  await agent('child topic=' + args.topic, { label: 'child-agent' })
  `,
)
const parentWorkflowPath = join(tempRoot, 'docs', 'workflows', 'official-parent.js')
await writeFile(
  parentWorkflowPath,
  `export const meta = {
    name: 'official-parent-workflow',
    description: 'Official parent workflow',
    phases: [{ title: 'Parent', detail: 'Run child workflow' }],
  }

  phase('Parent')
  await workflow('official-child-workflow')
  await agent('parent after child', { label: 'parent-agent' })
  `,
)
const parentWorkflowSpec = await loadWorkflowScriptSpec(parentWorkflowPath, { topic: 'nested' })
assert.deepEqual(parentWorkflowSpec.phases.map(phase => phase.id), ['Child', 'Parent'])
assert.equal(parentWorkflowSpec.phases[0]?.prompt, 'child topic=nested')
assert.deepEqual(parentWorkflowSpec.phases[0]?.agentLabels, ['child-agent'])
assert.equal(parentWorkflowSpec.phases[1]?.prompt, 'parent after child')
assert.deepEqual(parentWorkflowSpec.phases[1]?.agentLabels, ['parent-agent'])

const nestedChildPath = join(tempRoot, 'docs', 'workflows', 'official-nested-child.js')
await writeFile(
  nestedChildPath,
  `export const meta = {
    name: 'official-nested-child-workflow',
    description: 'Nested child workflow',
    phases: [{ title: 'Nested', detail: 'Attempt nested child' }],
  }

  await workflow('official-child-workflow')
  `,
)
const nestedParentPath = join(tempRoot, 'docs', 'workflows', 'official-nested-parent.js')
await writeFile(
  nestedParentPath,
  `export const meta = {
    name: 'official-nested-parent-workflow',
    description: 'Nested parent workflow',
    phases: [{ title: 'Parent', detail: 'Attempt nested child' }],
  }

  await workflow({ scriptPath: 'official-nested-child.js' })
  `,
)
await assert.rejects(
  () => loadWorkflowScriptSpec(nestedParentPath),
  /workflow\(\) cannot be called from within a child workflow/,
)

console.log('workflowDsl.test.ts passed')
