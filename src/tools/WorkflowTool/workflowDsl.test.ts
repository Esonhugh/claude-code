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
assert.equal(officialSpec.phases[0]?.id, 'scan')
assert.equal(officialSpec.phases[0]?.prompt, 'Find files for runtime')
assert.deepEqual(officialSpec.meta?.phases, [{ title: 'Scan', detail: 'Find files' }])
assert.equal(officialSpec.runtime?.kind, 'javascript-worker')

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

console.log('workflowDsl.test.ts passed')
