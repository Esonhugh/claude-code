import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import { WorkflowFacadeTool, normalizeWorkflowFacadeInput } from './WorkflowFacadeTool.js'

const workflowFacadeSource = readFileSync(
  'src/tools/WorkflowTool/WorkflowFacadeTool.ts',
  'utf8',
)
assert.match(workflowFacadeSource, /workflow-scale orchestration/)
assert.match(workflowFacadeSource, /For focused tasks/)
assert.match(workflowFacadeSource, /do not call this tool/)
assert.match(workflowFacadeSource, /avoid workflow/)
assert.match(workflowFacadeSource, /must start with an uncommented/)
assert.match(workflowFacadeSource, /export const meta =/)
assert.match(workflowFacadeSource, /Phase entries must be objects with a string/)
assert.match(workflowFacadeSource, /Do not comment out the meta export/)
assert.match(workflowFacadeSource, /Pass the script inline via/)
assert.match(workflowFacadeSource, /selects a saved workflow/)
assert.doesNotMatch(workflowFacadeSource, /top-level.*name.*required separately from.*meta\.name/)
assert.doesNotMatch(workflowFacadeSource, /every substantive task/)

const inlineScript =
  'export default workflow({ name: "research", description: "Research", phases: [] })'
assert.deepEqual(
  normalizeWorkflowFacadeInput({ script: inlineScript }),
  {
    kind: 'inline-script',
    script: inlineScript,
    args: undefined,
    resumeFromRunId: undefined,
  },
)

assert.deepEqual(
  normalizeWorkflowFacadeInput({ name: 'research', script: inlineScript }),
  {
    kind: 'saved-workflow',
    selector: 'research',
    script: inlineScript,
    args: undefined,
    resumeFromRunId: undefined,
  },
)

assert.deepEqual(
  normalizeWorkflowFacadeInput({
    scriptPath: '/tmp/workflow.js',
    args: { topic: 'dsl' },
    resumeFromRunId: 'wf-123',
  }),
  {
    kind: 'script-path',
    scriptPath: '/tmp/workflow.js',
    args: { topic: 'dsl' },
    resumeFromRunId: 'wf-123',
  },
)

assert.deepEqual(
  normalizeWorkflowFacadeInput({
    scriptPath: '',
    name: 'official-compatible-research',
  }),
  {
    kind: 'saved-workflow',
    selector: 'official-compatible-research',
    args: undefined,
    resumeFromRunId: undefined,
  },
)

assert.deepEqual(normalizeWorkflowFacadeInput('official-compatible-research'), {
  kind: 'saved-workflow',
  selector: 'official-compatible-research',
  args: undefined,
  resumeFromRunId: undefined,
})

assert.deepEqual(
  normalizeWorkflowFacadeInput({
    name: 'official-compatible-research',
    description: 'ignored compatibility field',
    title: 'ignored compatibility title',
    resumeFromRunId: 'wf-saved',
  }),
  {
    kind: 'saved-workflow',
    selector: 'official-compatible-research',
    args: undefined,
    resumeFromRunId: 'wf-saved',
  },
)

assert.deepEqual(
  normalizeWorkflowFacadeInput({
    args: 'direct plan args',
    resumeFromRunId: 'wf-plan',
    plan: {
      name: 'direct-plan',
      description: 'Run a direct plan.',
      phases: [{ id: 'inspect', description: 'Inspect args.', prompt: 'inspect direct plan' }],
    },
  }),
  {
    kind: 'plan',
    args: 'direct plan args',
    resumeFromRunId: 'wf-plan',
    plan: {
      name: 'direct-plan',
      description: 'Run a direct plan.',
      phases: [{ id: 'inspect', description: 'Inspect args.', prompt: 'inspect direct plan' }],
    },
  },
)

