import assert from 'node:assert/strict'
import { mock } from 'bun:test'

import { initialState, reduce } from '../../../web/src/protocol.js'
import { coordinatorTaskNotes, workerTaskNotes } from '../../../web/src/projects.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import {
  enqueueAgentNotification,
  isLocalAgentTask,
  killAsyncAgent,
  registerAsyncAgent,
  stopBackgroundAgentTasks,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { AbortError } from '../../utils/errors.js'
import { asAgentId } from '../../types/ids.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { drainSdkEvents, getTaskRunId } from '../../utils/sdkEventQueue.js'
import {
  beginSubagentHandback,
  deliverSubagentHandback,
} from '../../utils/subagentHandback.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'

mock.module('../../services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization: () => ({ stop() {} }),
}))

const assistant = (text: string) => ({
  type: 'assistant' as const,
  uuid: crypto.randomUUID(),
  requestId: 'req_test',
  message: {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn' as const,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: 'standard' as const,
      cache_creation: null,
    },
  },
})

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
  speculation: { status: 'idle' },
} as unknown as AppState
const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

type Answer = { text: string } | { consumed: string }
type Input = Record<string, unknown> & { text: string }
const reports: Input[] = []
let hook: (input: Input, next: (value: Input) => Promise<Answer>) => Promise<Answer> = (input, next) => next(input)
let captured = 0
let released = 0
const snapshot = {
  hasHooks: (event: string) => event === 'agent.report',
  agentReportWarnings: new Map<string, string>(),
  async dispatch(event: string, input: Input, next: (value: Input) => Promise<Answer>) {
    assert.equal(event, 'agent.report')
    reports.push(input)
    return hook(input, next)
  },
  release() {
    released += 1
  },
}

async function run(
  taskId: string,
  makeStream: (abort: AbortController) => AsyncGenerator<unknown>,
  { unreported = false }: { unreported?: boolean } = {},
) {
  registerAsyncAgent({
    agentId: taskId,
    description: taskId,
    prompt: 'go',
    selectedAgent,
    setAppState,
    toolUseId: `toolu_${taskId}`,
    spawnDepth: 1,
  })
  const abortController = new AbortController()
  await runAsyncAgentLifecycle({
    taskId,
    abortController,
    makeStream: () => makeStream(abortController) as never,
    metadata: {
      prompt: 'go',
      resolvedAgentModel: 'claude-sonnet-4-6',
      isBuiltInAgent: true,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: true,
    },
    description: taskId,
    toolUseContext: {
      options: { tools: [] },
      getAppState: () => state,
      toolUseId: `toolu_${taskId}`,
      mods: {
        capture: () => {
          captured += 1
          return snapshot
        },
      },
    } as never,
    rootSetAppState: setAppState,
    agentIdForCleanup: taskId,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
    unreported,
  })
  const task = state.tasks[taskId]
  assert.ok(isLocalAgentTask(task))
  return task
}

const queued = (taskId: string) =>
  getCommandQueue().filter(command => String(command.value).includes(taskId))
const lastReport = () => reports.at(-1)
const sdkNotice = (taskId: string) =>
  drainSdkEvents().find(event => event.subtype === 'task_notification' && event.task_id === taskId) as Record<string, unknown> | undefined

