import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverWorkflowSpecs, workflowNameToCommandName } from './workflowDiscovery.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-discovery-test-'))
const missingDiscovery = await discoverWorkflowSpecs(tempRoot)
assert.equal(missingDiscovery.valid.length, 0)
assert.equal(missingDiscovery.invalid.length, 0)

await writeFile(join(tempRoot, 'docs'), 'not a directory')
const invalidDiscovery = await discoverWorkflowSpecs(tempRoot)
assert.equal(invalidDiscovery.valid.length, 0)
assert.equal(invalidDiscovery.invalid.length, 1)
assert.match(invalidDiscovery.invalid[0]!.path, /docs\/workflows$/)

const repoRoot = await mkdtemp(join(tmpdir(), 'workflow-discovery-root-test-'))
await mkdir(join(repoRoot, 'docs', 'workflows'), { recursive: true })
await mkdir(join(repoRoot, 'packages', 'app'), { recursive: true })
await writeFile(join(repoRoot, '.git'), 'gitdir: test\n')
await writeFile(
  join(repoRoot, 'docs', 'workflows', 'root-workflow.json'),
  JSON.stringify({
    name: 'root-workflow',
    description: 'Workflow defined at repository root.',
    phases: [
      {
        id: 'inspect',
        description: 'Inspect from a nested cwd.',
        prompt: 'Inspect nested cwd behavior.',
      },
    ],
  }),
)

await writeFile(
  join(repoRoot, 'docs', 'workflows', 'js-workflow.js'),
  `
export default workflow({
  name: 'JS Workflow',
  description: 'Workflow defined with the JavaScript DSL.',
  defaults: {
    maxRetries: 1,
    execution: 'team',
  },
  phases: [
    agent({
      id: 'inspect',
      description: 'Inspect JS workflow input.',
      prompt: ({ args }) => args ? 'Inspect ' + args : 'Inspect default input.',
    }),
  ],
})
`,
)

const nestedDiscovery = await discoverWorkflowSpecs(join(repoRoot, 'packages', 'app'))
assert.equal(nestedDiscovery.valid.length, 2)
assert.equal(nestedDiscovery.valid[0]!.commandName, 'JS-Workflow')
assert.equal(nestedDiscovery.valid[0]!.plan.defaults.maxRetries, 1)
assert.equal(nestedDiscovery.valid[0]!.plan.defaults.execution, 'team')
assert.equal(nestedDiscovery.valid[0]!.plan.phases[0]!.prompt, 'Inspect default input.')
assert.equal(nestedDiscovery.valid[1]!.commandName, 'root-workflow')

assert.equal(workflowNameToCommandName('中文流程', '/tmp/deep-research.json'), 'deep-research')
assert.throws(
  () => workflowNameToCommandName('中文流程', '/tmp/中文流程.json'),
  /Cannot derive workflow command name/,
)

console.log('workflowDiscovery.test.ts passed')
