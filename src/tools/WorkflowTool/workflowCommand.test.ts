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
  join(tempRoot, 'docs', 'workflows', 'meta-command.js'),
  `export const meta = {
    name: 'meta-command',
    description: 'detail probe',
    phases: [{ title: 'Scope', detail: 'Scope the question' }, { title: 'Verify' }],
  }
  phase('Scope')
  await agent('scope ' + args, { label: 'scope' })`,
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
assert.equal(commands.some(command => command.name === 'code-review'), false)
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
assert.equal(command.hasUserSpecifiedDescription, true)
assert.equal(command.allowedTools, undefined)

const prompt = await command.getPromptForCommand('topic: workflow testing', {} as never)
const text = prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.equal(
  text,
  'Run the "research-workflow" workflow.\n\n' +
    'Research a topic with cross-checking.\n\n' +
    'Phases:\n- research: Research the requested topic.\n- synthesis: Synthesize verified findings.\n\n' +
    'Invoke: Workflow({ name: "research-workflow", args: "topic: workflow testing" })\n\n' +
    'If the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.',
)
assert.equal(command.contentLength, text.length - ', args: "topic: workflow testing"'.length)

// Byte-identical to the prompt official 2.1.303 sends for a saved meta script (probe: remove-workflowtool/itx-variants.sh).
const metaCommand = commands.find(command => command.name === 'meta-command')!
assert.equal(metaCommand.type, 'prompt')
const metaText = (await metaCommand.getPromptForCommand('', {} as never)).map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.equal(
  metaText,
  'Run the "meta-command" workflow.\n\n' +
    'detail probe\n\n' +
    'Phases:\n- Scope: Scope the question\n- Verify\n\n' +
    'Invoke: Workflow({ name: "meta-command" })\n\n' +
    'If the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.',
)
const quotedMetaText = (await metaCommand.getPromptForCommand('"a b" c', {} as never)).map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.match(quotedMetaText, /Invoke: Workflow\(\{ name: "meta-command", args: "\\"a b\\" c" \}\)/)

// Official 2.1.310 slash prompt for the bundled deep-research workflow: whenToUse follows the
// description, and an empty /deep-research still hands the model the Workflow call.
const deepResearchCommand = commands.find(command => command.name === 'deep-research')!
assert.equal(deepResearchCommand.type, 'prompt')
assert.equal(deepResearchCommand.disableModelInvocation, true)
const emptyDeepResearchPrompt = await deepResearchCommand.getPromptForCommand('', {} as never)
const emptyDeepResearchText = emptyDeepResearchPrompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.equal(
  emptyDeepResearchText,
  'Run the "deep-research" workflow.\n\n' +
    'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.\n\n' +
    'When the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE invoking, check if the question is specific enough to research directly — if underspecified (e.g., "what car to buy" without budget/use-case/region), ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args, weaving the answers in.\n\n' +
    'Phases:\n' +
    '- Scope: Decompose question (from args) into 5 search angles\n' +
    '- Search: 5 parallel WebSearch agents, one per angle\n' +
    '- Fetch: URL-dedup, fetch top 15 sources, extract falsifiable claims\n' +
    '- Verify: 3-vote adversarial verification per claim (need 2/3 refutes to kill)\n' +
    '- Synthesize: Merge semantic dupes, rank by confidence, cite sources\n\n' +
    'Invoke: Workflow({ name: "deep-research" })\n\n' +
    'If the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.',
)

const jsCommand = commands.find(command => command.name === 'js-command-workflow')!
assert.equal(jsCommand.type, 'prompt')
const jsPrompt = await jsCommand.getPromptForCommand('topic: command args', {} as never)
const jsText = jsPrompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
assert.match(jsText, /Invoke: Workflow\(\{ name: "js-command-workflow", args: "topic: command args" \}\)/)
assert.match(jsText, /Phases:\n- inspect: Inspect command args\.\n\n/)
assert.doesNotMatch(jsText, /Command args:/)

console.log('workflowCommand.test.ts passed')