assert.equal(WorkflowFacadeTool.name, 'Workflow')
assert.doesNotThrow(() => WorkflowFacadeTool.inputSchema.parse({
  name: 'research',
  description: 'ignored compatibility field',
  title: 'ignored compatibility title',
}))
assert.deepEqual(
  await WorkflowFacadeTool.checkPermissions(
    { scriptPath: '/tmp/workflow.js', args: 'topic' },
    {} as never,
  ),
  {
    behavior: 'ask',
    message: 'Run a dynamic workflow?',
    updatedInput: { scriptPath: '/tmp/workflow.js', args: 'topic' },
  },
)

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-facade-test-'))
await mkdir(join(tempRoot, '.claude', 'workflows'), { recursive: true })
const permissionScriptPath = join(tempRoot, 'permission-preview.js')
await writeFile(
  permissionScriptPath,
  `export const meta = {
    name: 'permission-preview',
    description: 'Preview permission phases.',
    phases: [{ title: 'Scope', detail: 'Scope topic' }],
  }
  phase('Scope')`,
)
const inlinePermissionScript = `export const meta = {
  name: 'inline-permission-preview',
  description: 'Preview inline permission phases.',
  phases: [{ title: 'Inline scope', detail: 'Scope inline topic' }],
}
phase('Inline scope')`
const inlinePermissionPreview = await WorkflowFacadeTool.checkPermissions(
  { script: inlinePermissionScript, args: 'inline topic' },
  { getCwd: () => tempRoot } as never,
)
assert.equal(inlinePermissionPreview.behavior, 'ask')
assert.equal(inlinePermissionPreview.updatedInput?.args, 'inline topic')
assert.deepEqual(inlinePermissionPreview.updatedInput?.plan, {
  name: 'inline-permission-preview',
  description: 'Preview inline permission phases.',
  phases: [{ title: 'Inline scope', detail: 'Scope inline topic' }],
  runScriptSnapshot: inlinePermissionScript,
})

const permissionPreview = await WorkflowFacadeTool.checkPermissions(
  {
    scriptPath: permissionScriptPath,
    script: `export const meta = {
      name: 'ignored-inline-override',
      description: 'Must not override scriptPath preview.',
      phases: [],
    }`,
    args: 'topic',
  },
  { getCwd: () => tempRoot } as never,
)
assert.equal(permissionPreview.behavior, 'ask')
assert.equal(permissionPreview.message, 'Run a dynamic workflow?')
assert.match(permissionPreview.updatedInput?.scriptPath as string, /permission-preview\.js$/)
assert.equal(permissionPreview.updatedInput?.args, 'topic')
assert.match(permissionPreview.updatedInput?.script as string, /export const meta/)
assert.deepEqual(permissionPreview.updatedInput?.plan, {
  name: 'permission-preview',
  description: 'Preview permission phases.',
  phases: [{ title: 'Scope', detail: 'Scope topic' }],
  runScriptSnapshot: `export const meta = {
    name: 'permission-preview',
    description: 'Preview permission phases.',
    phases: [{ title: 'Scope', detail: 'Scope topic' }],
  }
  phase('Scope')`,
})