// The SDK describes the same owner as the model's queue, and distinguishes actual fallback.
for (const ownerIsLive of [true, false]) {
  const owner = `owner-${ownerIsLive}`
  const child = `child-${ownerIsLive}`
  registerAsyncAgent({ agentId: owner, description: owner, prompt: 'go', selectedAgent, setAppState, spawnDepth: 1 })
  registerAsyncAgent({ agentId: child, ownerAgentId: owner, description: child, prompt: 'go', selectedAgent, setAppState, spawnDepth: 2 })
  assert.ok(drainSdkEvents().some(event => event.subtype === 'task_started' && event.task_id === child && event.parent_task_id === owner))
  if (!ownerIsLive) {
    const parent = state.tasks[owner]
    assert.ok(isLocalAgentTask(parent))
    state = { ...state, tasks: { ...state.tasks, [owner]: { ...parent, status: 'completed', keepaliveReasons: new Set() } } }
  }
  enqueueAgentNotification({ taskId: child, description: child, status: 'completed', setAppState, finalMessage: 'done', toolUseId: `toolu_${child}` })
  const ending = sdkNotice(child)
  assert.equal(ending?.parent_task_id, owner)
  assert.equal(ending?.notification_to_main, ownerIsLive ? undefined : true)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(queued(child).length, 1)
  assert.equal(queued(child)[0]?.agentId, ownerIsLive ? asAgentId(owner) : undefined)
  // Do not let these synthetic running tasks participate in the later interrupt fixture.
  state = { ...state, tasks: {} }
}

// Exercise the actual owner queue and its late reroute, with no CLI or model call.
{
  const owner = 'fixture-late-owner'
  const child = 'fixture-late-child'
  registerAsyncAgent({ agentId: owner, description: owner, prompt: 'go', selectedAgent, setAppState, spawnDepth: 1 })
  registerAsyncAgent({ agentId: child, ownerAgentId: owner, description: child, prompt: 'go', selectedAgent, setAppState, spawnDepth: 2 })
  const starts = drainSdkEvents()
  enqueueAgentNotification({ taskId: child, description: child, status: 'completed', setAppState, finalMessage: 'done' })
  const end = sdkNotice(child)
  assert.ok(end)
  assert.equal(end.tool_use_id, undefined)
  const started = starts.find(event => event.subtype === 'task_started' && event.task_id === child) as { run_id?: string } | undefined
  assert.ok(started?.run_id)
  assert.equal(end.run_id, started.run_id)
  const queuedForOwner = queued(child).find(command => command.taskId === child)
  assert.equal(queuedForOwner?.agentId, asAgentId(owner))
  assert.ok(!String(queuedForOwner?.value).includes('<tool-use-id>'))
  const history = (uuid: string, content: unknown) => ({ type: 'user', isReplay: true, uuid, message: { content } })
  const ownedHistory = reduce(initialState, history('owner-log', queuedForOwner?.value))
  const before = [...starts, end].reduce(reduce, initialState)
  assert.deepEqual(coordinatorTaskNotes(before), [])
  assert.equal(workerTaskNotes(before, owner, ownedHistory).length, 1)
  assert.equal(ownedHistory.taskNotes[0]?.runId, started.run_id)
  const firstRun = state.tasks[child]
  assert.ok(isLocalAgentTask(firstRun))
  state = { ...state, tasks: { ...state.tasks, [child]: { ...firstRun, status: 'completed' } } }
  registerAsyncAgent({ agentId: child, ownerAgentId: owner, description: child, prompt: 'resume', selectedAgent, setAppState, spawnDepth: 2 })
  assert.notEqual(getTaskRunId(child), started.run_id)
  killAsyncAgent(owner, setAppState, 'parent')
  await Promise.resolve()
  await Promise.resolve()
  const rerouted = queued(child).find(command => command.taskId === child)
  assert.ok(rerouted)
  assert.equal(rerouted.agentId, undefined)
  assert.equal(rerouted.value, queuedForOwner?.value)
  assert.equal(rerouted.sdkTaskNotificationSent, true)
  assert.ok(!sdkNotice(child))
  const mainLog = history('main-log', rerouted.value)
  for (const after of [reduce(before, mainLog), [mainLog, ...starts, end].reduce(reduce, initialState)]) {
    assert.deepEqual(coordinatorTaskNotes(after).map(note => note.runId), [started.run_id])
    assert.deepEqual(workerTaskNotes(after, owner, ownedHistory), [])
    assert.deepEqual(workerTaskNotes(after, owner, initialState), [])
  }
  state = { ...state, tasks: {} }
}

