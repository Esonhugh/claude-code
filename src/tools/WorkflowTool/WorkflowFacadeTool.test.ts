import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import { normalizeWorkflowFacadeInput } from './WorkflowFacadeTool.js'

assert.deepEqual(
  normalizeWorkflowFacadeInput({
    name: 'research',
    script:
      'export default workflow({ name: "research", description: "Research", phases: [] })',
  }),
  {
    kind: 'inline-script',
    name: 'research',
    script:
      'export default workflow({ name: "research", description: "Research", phases: [] })',
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

assert.deepEqual(normalizeWorkflowFacadeInput('official-compatible-research'), {
  kind: 'saved-workflow',
  selector: 'official-compatible-research',
  args: undefined,
})

const { WorkflowFacadeTool } = await import('./WorkflowFacadeTool.js')
assert.equal(WorkflowFacadeTool.name, 'Workflow')
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
const permissionPreview = await WorkflowFacadeTool.checkPermissions(
  { scriptPath: permissionScriptPath, args: 'topic' },
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
  phases: [{ title: 'Scope', detail: 'Scope saved args', prompt: "'saved preview '" }],
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
const launchedAgents: Array<{ description: string; prompt: string }> = []
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
        async call(input: { description: string; prompt: string }) {
          launchedPrompts.push(input.prompt)
          launchedAgents.push({
            description: input.description,
            prompt: input.prompt,
          })
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
  },
  abortController: new AbortController(),
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

const inlineRun = await WorkflowFacadeTool.call(
  {
    name: 'inline-research',
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
assert.match(String(inlineRun.data), /Workflow\({scriptPath: ".*inline-research\.js", resumeFromRunId: "wf_[^"]+"}\)/)
assert.deepEqual(launchedPrompts, ['inline topic=facade\n\nWorkflow user input:\n{\n  "topic": "facade"\n}'])
const taskId = String(inlineRun.data).match(/Task ID: (\S+)/)?.[1]
const workflowRunId = String(inlineRun.data).match(/Run ID: (\S+)/)?.[1]
assert.ok(taskId)
assert.ok(workflowRunId)
const session = JSON.parse(
  await readFile(join(tempRoot, '.claude', 'workflow-runs', workflowRunId, 'session.json'), 'utf8'),
)
assert.equal(session.taskId, taskId)
assert.equal(session.workflowRunId, workflowRunId)
assert.match(session.scriptPath, /inline-research\.js$/)
assert.deepEqual(session.runArgs, { topic: 'facade' })

launchedPrompts.length = 0
const officialRun = await WorkflowFacadeTool.call(
  {
    name: 'official-inline',
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
assert.deepEqual(launchedPrompts, ['scan meta\n\nWorkflow user input:\n{\n  "topic": "meta"\n}'])

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
assert.match(String(rerun.data), /Workflow\({scriptPath: ".*inline-research\.js", resumeFromRunId: "wf_[^"]+"}\)/)
assert.deepEqual(launchedPrompts, ['inline topic=rerun\n\nWorkflow user input:\n{\n  "topic": "rerun"\n}'])
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
    name: 'complex-secondary-validation',
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
assert.match(complexSession.scriptPath, /complex-secondary-validation\.js$/)

console.log('WorkflowFacadeTool.test.ts passed')
