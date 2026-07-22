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
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'official-run.js'),
  `export const meta = {
    name: 'official-run',
    description: 'Official run permission preview.',
    phases: [{ title: 'Scope', detail: 'Scope official args' }],
  }
  phase('Scope')
  await agent('official run ' + args, { label: 'scope' })`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'official-parallel.js'),
  `export const meta = {
    name: 'official-parallel',
    description: 'Group official parallel agents under the active phase.',
    phases: [
      { title: 'Fanout', detail: 'Run three agents together' },
      { title: 'After', detail: 'Run a follow-up agent' },
    ],
  }
  phase('Fanout')
  await parallel([
    () => agent('parallel a', { label: 'fanout-a' }),
    () => agent('parallel b', { label: 'fanout-b' }),
    () => agent('parallel c', { label: 'fanout-c' }),
  ])
  phase('After')
  await agent('parallel after', { label: 'after-agent' })`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'default-mode.js'),
  `export default workflow({
    name: 'Default Mode Workflow',
    description: 'Run a workflow without explicit permission defaults.',
    defaults: {
      maxConcurrency: 1,
      maxAgents: 1,
    },
    phases: [agent({
      id: 'run',
      description: 'Run with default mode.',
      prompt: () => 'default permission mode',
    })],
  })`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'empty-error.js'),
  `export const meta = {
    name: 'empty-error',
    description: 'Fail with an empty agent error.',
    phases: [{ title: 'Fail', detail: 'Fail without details' }],
  }
  phase('Fail')
  const result = await agent('empty error', { label: 'empty-error-agent' })
  if (result === null) throw new Error()`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'schema-valid.js'),
  `const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'value'],
    properties: { ok: { type: 'boolean' }, value: { type: 'string' } },
  }
  export const meta = {
    name: 'schema-valid',
    description: 'Accept validated structured output.',
    phases: [{ title: 'Structured', detail: 'Require structured output' }],
  }
  phase('Structured')
  const result = await agent('schema valid', { label: 'schema-valid-agent', schema: RESULT_SCHEMA })
  if (!result?.ok || result.value !== 'validated') throw new Error('schema result not returned')
  return result`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'schema-raw.js'),
  `const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'value'],
    properties: { ok: { type: 'boolean' }, value: { type: 'string' } },
  }
  export const meta = {
    name: 'schema-raw',
    description: 'Reject raw text fallback.',
    phases: [{ title: 'Structured', detail: 'Require structured output' }],
  }
  phase('Structured')
  const result = await agent('schema raw', { label: 'schema-raw-agent', schema: RESULT_SCHEMA })
  if (result !== null) throw new Error('raw text fallback used')
  throw new Error('schema raw rejected')`,
)
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'schema-invalid.js'),
  `const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'value'],
    properties: { ok: { type: 'boolean' }, value: { type: 'string' } },
  }
  export const meta = {
    name: 'schema-invalid',
    description: 'Reject invalid structured output.',
    phases: [{ title: 'Structured', detail: 'Require structured output' }],
  }
  phase('Structured')
  const result = await agent('schema invalid', { label: 'schema-invalid-agent', schema: RESULT_SCHEMA })
  if (result !== null) throw new Error('invalid structured output accepted')
  throw new Error('schema invalid rejected')`,
)

const context = { getCwd: () => tempRoot } as never

