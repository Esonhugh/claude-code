import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import { AbortError } from '../../utils/errors.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  beginSubagentHandback,
  deliverSubagentHandback,
} from '../../utils/subagentHandback.js'
import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

// The subagent tool pool asks the Workflow tool for its plan default, which reads the subscription.
process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'

const assistant = (text: string): Message =>
  ({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: 'standard',
        cache_creation: null,
      },
    },
  }) as unknown as Message

mock.module('../../services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization: () => ({ stop() {} }),
}))

type Script = 'handback' | 'interrupted' | 'apiError'
let script: Script = 'handback'
let started: (() => void) | undefined
let childSignal: AbortSignal | undefined

mock.module('./runAgent.js', () => ({
  async *runAgent(params: { override: { agentId: string; abortController?: AbortController } }) {
    const { agentId, abortController } = params.override
    childSignal = abortController?.signal
    if (script === 'handback') {
      beginSubagentHandback(agentId, true)
      deliverSubagentHandback(agentId, 'REPORT-ALPHA', undefined)
      yield assistant('sent')
      return
    }
    if (script === 'apiError') {
      yield { ...assistant('API Error: 400 probe failure'), isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 400 } as Message
      return
    }
    yield assistant('halfway')
    started?.()
    await new Promise<void>(resolve => {
      if (childSignal?.aborted) resolve()
      childSignal?.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new AbortError('interrupted')
  },
}))

type Answer = { text: string; review?: string } | { consumed: string }
type Input = Record<string, unknown> & { text: string }
const reports: Input[] = []
const reviews: Answer[] = []
let hook: (input: Input, next: (value: Input) => Promise<Answer>) => Promise<Answer> = async (input, next) => {
  const below = await next(input)
  reviews.push(below)
  return below
}
const snapshot = {
  hasHooks: (event: string) => event === 'agent.report',
  agentReportWarnings: new Map<string, string>(),
  async dispatch(event: string, input: Input, next: (value: Input) => Promise<Answer>) {
    assert.equal(event, 'agent.report')
    reports.push(input)
    return hook(input, next)
  },
  release() {},
}

type TestContext = Parameters<typeof AgentTool.call>[1] & {
  getAppState: () => ReturnType<typeof getDefaultAppState>
}

function createContext(): TestContext {
  const defaultState = getDefaultAppState()
  const agentDefinitions = {
    activeAgents: [GENERAL_PURPOSE_AGENT],
    inactiveAgents: [],
    allowedAgentTypes: undefined,
  }
  let state = {
    ...defaultState,
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { ...defaultState.mcp, clients: [], tools: [] },
    agentDefinitions,
    tasks: {},
    agentNameRegistry: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions,
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => state,
    setAppState: updater => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    modsSnapshot: snapshot,
    mods: { capture: () => snapshot },
  } as never
}

const call = (context: TestContext, description: string) =>
  AgentTool.call(
    {
      description,
      prompt: 'go',
      subagent_type: 'general-purpose',
      run_in_background: false,
    },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: `msg_parent_${description}` } } as never,
  )

// A hand-back run is reported, its own verdict as the review; the answer replaces the report under the frame.
{
  script = 'handback'
  hook = async (input, next) => {
    const below = await next(input)
    reviews.push(below)
    return { text: 'REPORT-BETA' }
  }
  const result = await call(createContext(), 'handback')
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.status, 'completed')
  assert.equal(reports[0]?.text, 'REPORT-ALPHA')
  assert.equal((reviews[0] as { review?: string }).review, 'cleared')
  assert.equal(result.data.status, 'completed')
  assert.match(JSON.stringify(result.data), /REPORT-BETA/)
  assert.doesNotMatch(JSON.stringify(result.data), /REPORT-ALPHA/)
}

// Interrupting the parent stops the foreground run, which is reported stopped and leaves no task running.
{
  script = 'interrupted'
  reports.length = 0
  hook = (input, next) => next(input)
  const context = createContext()
  const reachedWork = new Promise<void>(resolve => {
    started = resolve
  })
  const pending = call(context, 'interrupted')
  await reachedWork
  context.abortController.abort()
  await assert.rejects(pending, AbortError)
  assert.equal(childSignal?.aborted, true)
  for (let i = 0; i < 20 && reports.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.status, 'stopped')
  assert.equal(reports[0]?.text, 'halfway')
  const running = Object.values(context.getAppState().tasks).filter(
    task => isLocalAgentTask(task) && task.status === 'running',
  )
  assert.deepEqual(running, [])
}

// A run that ends on an API error is reported failed with no text, and the parent reads official 2.1.329's termination text.
{
  script = 'apiError'
  reports.length = 0
  reviews.length = 0
  hook = async (input, next) => {
    const below = await next(input)
    reviews.push(below)
    return below
  }
  await assert.rejects(call(createContext(), 'api-error'), (error: Error) => {
    assert.match(error.message, /^Agent terminated early due to an API error: API Error: 400 probe failure \(error type unknown, HTTP 400, model sent to the API: [^)]+\)$/)
    return true
  })
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.status, 'failed')
  assert.equal(reports[0]?.text, '')
  assert.equal((reviews[0] as { review?: string }).review, 'off')
}

console.log('agentReport.foreground.test.ts passed')
