import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import { WorkflowTool } from './WorkflowTool.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-tool-test-'))
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
  description: 'Run a JavaScript workflow with args.',
  defaults: {
    maxConcurrency: 1,
    maxAgents: 1,
    permissionMode: 'plan',
  },
  phases: [
    agent({
      id: 'run',
      description: 'Run with user input.',
      prompt: ({ args }) => 'Use JS args: ' + args,
    }),
  ],
})
`,
)

const context = { getCwd: () => tempRoot } as never

assert.equal(WorkflowTool.isEnabled(), true)
assert.equal(WorkflowTool.isReadOnly({ action: 'dry-run', selector: 'Research Workflow' }), true)

const result = await WorkflowTool.call(
  { action: 'dry-run', selector: 'Research Workflow' },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_test' } } as never,
)

assert.match(String(result.data), /Workflow: Research Workflow/)
assert.match(String(result.data), /Planned agents: 3/)
assert.match(String(result.data), /permissionMode: plan/)

const jsDryRun = await WorkflowTool.call(
  { action: 'dry-run', selector: 'JS Run Workflow' },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_js_dry_run' } } as never,
)
assert.match(String(jsDryRun.data), /Runtime: javascript-worker/)
assert.match(String(jsDryRun.data), /Isolated runtime: yes/)
assert.match(String(jsDryRun.data), /Runtime source: .*js-run\.js/)

const block = WorkflowTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_test')
assert.equal(block.type, 'tool_result')
assert.equal(block.tool_use_id, 'toolu_test')
assert.match(String(block.content), /Workflow: Research Workflow/)

let runState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setRunState = (updater: (prev: AppState) => AppState): void => {
  runState = updater(runState)
}
const launchedPrompts: string[] = []
const runContext = {
  getCwd: () => tempRoot,
  getAppState: () => runState,
  setAppState: setRunState,
  options: {
    agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    tools: [
      {
        name: 'Agent',
        aliases: ['Task'],
        async call(input: { prompt: string }) {
          launchedPrompts.push(input.prompt)
          return {
            data: {
              status: 'completed' as const,
              content: [{ type: 'text' as const, text: 'js workflow done' }],
              agentId: 'js-agent-1' as AgentId,
            },
          }
        },
      },
    ],
    mcpClients: [],
    mcpResources: {},
    debug: false,
    verbose: false,
    thinkingConfig: {},
    isNonInteractiveSession: true,
    mainLoopModel: 'claude-sonnet-4-5',
  },
  abortController: new AbortController(),
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

const runResult = await WorkflowTool.call(
  { action: 'run', selector: 'JS Run Workflow', runArgs: 'topic: DSL' },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_js_run' } } as never,
)
assert.match(String(runResult.data), /Workflow completed: JS Run Workflow/)
assert.equal(launchedPrompts.length, 1)
assert.match(launchedPrompts[0]!, /Use JS args: topic: DSL/)
const jsTask = Object.values(runState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow',
)!
assert.deepEqual(jsTask.runtime, {
  kind: 'javascript-worker',
  sourcePath: join(tempRoot, 'docs', 'workflows', 'js-run.js'),
  isolated: true,
})
assert.equal(jsTask.sourcePath, join(tempRoot, 'docs', 'workflows', 'js-run.js'))
assert.match(jsTask.runScriptSnapshot ?? '', /export default workflow/)
const jsTaskId = String(runResult.data).match(/Task ID: (\S+)/)?.[1]
assert.ok(jsTaskId)
const jsStatus = await WorkflowTool.call(
  { action: 'status', selector: jsTaskId },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_js_status' } } as never,
)
assert.match(String(jsStatus.data), /Runtime: javascript-worker/)
assert.match(String(jsStatus.data), /Isolated runtime: yes/)
assert.match(String(jsStatus.data), /Runtime source: .*js-run\.js/)
const runSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', `${jsTaskId}.json`), 'utf8'),
)
assert.equal(runSession.taskId, jsTaskId)
assert.equal(runSession.workflowName, 'JS Run Workflow')
assert.equal(runSession.status, 'completed')
assert.equal(runSession.runArgs, 'topic: DSL')
assert.equal(runSession.runtime.kind, 'javascript-worker')
assert.equal(runSession.runtime.isolated, true)
assert.equal(runSession.sourcePath, join(tempRoot, 'docs', 'workflows', 'js-run.js'))
assert.match(runSession.runScriptSnapshot, /export default workflow/)
assert.equal(runSession.results.length, 1)

console.log('WorkflowTool.test.ts passed')
