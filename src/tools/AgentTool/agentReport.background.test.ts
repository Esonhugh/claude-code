import assert from 'node:assert/strict'
import { mock } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { AbortError } from '../../utils/errors.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
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

// A finished background run is reported, and the parent reads the report's answer.
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
hook = (input, next) => next(input)

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

// A consumed report is not told to the parent, which no longer waits for it.
hook = async () => ({ consumed: 'kept by the mod' })
const consumedTask = await run('agent-report-consumed', async function* () {
  yield assistant('secret')
})
assert.equal(queued('agent-report-consumed').length, 0)
assert.equal(consumedTask.notified, true)
hook = (input, next) => next(input)

// A hand-back run reports its delivered report; the answer replaces it under the frame.
beginSubagentHandback('agent-report-handback', true)
hook = async () => ({ text: 'REPORT-BETA' })
await run('agent-report-handback', async function* () {
  deliverSubagentHandback('agent-report-handback', 'REPORT-ALPHA', undefined)
  yield assistant('sent')
})
assert.equal(lastReport()?.agentId, 'agent-report-handback')
assert.equal(lastReport()?.text, 'REPORT-ALPHA')
const handbackNotice = String(queued('agent-report-handback')[0]?.value)
assert.match(handbackNotice, /REPORT-BETA/)
assert.doesNotMatch(handbackNotice, /REPORT-ALPHA/)
hook = (input, next) => next(input)

// A workflow's agent() raises no agent.report.
const before = reports.length
await run('agent-report-workflow', async function* () {
  yield assistant('workflow done')
}, { unreported: true })
assert.equal(reports.length, before)
assert.match(String(queued('agent-report-workflow')[0]?.value), /workflow done/)

console.log('agentReport.background.test.ts passed')
