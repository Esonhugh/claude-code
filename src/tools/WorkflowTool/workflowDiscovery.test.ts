import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverWorkflowSpecs, workflowNameToCommandName } from './workflowDiscovery.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-discovery-test-'))
const missingDiscovery = await discoverWorkflowSpecs(tempRoot)
assert.deepEqual(
  missingDiscovery.valid.map(workflow => workflow.commandName).sort(),
  ['code-review', 'deep-research'],
)
assert.equal(missingDiscovery.invalid.length, 0)

const looseCwd = await mkdtemp(join(tmpdir(), 'workflow-discovery-loose-cwd-'))
await mkdir(join(looseCwd, '.claude', 'workflows'), { recursive: true })
await writeFile(
  join(looseCwd, '.claude', 'workflows', 'loose-workflow.json'),
  JSON.stringify({
    name: 'loose-workflow',
    description: 'Workflow defined directly in a non-repo cwd.',
    phases: [
      {
        id: 'inspect',
        description: 'Inspect loose cwd workflow.',
        prompt: 'Inspect loose cwd workflow.',
      },
    ],
  }),
)
const looseDiscovery = await discoverWorkflowSpecs(looseCwd)
assert.equal(
  looseDiscovery.valid.some(workflow => workflow.commandName === 'loose-workflow'),
  true,
)

await writeFile(join(tempRoot, 'docs'), 'not a directory')
const invalidDiscovery = await discoverWorkflowSpecs(tempRoot)
assert.equal(invalidDiscovery.valid.length, 2)
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
const nestedProjectWorkflows = nestedDiscovery.valid.filter(workflow =>
  ['JS-Workflow', 'root-workflow'].includes(workflow.commandName),
)
assert.equal(nestedProjectWorkflows.length, 2)
assert.equal(nestedProjectWorkflows[0]!.commandName, 'JS-Workflow')
assert.equal(nestedProjectWorkflows[0]!.plan.defaults.maxRetries, 1)
assert.equal(nestedProjectWorkflows[0]!.plan.defaults.execution, 'team')
assert.equal(nestedProjectWorkflows[0]!.plan.phases[0]!.prompt, 'Inspect default input.')
assert.equal(nestedProjectWorkflows[1]!.commandName, 'root-workflow')

assert.equal(workflowNameToCommandName('中文流程', '/tmp/deep-research.json'), 'deep-research')
assert.throws(
  () => workflowNameToCommandName('中文流程', '/tmp/中文流程.json'),
  /Cannot derive workflow command name/,
)

const precedenceRoot = await mkdtemp(join(tmpdir(), 'workflow-discovery-precedence-'))
const precedenceHome = await mkdtemp(join(tmpdir(), 'workflow-discovery-home-'))
await mkdir(join(precedenceRoot, '.claude', 'workflows'), { recursive: true })
await mkdir(join(precedenceHome, '.claude', 'workflows'), { recursive: true })
await writeFile(join(precedenceRoot, 'package.json'), '{}')
await writeFile(
  join(precedenceHome, '.claude', 'workflows', 'shadowed.json'),
  JSON.stringify({
    name: 'shadowed',
    description: 'User workflow',
    phases: [
      {
        id: 'user',
        description: 'User phase',
        prompt: 'user prompt',
      },
    ],
  }),
)
await writeFile(
  join(precedenceRoot, '.claude', 'workflows', 'shadowed.json'),
  JSON.stringify({
    name: 'shadowed',
    description: 'Project workflow',
    phases: [
      {
        id: 'project',
        description: 'Project phase',
        prompt: 'project prompt',
      },
    ],
  }),
)
await writeFile(
  join(precedenceHome, '.claude', 'workflows', 'user-only.json'),
  JSON.stringify({
    name: 'user-only',
    description: 'User only workflow',
    phases: [
      {
        id: 'user-only-phase',
        description: 'User only phase',
        prompt: 'user only prompt',
      },
    ],
  }),
)
const precedenceDiscovery = await discoverWorkflowSpecs(precedenceRoot, undefined, {
  home: precedenceHome,
})
const shadowedWorkflow = precedenceDiscovery.valid.find(
  workflow => workflow.commandName === 'shadowed',
)
const userOnlyWorkflow = precedenceDiscovery.valid.find(
  workflow => workflow.commandName === 'user-only',
)
assert.equal(shadowedWorkflow?.plan.description, 'Project workflow')
assert.match(shadowedWorkflow?.path ?? '', /\.claude\/workflows\/shadowed\.json$/)
assert.equal(userOnlyWorkflow?.plan.description, 'User only workflow')
assert.match(userOnlyWorkflow?.path ?? '', /\.claude\/workflows\/user-only\.json$/)
assert.equal(precedenceDiscovery.invalid.length, 0)

console.log('workflowDiscovery.test.ts passed')