await writeFile(
  join(tempRoot, '.claude', 'workflows', 'saved-preview.js'),
  `export const meta = {
    name: 'saved-preview',
    description: 'Saved workflow preview.',
    phases: [{ title: 'Scope', detail: 'Scope saved args' }],
  }
  phase('Scope')
  await agent('saved preview ' + args, { label: 'scope' })`,
)
const savedPermissionPreview = await WorkflowFacadeTool.checkPermissions(
  { name: 'saved-preview', args: 'saved topic' },
  { getCwd: () => tempRoot } as never,
)
assert.equal(savedPermissionPreview.behavior, 'ask')
assert.equal(savedPermissionPreview.message, 'Run a dynamic workflow?')
assert.equal(savedPermissionPreview.updatedInput?.name, 'saved-preview')
assert.equal(savedPermissionPreview.updatedInput?.args, 'saved topic')
assert.match(savedPermissionPreview.updatedInput?.script as string, /export const meta/)
assert.deepEqual(savedPermissionPreview.updatedInput?.plan, {
  name: 'saved-preview',
  description: 'Saved workflow preview.',
  phases: [{ title: 'Scope', detail: 'Scope saved args', prompt: "'saved preview ' + args", displayName: 'scope' }],
  runScriptSnapshot: `export const meta = {
    name: 'saved-preview',
    description: 'Saved workflow preview.',
    phases: [{ title: 'Scope', detail: 'Scope saved args' }],
  }
  phase('Scope')
  await agent('saved preview ' + args, { label: 'scope' })`,
})
const savedStringPermissionPreview = await WorkflowFacadeTool.checkPermissions(
  'saved-preview' as never,
  { getCwd: () => tempRoot } as never,
)
assert.equal(savedStringPermissionPreview.behavior, 'ask')
assert.equal(savedStringPermissionPreview.updatedInput?.name, 'saved-preview')
assert.deepEqual(savedStringPermissionPreview.updatedInput?.plan, savedPermissionPreview.updatedInput?.plan)
let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const launchedPrompts: string[] = []
const launchedAgents: Array<{ description: string; prompt: string; mode?: string; disableNestedAgentTools?: boolean }> = []
let hangNextAgent = false
const context = {
  getCwd: () => tempRoot,
  getAppState: () => state,
  setAppState: setState,
  options: {
    agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    tools: [
      {
        name: 'Agent',
        aliases: ['Task'],
        async call(input: { description: string; prompt: string; mode?: string }, agentContext: ToolUseContext) {
          launchedPrompts.push(input.prompt)
          launchedAgents.push({
            description: input.description,
            prompt: input.prompt,
            mode: input.mode,
            disableNestedAgentTools: agentContext.options.disableNestedAgentTools,
          })
          if (hangNextAgent) {
            hangNextAgent = false
            await new Promise((_, reject) => {
              agentContext.abortController.signal.addEventListener('abort', () => reject(new Error(String(agentContext.abortController.signal.reason))))
            })
          }
          return {
            data: {
              status: 'completed' as const,
              content: [{ type: 'text' as const, text: 'facade workflow done' }],
              agentId: 'facade-agent-1' as AgentId,
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
    workflowAgentStallMs: 20,
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

const directPlanRun = await WorkflowFacadeTool.call(
  {
    args: 'direct plan args',
    plan: {
      name: 'direct-plan',
      description: 'Run a direct plan.',
      phases: [{ id: 'inspect', description: 'Inspect args.', prompt: 'inspect direct plan' }],
    },
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_direct_plan' } } as never,
)
assert.match(String(directPlanRun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['inspect direct plan\n\nUser input:\ndirect plan args'])
assert.equal(launchedAgents[0]?.disableNestedAgentTools, true)
launchedPrompts.length = 0

hangNextAgent = true
const stalledRun = await WorkflowFacadeTool.call(
  {
    plan: {
      name: 'stalled-plan',
      description: 'Abort stalled plan agent.',
      defaults: { maxRetries: 0 },
      phases: [{ id: 'stall', description: 'Stall agent.', prompt: 'stall forever' }],
    },
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_stalled_plan' } } as never,
)
assert.match(String(stalledRun.data), /Workflow launched in background\. Task ID: w/)
const stalledTask = Object.values(state.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'stalled-plan',
)!
assert.equal(stalledTask.status, 'failed')
assert.equal(stalledTask.phases[0]?.failedAgentIds.includes('stalled-plan-stall-1'), true)
launchedPrompts.length = 0

const inlineRun = await WorkflowFacadeTool.call(
  {
    args: { topic: 'facade' },
    script: `export default workflow({
      name: 'Inline Research',
      description: 'Run an inline workflow script.',
      defaults: { maxConcurrency: 1, maxAgents: 1, permissionMode: 'plan' },
      phases: [agent({
        id: 'inspect',
        description: 'Inspect inline args.',
        prompt: ({ args }) => 'inline topic=' + args.topic,
      })],
    })`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_inline' } } as never,
)

assert.match(String(inlineRun.data), /Workflow launched in background\. Task ID: w/)
assert.match(String(inlineRun.data), /Run ID: wf_/)
assert.match(String(inlineRun.data), /Workflow\({scriptPath: ".*workflow\.js", resumeFromRunId: "wf_[^"]+"}\)/)
assert.deepEqual(launchedPrompts, ['inline topic=facade'])
const taskId = String(inlineRun.data).match(/Task ID: (\S+)/)?.[1]
const workflowRunId = String(inlineRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(taskId)
assert.ok(workflowRunId)
const session = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', workflowRunId, 'session.json'), 'utf8'),
)
assert.equal(session.taskId, taskId)
assert.equal(session.workflowRunId, workflowRunId)
assert.match(session.scriptPath, /workflow\.js$/)
assert.deepEqual(session.runArgs, { topic: 'facade' })

launchedPrompts.length = 0
const officialRun = await WorkflowFacadeTool.call(
  {
    args: { topic: 'meta' },
    script: `export const meta = {
      name: 'official-inline',
      description: 'Official inline workflow',
      phases: [{ title: 'Scan', detail: 'Scan topic' }],
    }
    phase('Scan')
    await agent('scan ' + args.topic, { label: 'scan' })`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_official_inline' } } as never,
)

assert.match(String(officialRun.data), /Workflow launched in background\. Task ID: w/)
assert.equal(launchedAgents.at(-1)?.disableNestedAgentTools, true)
const officialWorkflowRunId = String(officialRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(officialWorkflowRunId)
const officialSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', officialWorkflowRunId, 'session.json'), 'utf8'),
)
assert.deepEqual(officialSession.meta, {
  name: 'official-inline',
  description: 'Official inline workflow',
  phases: [{ title: 'Scan', detail: 'Scan topic' }],
})
assert.equal(officialSession.resumeCacheEntries.length, 1)
const officialInlineTask = Object.values(state.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'official-inline',
)!
assert.deepEqual(officialInlineTask.phases[0]?.agentIds, ['scan'])
assert.deepEqual(launchedPrompts, ['scan meta'])

launchedPrompts.length = 0
launchedAgents.length = 0
const defaultModeRun = await WorkflowFacadeTool.call(
  {
    args: { topic: 'mode' },
    script: `export const meta = {
      name: 'official-default-mode',
      description: 'Official default mode workflow',
      phases: [{ title: 'Mode', detail: 'Run default mode agent' }],
    }
    phase('Mode')
    await agent('default mode ' + args.topic, { label: 'default-mode', mode: 'default' })`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_default_mode' } } as never,
)
assert.match(String(defaultModeRun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['default mode mode'])
assert.equal(launchedAgents[0]?.mode, undefined)

await writeFile(
  join(tempRoot, '.claude', 'workflows', 'runtime-child.js'),
  `export const meta = {
    name: 'runtime-child',
    description: 'Runtime child workflow.',
    phases: [{ title: 'Child', detail: 'Run child agent' }],
  }
  phase('Child')
  await agent('child runtime ' + args.topic, { label: 'child-runtime' })`,
)
launchedPrompts.length = 0
const childWorkflowRun = await WorkflowFacadeTool.call(
  {
    args: { topic: 'child' },
    script: `export const meta = {
      name: 'official-child-parent',
      description: 'Official child parent workflow',
      phases: [{ title: 'Parent', detail: 'Run child workflow' }],
    }
    phase('Parent')
    await workflow('runtime-child')
    await agent('parent runtime ' + args.topic, { label: 'parent-runtime' })`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_child_workflow' } } as never,
)
assert.match(String(childWorkflowRun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['child runtime child', 'parent runtime child'])
const childWorkflowRunId = String(childWorkflowRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(childWorkflowRunId)
const childWorkflowSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', childWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(childWorkflowSession.resumeCacheEntries.length, 2)
const childParentTask = Object.values(state.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow' && task.workflowName === 'official-child-parent',
)!
assert.deepEqual(childParentTask.phases.map(phase => [phase.id, phase.agentIds]), [
  ['Child', ['child-runtime']],
  ['Parent', ['parent-runtime']],
])

const colocatedParentPath = join(tempRoot, 'docs', 'workflows', 'runtime-parent.js')
await mkdir(join(tempRoot, 'docs', 'workflows'), { recursive: true })
await writeFile(
  join(tempRoot, 'docs', 'workflows', 'runtime-child-local.js'),
  `export const meta = {
    name: 'runtime-child-local',
    description: 'Runtime colocated child workflow.',
    phases: [{ title: 'Local child', detail: 'Run colocated child agent' }],
  }
  phase('Local child')
  await agent('local child ' + args.topic, { label: 'local-child' })`,
)
await writeFile(
  colocatedParentPath,
  `export const meta = {
    name: 'runtime-parent-local',
    description: 'Runtime colocated parent workflow.',
    phases: [{ title: 'Parent', detail: 'Run colocated child workflow' }],
  }
  phase('Parent')
  await workflow({ scriptPath: './runtime-child-local.js' })`,
)
launchedPrompts.length = 0
const colocatedChildRun = await WorkflowFacadeTool.call(
  {
    scriptPath: colocatedParentPath,
    args: { topic: 'local' },
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_colocated_child' } } as never,
)
assert.match(String(colocatedChildRun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['local child local'])

await assert.rejects(
  WorkflowFacadeTool.call(
    {
      script: `export const meta = {
        name: 'official-empty-error',
        description: 'Official empty error workflow',
        phases: [{ title: 'Fail', detail: 'Fail without details' }],
      }
      phase('Fail')
      throw new Error()`,
    },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_facade_official_empty_error' } } as never,
  ),
  /Workflow script failed without error details/,
)

await writeFile(
  officialSession.scriptPath,
  `export const meta = {
    name: 'official-inline',
    description: 'Official inline workflow',
    phases: [{ title: 'Scan', detail: 'Scan topic' }],
  }
  phase('Scan')
  await agent('scan ' + args.topic, { label: 'scan', mode: 'default' })`,
)
launchedPrompts.length = 0
const cachedRerun = await WorkflowFacadeTool.call(
  {
    scriptPath: officialSession.scriptPath,
    args: { topic: 'meta' },
    resumeFromRunId: officialWorkflowRunId,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_cached_rerun' } } as never,
)

assert.match(String(cachedRerun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, [])
const cachedWorkflowRunId = String(cachedRerun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(cachedWorkflowRunId)
const cachedSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', cachedWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(cachedSession.resumeFromRunId, officialWorkflowRunId)
assert.equal(cachedSession.events.some((event: { type: string; cacheHit?: boolean }) => event.type === 'workflow_agent' && event.cacheHit), true)

await writeFile(
  join(tempRoot, '.claude', 'workflows', 'saved-cache.js'),
  `export const meta = {
    name: 'saved-cache',
    description: 'Saved workflow cache test',
    phases: [{ title: 'Saved', detail: 'Run saved cache agent' }],
  }
  phase('Saved')
  await agent('saved cache ' + args.topic, { label: 'saved-cache' })`,
)
launchedPrompts.length = 0
const savedCacheRun = await WorkflowFacadeTool.call(
  {
    name: 'saved-cache',
    args: { topic: 'meta' },
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_saved_cache' } } as never,
)
assert.match(String(savedCacheRun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['saved cache meta'])
const savedCacheWorkflowRunId = String(savedCacheRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(savedCacheWorkflowRunId)
const savedCacheSessionPath = join(tempRoot, '.claude', 'workflow-runs', savedCacheWorkflowRunId, 'session.json')
const savedCacheSession = JSON.parse(await readFile(savedCacheSessionPath, 'utf8'))
assert.ok(savedCacheSession.transcriptDir)
await writeFile(
  savedCacheSessionPath,
  `${JSON.stringify({ ...savedCacheSession, resumeCacheEntries: [] }, null, 2)}\n`,
)
launchedPrompts.length = 0
const savedCachedRerun = await WorkflowFacadeTool.call(
  {
    name: 'saved-cache',
    args: { topic: 'meta' },
    resumeFromRunId: savedCacheWorkflowRunId,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_saved_cached_rerun' } } as never,
)
assert.match(String(savedCachedRerun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, [])
const savedCachedWorkflowRunId = String(savedCachedRerun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(savedCachedWorkflowRunId)
const savedCachedSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', savedCachedWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(savedCachedSession.resumeFromRunId, savedCacheWorkflowRunId)
assert.equal(savedCachedSession.events.some((event: { type: string; cacheHit?: boolean }) => event.type === 'workflow_agent' && event.cacheHit), true)

await writeFile(
  officialSession.scriptPath,
  `export const meta = {
    name: 'official-inline',
    description: 'Official inline workflow',
    phases: [
      { title: 'Prep', detail: 'Prep topic' },
      { title: 'Scan', detail: 'Scan topic' },
    ],
  }
  phase('Prep')
  await agent('prep ' + args.topic, { label: 'prep' })
  phase('Scan')
  await agent('scan ' + args.topic, { label: 'scan' })`,
)
launchedPrompts.length = 0
const insertedStepRerun = await WorkflowFacadeTool.call(
  {
    scriptPath: officialSession.scriptPath,
    args: { topic: 'meta' },
    resumeFromRunId: officialWorkflowRunId,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_inserted_step_rerun' } } as never,
)
assert.match(String(insertedStepRerun.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(launchedPrompts, ['prep meta', 'scan meta'])
const insertedWorkflowRunId = String(insertedStepRerun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(insertedWorkflowRunId)
const insertedSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', insertedWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(insertedSession.events.filter((event: { type: string; cacheHit?: boolean }) => event.type === 'workflow_agent' && event.cacheHit).length, 0)

launchedPrompts.length = 0
const rerun = await WorkflowFacadeTool.call(
  {
    scriptPath: session.scriptPath,
    args: { topic: 'rerun' },
    resumeFromRunId: workflowRunId,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_rerun' } } as never,
)

assert.match(String(rerun.data), /Workflow launched in background\. Task ID: w/)
assert.match(String(rerun.data), /Workflow\({scriptPath: ".*workflow\.js", resumeFromRunId: "wf_[^"]+"}\)/)
assert.deepEqual(launchedPrompts, ['inline topic=rerun'])
const rerunWorkflowRunId = String(rerun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(rerunWorkflowRunId)
const rerunSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', rerunWorkflowRunId, 'session.json'), 'utf8'),
)
assert.equal(rerunSession.resumeFromRunId, workflowRunId)
assert.equal(rerunSession.scriptPath, session.scriptPath)
assert.deepEqual(rerunSession.runArgs, { topic: 'rerun' })

launchedPrompts.length = 0
launchedAgents.length = 0
const complexRun = await WorkflowFacadeTool.call(
  {
    args: {
      topic: 'official parity',
      attempts: 2,
      reviewers: ['cross-check', 'refute'],
      matrix: [
        { angle: 'primary', weight: 2 },
        { angle: 'counter', weight: 1 },
      ],
    },
    script: `export default async function main() {
      log('complex validation started')
      const findings = await parallel(args.matrix.map(item =>
        agent({
          label: 'research-' + item.angle,
          prompt: 'Research ' + args.topic + ' angle=' + item.angle + ' weight=' + item.weight,
        })
      ))
      const loopResult = await loopUntil({
        label: 'verification-loop',
        maxIterations: args.attempts,
        run: iteration => agent({
          label: 'verify-' + iteration,
          prompt: 'Verify iteration ' + iteration + ' for ' + findings.map(item => item.output).join('|'),
          dependsOn: findings.map(item => item.label),
        }),
        isDone: result => result.output.includes('verify-1'),
      })
      await review({
        label: 'review-cross-check',
        prompt: 'Cross-check ' + loopResult.output,
        dependsOn: [loopResult.label],
      })
      await refute({
        label: 'review-refute',
        prompt: 'Refute weak claims for ' + args.topic,
        dependsOn: ['review-cross-check'],
      })
      await vote({
        label: 'final-vote',
        prompt: 'Vote on claims after review/refute',
        dependsOn: ['review-cross-check', 'review-refute'],
      })
    }`,
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_facade_complex' } } as never,
)

assert.match(String(complexRun.data), /Workflow launched in background\. Task ID: w/)
const complexWorkflowRunId = String(complexRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(complexWorkflowRunId)
assert.deepEqual(launchedAgents.map(agent => agent.description), [
  'dry-run: research-primary',
  'dry-run: research-counter',
  'dry-run: verify-1',
  'dry-run: review-cross-check',
  'dry-run: review-refute',
  'dry-run: final-vote',
])
assert.match(launchedAgents[2]!.prompt, /Upstream phase outputs/)
assert.match(launchedAgents[5]!.prompt, /Vote on claims after review\/refute/)
const complexSession = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', complexWorkflowRunId, 'session.json'), 'utf8'),
)
assert.deepEqual(
  [...new Set(complexSession.events.map((event: { type: string }) => event.type))],
  ['workflow_progress', 'workflow_log', 'workflow_phase', 'workflow_agent'],
)
assert.deepEqual(complexSession.runArgs.reviewers, ['cross-check', 'refute'])
assert.equal(complexSession.results.length, 6)
assert.match(complexSession.scriptPath, /workflow\.js$/)

console.log('WorkflowFacadeTool.test.ts passed')
