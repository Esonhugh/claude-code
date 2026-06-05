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

console.log('workflowDsl.test.ts passed')