// A direct Web resume has no tool call when its reply is queued to main.
{
  const taskId = 'fixture-web-resume'
  registerAsyncAgent({ agentId: taskId, description: taskId, prompt: 'resume', selectedAgent, setAppState, spawnDepth: 1 })
  const runId = getTaskRunId(taskId)
  assert.ok(runId)
  enqueueAgentNotification({ taskId, description: taskId, status: 'completed', setAppState, finalMessage: 'done' })
  const end = sdkNotice(taskId)
  const command = queued(taskId).find(item => item.taskId === taskId)
  assert.ok(end && command)
  assert.equal(end.run_id, runId)
  assert.equal(end.tool_use_id, undefined)
  assert.equal(command.agentId, undefined)
  const log = { type: 'user', isReplay: true, uuid: 'web-resume-log', message: { content: command.value } }
  for (const frames of [[end, log], [log, end]]) {
    assert.deepEqual(coordinatorTaskNotes(frames.reduce(reduce, initialState)).map(note => note.runId), [runId])
  }
  state = { ...state, tasks: {} }
}

// A finished background run is reported, and the parent reads the report's answer.
// SDK hosts are told the summary is that report, as no review of it is to come (official 2.1.329 outside auto mode).
drainSdkEvents()
hook = async (input, next) => ({ text: `${(await next(input) as { text: string }).text} (rewritten)` })
await run('agent-report-completed', async function* () {
  yield assistant('done')
})
assert.deepEqual(lastReport(), {
  agentId: 'agent-report-completed',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  status: 'completed',
  text: 'done',
})
assert.equal(queued('agent-report-completed').length, 1)
assert.match(String(queued('agent-report-completed')[0]?.value), /done \(rewritten\)/)
assert.equal(captured, released)
const completedNotice = sdkNotice('agent-report-completed')
assert.equal(completedNotice?.summary, 'done (rewritten)')
assert.equal(completedNotice?.summary_is_report, true)
assert.equal(completedNotice?.handback, undefined)

// A report carrying a mod's warning is not shown as the bare summary.
snapshot.agentReportWarnings.set('agent-report-warned', 'WARNED')
await run('agent-report-warned', async function* () {
  yield assistant('done')
})
const warnedNotice = sdkNotice('agent-report-warned')
assert.equal(warnedNotice?.status, 'completed')
assert.equal(warnedNotice.summary_is_report, undefined)
hook = (input, next) => next(input)

// A failed or stopped run had no review: `off` where the mode runs none (official 2.1.329, outside auto mode).
const reviews: unknown[] = []
hook = async (input, next) => {
  const answer = await next(input)
  reviews.push((answer as { review?: unknown }).review)
  return answer
}

// A failed run is reported failed, with no output of its own.
await run('agent-report-failed', async function* () {
  yield assistant('partial')
  throw new Error('boom')
})
assert.equal(lastReport()?.agentId, 'agent-report-failed')
assert.equal(lastReport()?.status, 'failed')
assert.equal(lastReport()?.text, '')
assert.equal(queued('agent-report-failed').length, 1)

// A killed run is reported stopped, with what it said so far.
await run('agent-report-killed', async function* (abort) {
  yield assistant('halfway')
  abort.abort()
  throw new AbortError('stopped')
})
assert.equal(lastReport()?.agentId, 'agent-report-killed')
assert.equal(lastReport()?.status, 'stopped')
assert.equal(lastReport()?.text, 'halfway')
assert.deepEqual(reviews, ['off', 'off'])
const failedNotice = sdkNotice('agent-report-failed')
assert.equal(failedNotice?.status, 'failed')
assert.equal(failedNotice.summary_is_report, undefined)
hook = (input, next) => next(input)

