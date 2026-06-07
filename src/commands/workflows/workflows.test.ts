import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { call } from './workflows.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflows-command-test-'))
await mkdir(join(tempRoot, 'docs', 'workflows'), { recursive: true })

await writeFile(
  join(tempRoot, 'docs', 'workflows', 'research.json'),
  JSON.stringify({
    name: 'Research Workflow',
    description: 'Research a topic with cross-checking.',
    defaults: {
      maxConcurrency: 2,
      maxAgents: 4,
      permissionMode: 'plan',
    },
    phases: [
      {
        id: 'research',
        description: 'Research the requested topic.',
        prompt: 'Research the topic from one angle.',
        fanout: 2,
        concurrency: 2,
      },
      {
        id: 'synthesis',
        description: 'Synthesize verified findings.',
        prompt: 'Synthesize only verified claims.',
        dependsOn: ['research'],
        review: 'synthesis',
      },
    ],
  }),
)

await writeFile(
  join(tempRoot, 'docs', 'workflows', 'js-run.js'),
  `
export default workflow({
  name: 'JS Run Workflow',
  description: 'Run a JavaScript workflow command with args.',
  phases: [
    agent({
      id: 'run',
      description: 'Run command args.',
      prompt: ({ args }) => 'Command run args: ' + args,
    }),
  ],
})
`,
)

await writeFile(
  join(tempRoot, 'docs', 'workflows', 'bad.json'),
  JSON.stringify({
    name: 'bad-workflow',
    description: 'Invalid fixture.',
    phases: [],
  }),
)

const workflowTask = {
  id: 'w-test',
  type: 'local_workflow' as const,
  status: 'running' as const,
  description: 'Workflow: Research Workflow',
  workflowName: 'Research Workflow',
  agentCount: 3,
  tokenCount: 9,
  toolUseCount: 2,
  startTime: Date.now(),
  outputFile: '.claude/tasks/w-test.output',
  outputOffset: 0,
  notified: false,
  phases: [
    {
      id: 'research',
      status: 'completed' as const,
      agentIds: ['a1', 'a2'],
      completedAgentIds: ['a1', 'a2'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
    {
      id: 'synthesis',
      status: 'running' as const,
      agentIds: ['a3'],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
  results: [],
  events: [
    {
      type: 'workflow_progress' as const,
      workflowRunId: 'wf_test_detail',
      status: 'running' as const,
      completedAgents: 2,
      totalAgents: 3,
    },
  ],
}

let commandState = { tasks: { 'w-test': workflowTask } }
const context = {
  getCwd: () => tempRoot,
  getAppState: () => commandState,
  setAppState: updater => {
    commandState = updater(commandState as never) as never
  },
} as never

const defaultResult = await call('', context)
assert.equal(defaultResult.type, 'text')
assert.equal(defaultResult.value, 'Dynamic workflows\n\nNo dynamic workflows in this session.\n\nEsc to close')

const listResult = await call('list', context)
assert.equal(listResult.type, 'text')
assert.match(listResult.value, /Research-Workflow/)
assert.match(listResult.value, /Invalid workflow specs/)
assert.match(listResult.value, /bad\.json/)

const showResult = await call('show Research Workflow', context)
assert.equal(showResult.type, 'text')
assert.match(showResult.value, /Workflow: Research-Workflow/)
assert.match(showResult.value, /Source:/)
assert.match(showResult.value, /research -> synthesis/)

const dryRunResult = await call('dry-run Research-Workflow', context)
assert.equal(dryRunResult.type, 'text')
assert.match(dryRunResult.value, /Planned agents: 3/)
assert.match(dryRunResult.value, /permissionMode: plan/)

const runResult = await call('run Research Workflow -- topic: agents', context)
assert.equal(runResult.type, 'text')
assert.match(runResult.value, /Execute workflow: Research Workflow/)
assert.match(runResult.value, /User input:\ntopic: agents/)
assert.match(runResult.value, /Use the WorkflowTool action "run"/)
assert.match(runResult.value, /Workflow plan JSON:/)

const jsRunResult = await call('run JS Run Workflow -- topic: JS command', context)
assert.equal(jsRunResult.type, 'text')
assert.match(jsRunResult.value, /Execute workflow: JS Run Workflow/)
assert.match(jsRunResult.value, /Command run args: topic: JS command/)

const saveTemplateResult = await call('save-template daily-research Research Workflow -- topic: saved agents', context)
assert.equal(saveTemplateResult.type, 'text')
assert.match(saveTemplateResult.value, /Saved workflow run template: daily-research/)
const templateFile = JSON.parse(await readFile(join(tempRoot, '.claude', 'workflow-run-templates.json'), 'utf8'))
assert.deepEqual(templateFile.templates[0], {
  name: 'daily-research',
  selector: 'Research Workflow',
  runArgs: 'topic: saved agents',
})

const templatesResult = await call('templates', context)
assert.equal(templatesResult.type, 'text')
assert.match(templatesResult.value, /daily-research: Research Workflow/)
assert.match(templatesResult.value, /topic: saved agents/)

const runTemplateResult = await call('run-template daily-research', context)
assert.equal(runTemplateResult.type, 'text')
assert.match(runTemplateResult.value, /Execute workflow: Research Workflow/)
assert.match(runTemplateResult.value, /User input:\ntopic: saved agents/)

const statusResult = await call('status w-test', context)
assert.equal(statusResult.type, 'text')
assert.match(statusResult.value, /Workflow: Research Workflow/)
assert.match(statusResult.value, /Status: running/)
assert.match(statusResult.value, /Agents: 2\/3/)
assert.match(statusResult.value, /Tokens: 9/)
assert.match(statusResult.value, /Tool uses: 2/)
assert.match(statusResult.value, /research: completed 2\/2/)
assert.match(statusResult.value, /synthesis: running 0\/1/)

const pauseResult = await call('pause w-test', context)
assert.equal(pauseResult.type, 'text')
assert.match(pauseResult.value, /Status: pending/)

const resumeResult = await call('resume w-test', context)
assert.equal(resumeResult.type, 'text')
assert.match(resumeResult.value, /Status: running/)

const detailResult = await call('detail w-test', context)
assert.equal(detailResult.type, 'text')
assert.match(detailResult.value, /Workflow detail/)
assert.match(detailResult.value, /Events:/)
assert.match(detailResult.value, /workflow_progress/)
assert.match(detailResult.value, /Controls:/)
assert.match(detailResult.value, /\/workflows pause w-test/)
assert.match(detailResult.value, /\/workflows resume w-test/)
assert.match(detailResult.value, /\/workflows retry-agent w-test <phase-id> <agent-id>/)
assert.match(detailResult.value, /\/workflows skip-agent w-test <phase-id> <agent-id>/)

const skipResult = await call('skip-agent w-test synthesis a3', context)
assert.equal(skipResult.type, 'text')
assert.match(skipResult.value, /synthesis: completed 1\/1 \[██████████\] skipped 1\/1/)

const retryResult = await call('retry-agent w-test synthesis a3', context)
assert.equal(retryResult.type, 'text')
assert.match(retryResult.value, /synthesis: running 0\/1/)

console.log('workflows.test.ts passed')