assert.equal(WorkflowTool.isEnabled(), true)
const workflowPrompt = await WorkflowTool.prompt()
assert.match(workflowPrompt, /Explicit opt-in requirement/)
assert.match(workflowPrompt, /Ultracode/)
assert.match(workflowPrompt, /Prefer WorkflowTool for broad, workflow-scale orchestration/)
assert.match(workflowPrompt, /For focused tasks, use direct tools or a small number of subagents/)
assert.match(workflowPrompt, /Do not run WorkflowTool when the user asks to avoid workflow orchestration/)
assert.doesNotMatch(workflowPrompt, /prefer this tool on every substantive task/)
assert.match(workflowPrompt, /export const meta = \{ name, description, phases \}/)
assert.match(workflowPrompt, /pure literal/i)
assert.match(workflowPrompt, /computed keys/i)
assert.match(workflowPrompt, /template interpolation/i)
assert.match(workflowPrompt, /__proto__/)
assert.match(workflowPrompt, /Date\.now\(\)|Math\.random\(\)/)
assert.match(workflowPrompt, /dynamic import/i)
assert.match(workflowPrompt, /pipeline\(\)/)
assert.match(workflowPrompt, /parallel\(thunks\)/)
assert.match(workflowPrompt, /not promises/i)
assert.match(workflowPrompt, /failed branches|\bnull\b/i)
assert.match(workflowPrompt, /hard cap/i)
assert.match(workflowPrompt, /agent\(\{ schema \}\)/)
assert.match(workflowPrompt, /Adversarial verify/i)
assert.match(workflowPrompt, /Loop-until-dry/i)
assert.match(workflowPrompt, /Do not manually perform phase work/i)
assert.doesNotMatch(workflowPrompt, /run `?\/workflow/i)
assert.doesNotMatch(workflowPrompt, /ask the user to run/i)
assert.equal(await WorkflowTool.description(), workflowPrompt)
assert.equal(WorkflowTool.isReadOnly({ action: 'dry-run', selector: 'Research Workflow' }), true)
assert.deepEqual(
  await WorkflowTool.checkPermissions({ action: 'dry-run', selector: 'Research Workflow' }, context),
  { behavior: 'allow', updatedInput: { action: 'dry-run', selector: 'Research Workflow' } },
)
const runPermissionPreview = await WorkflowTool.checkPermissions(
  { action: 'run', selector: 'official-run', runArgs: 'topic' },
  context,
)
assert.equal(runPermissionPreview.behavior, 'ask')
assert.equal(runPermissionPreview.message, 'Run a dynamic workflow?')
assert.equal(runPermissionPreview.updatedInput?.action, 'run')
assert.equal(runPermissionPreview.updatedInput?.selector, 'official-run')
assert.equal(runPermissionPreview.updatedInput?.runArgs, 'topic')
assert.match(runPermissionPreview.updatedInput?.script as string, /export const meta/)
assert.deepEqual(runPermissionPreview.updatedInput?.plan, {
  name: 'official-run',
  description: 'Official run permission preview.',
  phases: [{ title: 'Scope', detail: 'Scope official args', prompt: "'official run ' + args", displayName: 'scope' }],
  runScriptSnapshot: `export const meta = {
    name: 'official-run',
    description: 'Official run permission preview.',
    phases: [{ title: 'Scope', detail: 'Scope official args' }],
  }
  phase('Scope')
  await agent('official run ' + args, { label: 'scope' })`,
})

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
const launchedInputs: Array<{ prompt: string; mode?: string; hasStructuredOutputTool?: boolean }> = []
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
        async call(input: { prompt: string; mode?: string }, toolUseContext: ToolUseContext) {
          const hasStructuredOutputTool = toolUseContext.options.tools.some(tool => tool.name === 'StructuredOutput')
          launchedPrompts.push(input.prompt)
          launchedInputs.push({ prompt: input.prompt, mode: input.mode, hasStructuredOutputTool })
          if (input.prompt === 'empty error') throw new Error()
          if (input.prompt.includes('schema valid')) {
            return {
              data: {
                status: 'completed' as const,
                content: [{ type: 'text' as const, text: 'used structured output' }],
                agentId: 'schema-agent-1' as AgentId,
                structured_output: { ok: true, value: 'validated' },
              },
            } as never
          }
          if (input.prompt.includes('schema raw')) {
            return {
              data: {
                status: 'completed' as const,
                content: [{ type: 'text' as const, text: '{"ok":true,"value":"raw"}' }],
                agentId: 'schema-agent-raw' as AgentId,
              },
            }
          }
          if (input.prompt.includes('schema invalid')) {
            return {
              data: {
                status: 'completed' as const,
                content: [{ type: 'text' as const, text: 'invalid structured output' }],
                agentId: 'schema-agent-invalid' as AgentId,
                structured_output: { ok: true, extra: 'nope' },
              },
            }
          }
          return {
            data: {
              status: 'completed' as const,
              content: [{ type: 'text' as const, text: 'js workflow completed with enough detail' }],
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
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

await assert.rejects(
  WorkflowTool.call(
    {
      action: 'run',
      plan: {
        name: 'display-only-preview',
        description: 'Preview plan without executable defaults.',
        phases: [{ title: 'Scope', detail: 'Display only' }],
      },
    } as never,
    runContext,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_invalid_direct_plan' } } as never,
  ),
  /Invalid executable workflow plan/,
)

const previewRunResult = await WorkflowTool.call(
  runPermissionPreview.updatedInput as never,
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_preview_run' } } as never,
)
assert.match(String(previewRunResult.data), /Workflow launched in background\. Task ID: w/)
assert.equal(launchedPrompts.length, 1)
assert.match(launchedPrompts[0]!, /official run topic/)
assert.equal(launchedInputs[0]?.mode, 'acceptEdits')

launchedPrompts.length = 0
launchedInputs.length = 0
const deepResearchPermissionPreview = await WorkflowTool.checkPermissions(
  { action: 'run', selector: 'deep-research', runArgs: '分析 claude 的 dynamic workflow 设计原理' },
  context,
)
assert.equal(deepResearchPermissionPreview.behavior, 'ask')
assert.equal(deepResearchPermissionPreview.updatedInput?.selector, 'deep-research')
assert.ok(deepResearchPermissionPreview.updatedInput?.plan)
const deepResearchRun = await WorkflowTool.call(
  deepResearchPermissionPreview.updatedInput as never,
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_deep_research_preview_run' } } as never,
)
assert.match(String(deepResearchRun.data), /Workflow launched in background\. Task ID: w/)
const deepResearchTask = Object.values(runState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'deep-research',
)!
assert.equal(deepResearchTask.status, 'completed')
assert.equal(deepResearchTask.defaultModel, 'claude-sonnet-4-5')
assert.equal(deepResearchTask.execution, 'agent')
assert.ok(launchedPrompts.length > 1)
assert.match(launchedPrompts[0]!, /Decompose this research question/)
assert.match(launchedPrompts[0]!, /User input:\n分析 claude 的 dynamic workflow 设计原理/)

await assert.rejects(
  () => WorkflowTool.call(
    { action: 'run', selector: 'deep-research', runArgs: '' },
    runContext,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_empty_deep_research_run' } } as never,
  ),
  /Workflow deep-research requires workflow input/,
)

launchedPrompts.length = 0
launchedInputs.length = 0
const runResult = await WorkflowTool.call(
  { action: 'run', selector: 'JS Run Workflow', runArgs: 'topic: DSL', resumeFromRunId: 'wf_prior_js' } as never,
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_js_run' } } as never,
)
assert.match(String(runResult.data), /Workflow launched in background\. Task ID: w/)
assert.match(String(runResult.data), /Run ID: wf_/)
assert.match(String(runResult.data), /To resume after editing the script: Workflow\({scriptPath: ".*js-run\.js", resumeFromRunId: "wf_[^"]+"}\) — completed agents return cached results\./)
assert.match(String(runResult.data), /Use \/workflows to watch live progress\./)
assert.equal(launchedPrompts.length, 1)
assert.match(launchedPrompts[0]!, /Use JS args: topic: DSL/)
assert.equal(launchedInputs[0]?.mode, 'plan')
assert.equal(launchedInputs[0]?.hasStructuredOutputTool, false)

const jsTask = Object.values(runState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'JS Run Workflow',
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
assert.match(runSession.workflowRunId, /^wf_/)
assert.equal(runSession.workflowName, 'JS Run Workflow')
assert.equal(runSession.status, 'completed')
assert.equal(runSession.runArgs, 'topic: DSL')
assert.equal(runSession.resumeFromRunId, 'wf_prior_js')
assert.equal(runSession.scriptPath, join(tempRoot, 'docs', 'workflows', 'js-run.js'))
assert.equal(runSession.runtime.kind, 'javascript-worker')
assert.equal(runSession.runtime.isolated, true)
assert.equal(runSession.sourcePath, join(tempRoot, 'docs', 'workflows', 'js-run.js'))
assert.match(runSession.runScriptSnapshot, /export default workflow/)
assert.deepEqual(
  [...new Set(runSession.events.map((event: { type: string }) => event.type))],
  ['workflow_progress', 'workflow_log', 'workflow_phase', 'workflow_agent'],
)
assert.equal(runSession.results.length, 1)

launchedPrompts.length = 0
launchedInputs.length = 0
const officialParallelRun = await WorkflowTool.call(
  { action: 'run', selector: 'official-parallel' },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_official_parallel_run' } } as never,
)
assert.match(String(officialParallelRun.data), /Workflow launched in background\. Task ID: w/)
const officialParallelTask = Object.values(runState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'official-parallel',
)!
assert.equal(officialParallelTask.agentCount, 4)
assert.deepEqual(
  officialParallelTask.phases.map(phase => [phase.id, phase.agentIds]),
  [
    ['Fanout', ['fanout-a', 'fanout-b', 'fanout-c']],
    ['After', ['after-agent']],
  ],
)
assert.equal(launchedPrompts.length, 4)

launchedInputs.length = 0
const defaultModeRun = await WorkflowTool.call(
  { action: 'run', selector: 'Default Mode Workflow' },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_default_mode_run' } } as never,
)
assert.match(String(defaultModeRun.data), /Workflow launched in background\. Task ID: w/)
assert.equal(launchedInputs[0]?.mode, 'acceptEdits')

const emptyErrorRun = await WorkflowTool.call(
  { action: 'run', selector: 'empty-error' },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_empty_error_run' } } as never,
)
assert.match(String(emptyErrorRun.data), /Workflow launched in background\. Task ID: w/)
const emptyErrorTask = Object.values(runState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'empty-error',
)!
const emptyErrorSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', `${emptyErrorTask.id}.json`), 'utf8'),
)
assert.equal(emptyErrorSession.status, 'failed')
assert.equal(emptyErrorSession.error, 'Workflow script failed without error details')

const pausableTaskId = 'w-pausable'
const pausableRunId = 'wf_pausable'
const pausableScriptPath = join(tempRoot, 'docs', 'workflows', 'js-run.js')
const pausableTask: LocalWorkflowTaskState = {
  id: pausableTaskId,
  type: 'local_workflow',
  status: 'running',
  description: 'Workflow: Pausable Workflow',
  startTime: Date.now(),
  outputFile: `.claude/tasks/${pausableTaskId}.output`,
  outputOffset: 0,
  notified: false,
  workflowName: 'Pausable Workflow',
  workflowRunId: pausableRunId,
  scriptPath: pausableScriptPath,
  runArgs: 'pause input',
  summary: 'Workflow running',
  agentCount: 1,
  progressVersion: 1,
  tokenCount: 0,
  toolUseCount: 0,
  execution: 'agent',
  phases: [
    {
      id: 'run',
      status: 'running',
      agentIds: ['agent-pause-1'],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
  results: [],
  events: [],
}
runState = {
  ...runState,
  tasks: {
    ...runState.tasks,
    [pausableTaskId]: pausableTask,
  },
}
await mkdir(join(tempRoot, '.claude', 'workflow-runs', pausableRunId), { recursive: true })
await writeFile(
  join(tempRoot, '.claude', 'workflow-runs', `${pausableTaskId}.json`),
  JSON.stringify({
    taskId: pausableTaskId,
    workflowRunId: pausableRunId,
    workflowName: 'Pausable Workflow',
    status: 'running',
    runArgs: 'pause input',
    scriptPath: pausableScriptPath,
    resumeCacheEntries: [],
    startedAt: 1,
    updatedAt: 1,
    results: [],
    events: [],
  }),
)
await writeFile(
  join(tempRoot, '.claude', 'workflow-runs', pausableRunId, 'session.json'),
  JSON.stringify({
    taskId: pausableTaskId,
    workflowRunId: pausableRunId,
    workflowName: 'Pausable Workflow',
    status: 'running',
    runArgs: 'pause input',
    scriptPath: pausableScriptPath,
    resumeCacheEntries: [],
    startedAt: 1,
    updatedAt: 1,
    results: [],
    events: [],
  }),
)

const pauseResult = await WorkflowTool.call(
  { action: 'pause', selector: pausableTaskId },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_pause' } } as never,
)
assert.match(String(pauseResult.data), /Status: pending/)
assert.match(String(pauseResult.data), /Child agents:/)
assert.match(
  String(pauseResult.data),
  /Some notifications may still arrive after pause; they are part of this workflow run\./,
)
const pausedSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', pausableRunId, 'session.json'), 'utf8'),
)
assert.equal(pausedSession.status, 'paused')
assert.match(pausedSession.resumePrompt, /Workflow\(\{scriptPath: ".*js-run\.js", resumeFromRunId: "wf_pausable"\}\)/)
assert.equal(pausedSession.events.at(-1)?.type, 'workflow_progress')
assert.equal(pausedSession.events.at(-1)?.status, 'paused')

const resumeResult = await WorkflowTool.call(
  { action: 'resume', selector: pausableTaskId },
  runContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_resume' } } as never,
)
assert.match(String(resumeResult.data), /Workflow\(\{scriptPath: ".*js-run\.js", resumeFromRunId: "wf_pausable"\}\)/)
assert.equal((runState.tasks[pausableTaskId] as LocalWorkflowTaskState).status, 'pending')

console.log('WorkflowTool.test.ts passed')
