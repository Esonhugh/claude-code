#!/usr/bin/env node
// Official 2.1.292 Workflow semantics that the facade must keep: launch parses meta and
// compiles only, agent failures leave the run completed, and resume is guarded.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { setIsInteractive } from '../../bootstrap/state.js'
import { dequeue, dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  killWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

const { WorkflowFacadeTool } = await import('./WorkflowFacadeTool.js')

setSessionSettingsCache({ settings: { enableWorkflows: true }, errors: [] })
setIsInteractive(false)
drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')

const cwd = await mkdtemp(join(tmpdir(), 'workflow-official-parity-'))
let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}

const prompts: string[] = []
const held: Array<() => void> = []
const agentTool = {
  name: 'Agent',
  aliases: ['Task'],
  async call(input: { prompt: string }, agentContext: ToolUseContext) {
    prompts.push(input.prompt)
    if (input.prompt.startsWith('hold')) {
      await new Promise<void>((resolve, reject) => {
        held.push(resolve)
        agentContext.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (input.prompt.startsWith('fail')) throw new Error(`controlled failure for ${input.prompt}`)
    const text = input.prompt.startsWith('words') ? 'four words right here' : `done: ${input.prompt}`
    return { data: { status: 'completed', content: [{ type: 'text', text }], totalDurationMs: 1 } }
  },
}

function context(foreground = true): ToolUseContext {
  return {
    getCwd: () => cwd,
    getAppState: () => state,
    setAppState,
    options: {
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      tools: [agentTool],
      mcpClients: [],
      mcpResources: {},
      debug: false,
      verbose: false,
      thinkingConfig: {},
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-6',
      workflowRunInForeground: foreground,
    },
    abortController: new AbortController(),
    messages: [],
    toolUseId: 'toolu_parity',
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function run(input: Record<string, unknown>, foreground = true): Promise<string> {
  const result = await WorkflowFacadeTool.call(
    input as never,
    context(foreground),
    async () => ({ behavior: 'allow' }) as never,
    { message: { id: 'msg_parity' } } as never,
  )
  return String(result.data)
}

function runIdOf(envelope: string): string {
  const runId = envelope.match(/Run ID: (\S+)/)?.[1]
  assert.ok(runId, envelope)
  return runId
}

function scriptPathOf(envelope: string): string {
  const scriptPath = envelope.match(/Script file: (\S+)/)?.[1]
  assert.ok(scriptPath, envelope)
  return scriptPath
}

function taskOf(envelope: string): LocalWorkflowTaskState {
  const taskId = envelope.match(/Task ID: (\S+)/)?.[1]
  const task = taskId ? state.tasks[taskId] : undefined
  assert.equal(task?.type, 'local_workflow', envelope)
  return task as LocalWorkflowTaskState
}

function notificationOf(task: LocalWorkflowTaskState): string {
  const notification = dequeue(
    command => command.mode === 'task-notification' && String(command.value).includes(task.id),
  )
  assert.ok(notification, `no notification for ${task.id}`)
  return String(notification.value)
}

function script(name: string, body: string, phases = ''): string {
  return `export const meta = { name: '${name}', description: '${name} probe', phases: [${phases}] }\n${body}\n`
}

// An inline script whose body does not compile is reported and leaves no run directory
// behind; a valid inline script is still persisted under .claude/workflow-runs.
const runDirs = async (): Promise<string[]> =>
  (await readdir(join(cwd, '.claude', 'workflow-runs')).catch(() => [])).filter(entry => entry.startsWith('wf_'))
const runDirsBefore = await runDirs()
const tasksBefore = Object.keys(state.tasks).length
prompts.length = 0
await assert.rejects(
  run({ script: script('syntax-error', `export const later = 1`) }),
  /Workflow script has a syntax error and was not launched/,
)
assert.deepEqual(await runDirs(), runDirsBefore)
assert.equal(Object.keys(state.tasks).length, tasksBefore)
assert.deepEqual(prompts, [])
// The same holds when a saved workflow is run with an inline script override.
await assert.rejects(
  run({ name: 'deep-research', script: script('saved-syntax-error', `export const later = 1`) }),
  /Workflow script has a syntax error and was not launched/,
)
assert.deepEqual(await runDirs(), runDirsBefore)
assert.equal(Object.keys(state.tasks).length, tasksBefore)
assert.deepEqual(prompts, [])

const persistedSource = script('persisted', `return agent('persist me')`)
const persisted = await run({ script: persistedSource })
assert.equal(scriptPathOf(persisted), join(await realpath(cwd), '.claude', 'workflow-runs', runIdOf(persisted), 'persisted.js'))
assert.equal(await readFile(scriptPathOf(persisted), 'utf8'), persistedSource)
assert.deepEqual((await runDirs()).sort(), [...runDirsBefore, runIdOf(persisted)].sort())
assert.equal(taskOf(persisted).status, 'completed')
dequeueAllMatching(command => command.mode === 'task-notification')

// Launch parses meta and compiles only: these valid scripts used to be rejected by a
// dry run of their body (too many agents in a phase, alternating pipeline phases, a
// schema-less agent() result used as a string).
prompts.length = 0
const wide = taskOf(await run({
  script: script('wide-phase', `phase('Scan')
const found = await parallel(Array.from({ length: 20 }, (_, i) => () => agent('scan ' + i, { label: 'scan-' + i })))
return found.filter(Boolean).length`, `{ title: 'Scan' }`),
}))
assert.equal(wide.status, 'completed')
assert.equal(prompts.length, 20)
assert.match(notificationOf(wide), /<result>20<\/result>/)

prompts.length = 0
const pipelined = taskOf(await run({
  script: script('alternating-pipeline', `return pipeline(['a', 'b', 'c'],
  item => agent('scan ' + item, { phase: 'Scan' }),
  found => agent('check ' + found, { phase: 'Check' }))`, `{ title: 'Scan' }, { title: 'Check' }`),
}))
assert.equal(pipelined.status, 'completed')
assert.equal(prompts.length, 6)

prompts.length = 0
const words = taskOf(await run({
  script: script('string-result', `const text = await agent('words please')
return { words: text.split(' ').length }`),
}))
assert.equal(words.status, 'completed')
assert.match(notificationOf(words), /<result>\{"words":4\}<\/result>|"words": 4/)

// A failed agent returns null and is reported under <failures>; the run still completes
// with the script's own result. Only a throw from the script fails the run.
const withFailure = taskOf(await run({
  script: script('failed-agent-null', `const results = await parallel([
  () => agent('ok one', { label: 'ok-1' }),
  () => agent('fail one', { label: 'fail-1' }),
])
return { kept: results.filter(Boolean).length, nulls: results.filter(result => result === null).length }`),
}))
assert.equal(withFailure.status, 'completed')
const failureNotification = notificationOf(withFailure)
assert.match(failureNotification, /<status>completed<\/status>/)
assert.match(failureNotification, /<failures>\[fail-1\] failed: controlled failure for fail one<\/failures>/)
assert.match(failureNotification, /"kept": ?1/)
assert.match(failureNotification, /"nulls": ?1/)

const thrown = taskOf(await run({
  script: script('script-throws', `await agent('ok two')
throw new Error('script gave up')`),
}))
assert.equal(thrown.status, 'failed')
assert.match(notificationOf(thrown), /<status>failed<\/status>[\s\S]*script gave up/)

// Like official, a run stops at 1000 agent() calls.
prompts.length = 0
const capped = taskOf(await run({
  script: script('agent-cap', `let round = 0
while (true) await agent('loop ' + round++)`),
}))
assert.equal(capped.status, 'failed')
assert.equal(prompts.length, 1000)
assert.match(notificationOf(capped), /Workflow agent\(\) call cap reached \(1000\)/)

// Resume reuses the run id; unchanged calls replay from the journal, a label change does
// not count as a change, and after the first changed call everything runs live.
const resumable = script('resumable', `return parallel([
  () => agent('alpha', { label: 'a' }),
  () => agent('beta', { label: 'b' }),
])`)
prompts.length = 0
const first = await run({ script: resumable })
const resumableRunId = runIdOf(first)
const resumableScriptPath = scriptPathOf(first)
assert.deepEqual(prompts.sort(), ['alpha', 'beta'])
dequeueAllMatching(command => command.mode === 'task-notification')

prompts.length = 0
const replay = await run({ scriptPath: resumableScriptPath, resumeFromRunId: resumableRunId })
assert.equal(runIdOf(replay), resumableRunId)
assert.equal(taskOf(replay).status, 'completed')
assert.deepEqual(prompts, [])

prompts.length = 0
await run({ script: resumable.replace("label: 'a'", "label: 'renamed-a'"), resumeFromRunId: resumableRunId })
assert.deepEqual(prompts, [])

prompts.length = 0
await run({ script: resumable.replace("agent('alpha'", "agent('alpha edited'"), resumeFromRunId: resumableRunId })
assert.deepEqual(prompts.sort(), ['alpha edited', 'beta'])
dequeueAllMatching(command => command.mode === 'task-notification')

// An agent interrupted by a kill respawns without making the rest of the run live.
prompts.length = 0
const interrupted = await run({
  script: script('interrupted', `return parallel([
  () => agent('hold first', { label: 'held' }),
  () => agent('gamma', { label: 'g' }),
])`),
}, false)
for (let tries = 0; tries < 200 && prompts.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 10))
for (let tries = 0; tries < 200 && !taskOf(interrupted).results.some(result => result.status === 'completed'); tries++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
killWorkflowTask(taskOf(interrupted).id, setAppState)
for (let tries = 0; tries < 200 && held.length > 0; tries++) await new Promise(resolve => setTimeout(resolve, 10))
await new Promise(resolve => setTimeout(resolve, 100))
held.length = 0
prompts.length = 0
const respawned = run({ scriptPath: scriptPathOf(interrupted), resumeFromRunId: runIdOf(interrupted) }, false)
const respawnedEnvelope = await respawned
for (let tries = 0; tries < 200 && held.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 10))
assert.deepEqual(prompts, ['hold first'])
held.shift()?.()
for (let tries = 0; tries < 200 && taskOf(respawnedEnvelope).status === 'running'; tries++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.equal(taskOf(respawnedEnvelope).status, 'completed')
assert.deepEqual(prompts, ['hold first'])
dequeueAllMatching(command => command.mode === 'task-notification')

// A run that is still running cannot be resumed; an unknown run id has nothing to resume.
prompts.length = 0
const live = await run({ script: script('live-run', `return agent('hold live')`) }, false)
for (let tries = 0; tries < 200 && held.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 10))
await assert.rejects(
  run({ scriptPath: scriptPathOf(live), resumeFromRunId: runIdOf(live) }),
  new RegExp(`Workflow ${runIdOf(live)} is still running \\(task ${taskOf(live).id}\\)\\. Stop it first with TaskStop`),
)
assert.deepEqual(prompts, ['hold live'])
held.shift()?.()
for (let tries = 0; tries < 200 && taskOf(live).status === 'running'; tries++) await new Promise(resolve => setTimeout(resolve, 10))
dequeueAllMatching(command => command.mode === 'task-notification')

prompts.length = 0
await assert.rejects(
  run({ script: resumable, resumeFromRunId: 'wf_doesnotexist1' }),
  /nothing to resume/,
)
assert.deepEqual(prompts, [])
assert.equal(
  WorkflowFacadeTool.inputSchema.safeParse({ script: resumable, resumeFromRunId: 'wf-123' }).success,
  false,
)

console.log('WorkflowFacadeTool.officialParity.test.ts passed')