// A consumed report is not told to the parent, which no longer waits for it.
hook = async () => ({ consumed: 'kept by the mod' })
const consumedTask = await run('agent-report-consumed', async function* () {
  yield assistant('secret')
})
assert.equal(queued('agent-report-consumed').length, 0)
assert.equal(consumedTask.notified, true)
// SDK hosts see the description, not the mod's reason, and no report (official 2.1.329).
const consumedNotice = sdkNotice('agent-report-consumed')
assert.equal(consumedNotice?.status, 'completed')
assert.equal(consumedNotice.summary, 'agent-report-consumed')
assert.equal(consumedNotice.summary_is_report, undefined)
assert.equal(consumedNotice.handback, undefined)

// A consumed hand-back that delivered nothing stays withheld; one that delivered names no hand-back.
beginSubagentHandback('agent-report-consumed-withheld', true)
await run('agent-report-consumed-withheld', async function* () {
  yield assistant('unsent')
})
const withheldNotice = sdkNotice('agent-report-consumed-withheld')
assert.equal(withheldNotice?.summary, 'agent-report-consumed-withheld')
assert.equal(withheldNotice.handback, 'withheld')
assert.equal(withheldNotice.handback_report, undefined)
beginSubagentHandback('agent-report-consumed-sent', true)
await run('agent-report-consumed-sent', async function* () {
  deliverSubagentHandback('agent-report-consumed-sent', 'REPORT-GAMMA', undefined, 'toolu_gamma')
  yield assistant('sent')
})
const sentNotice = sdkNotice('agent-report-consumed-sent')
assert.equal(sentNotice?.summary, 'agent-report-consumed-sent')
assert.equal(sentNotice.handback, undefined)
assert.equal(sentNotice.handback_report, undefined)
assert.equal(sentNotice.summary_is_report, undefined)
hook = (input, next) => next(input)

// A hand-back run reports its delivered report; the answer replaces it under the frame.
beginSubagentHandback('agent-report-handback', true)
hook = async () => ({ text: 'REPORT-BETA' })
await run('agent-report-handback', async function* () {
  deliverSubagentHandback('agent-report-handback', 'REPORT-ALPHA', undefined, 'toolu_handback_call')
  yield assistant('sent')
})
assert.equal(lastReport()?.agentId, 'agent-report-handback')
assert.equal(lastReport()?.text, 'REPORT-ALPHA')
const handbackNotice = String(queued('agent-report-handback')[0]?.value)
assert.match(handbackNotice, /REPORT-BETA/)
assert.doesNotMatch(handbackNotice, /REPORT-ALPHA/)
// SDK hosts render the report the hand-back delivered, not the summary, tied to the SubagentHandback call that sent it.
const handbackSdk = sdkNotice('agent-report-handback')
assert.equal(handbackSdk?.handback, 'send')
assert.deepEqual(handbackSdk?.handback_report, { text: 'REPORT-BETA', toolUseId: 'toolu_handback_call' })
assert.equal(handbackSdk?.summary_is_report, undefined)
hook = (input, next) => next(input)

// A workflow's agent() raises no agent.report.
const before = reports.length
await run('agent-report-workflow', async function* () {
  yield assistant('workflow done')
}, { unreported: true })
assert.equal(reports.length, before)
assert.match(String(queued('agent-report-workflow')[0]?.value), /workflow done/)

// A print-mode interrupt's sweep: the run still reports stopped, SDK consumers see it end once, and the model is not told.
drainSdkEvents()
const sweptTask = await run('agent-report-swept', async function* (abort) {
  yield assistant('halfway')
  assert.deepEqual(stopBackgroundAgentTasks(state.tasks, setAppState).map(task => task.id), ['agent-report-swept'])
  abort.abort()
  throw new AbortError('stopped')
})
assert.equal(sweptTask.status, 'killed')
assert.equal(lastReport()?.agentId, 'agent-report-swept')
assert.equal(lastReport()?.status, 'stopped')
assert.equal(queued('agent-report-swept').length, 0)
assert.deepEqual(
  drainSdkEvents().filter(event => event.subtype === 'task_notification').map(event => [event.task_id, event.status]),
  [['agent-report-swept', 'stopped']],
)

console.log('agentReport.background.test.ts passed')
