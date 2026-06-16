import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getWorkflowCommands } from './createWorkflowCommand.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-command-test-'))
await mkdir(join(tempRoot, 'docs', 'workflows'), { recursive: true })

await writeFile(
  join(tempRoot, 'docs', 'workflows', 'research.json'),
  JSON.stringify({
    name: 'research-workflow',
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
        agentType: 'researcher',
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
  join(tempRoot, 'docs', 'workflows', 'js-command.js'),
  `
export default workflow({
  name: 'js-command-workflow',
  description: 'Command workflow using JS args.',
  phases: [
    agent({
      id: 'inspect',
      description: 'Inspect command args.',
      prompt: ({ args }) => 'Command args: ' + args,
    }),
  ],
})
`,
)

await writeFile(
  join(tempRoot, 'docs', 'workflows', 'invalid.json'),
  JSON.stringify({
    name: 'invalid workflow',
    description: 'Invalid workflow should not prevent valid commands.',
    phases: [],
  }),
)

const commands = await getWorkflowCommands(tempRoot)
const projectCommands = commands.filter(command =>
  ['research-workflow', 'js-command-workflow'].includes(command.name),
)
assert.equal(projectCommands.length, 2)
assert.ok(commands.some(command => command.name === 'code-review'))
assert.ok(commands.some(command => command.name === 'deep-research'))
assert.equal(commands.some(command => command.name === 'investigate'), false)
assert.equal(commands.some(command => command.name === 'bugfix'), false)
assert.equal(commands.some(command => command.name === 'docs'), false)
assert.equal(commands.some(command => command.name === 'dashboard'), false)
assert.equal(commands.some(command => command.name === 'autopilot'), false)

const command = commands.find(command => command.name === 'research-workflow')!
assert.equal(command.type, 'prompt')
assert.equal(command.name, 'research-workflow')
assert.equal(command.kind, 'workflow')
assert.equal(command.description, 'Research a topic with cross-checking.')
assert.equal(command.allowedTools, undefined)

const prompt = await command.getPromptForCommand('topic: workflow testing', {} as never)
const text = prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.match(text, /Workflow: research-workflow/)
assert.match(text, /Planned agents: 3/)
assert.match(text, /User input:\s*topic: workflow testing/)
assert.match(text, /through the Agent tool/)
assert.match(text, /Do not bypass workflow phases/)
assert.doesNotMatch(text, /no hidden workflow runtime/)
assert.match(text, /WorkflowTool\.run/)
assert.match(text, /selector: "research-workflow"/)
assert.match(text, /Must use WorkflowTool\.run when it is available/)
assert.match(text, /Do not call WorkflowTool with only a plan copied from this prompt/)
assert.doesNotMatch(text, /Prefer WorkflowTool\.run/)
assert.match(text, /permissionMode: plan/)
assert.match(text, /Honor each phase permissionMode/)
assert.match(text, /mode "plan"/)
assert.match(text, /must not edit files/)
assert.match(text, /synthesis/)

const deepResearchCommand = commands.find(command => command.name === 'deep-research')!
const emptyDeepResearchPrompt = await deepResearchCommand.getPromptForCommand('', {} as never)
const emptyDeepResearchText = emptyDeepResearchPrompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.equal(emptyDeepResearchText, 'Usage: /deep-research <workflow input>')
assert.doesNotMatch(emptyDeepResearchText, /WorkflowTool\.run/)

const jsCommand = commands.find(command => command.name === 'js-command-workflow')!
assert.equal(jsCommand.type, 'prompt')
const jsPrompt = await jsCommand.getPromptForCommand('topic: command args', {} as never)
const jsText = jsPrompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.match(jsText, /Command args: topic: command args/)

console.log('workflowCommand.test.ts passed')
