import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { AbortError } from '../../utils/errors.js'
import { createModToolHost } from '../../services/mods/toolHost.js'
import { backgroundAgentTask, isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const childFlag = 'CLAUDE_CODE_AGENT_CONCURRENCY_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('Agent concurrency through the real lifecycle in an isolated process', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-concurrency-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-agent-concurrency-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stderr).toContain('0 fail')
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(directory, { recursive: true, force: true })
    }
  })
} else {
const streams: Array<{ started: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>>; error?: Error }> = []
mock.module('./runAgent.js', () => ({
  async *runAgent() {
    const stream = streams.shift()
    if (!stream) throw new Error('Unexpected agent execution')
    stream.started.resolve()
    await stream.finish.promise
    if (stream.error) throw stream.error
    yield { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: {
      id: 'msg_concurrency', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: 'standard', cache_creation: null },
    } }
  },
}))
const { AgentTool } = await import('./AgentTool.js')
const initialEnv = process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
const pending: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
const inFlight: Promise<void>[] = []
afterEach(async () => {
  for (const deferred of pending.splice(0)) deferred.resolve()
  await Promise.all(inFlight.splice(0))
  streams.length = 0
  if (initialEnv === undefined) delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
  else process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = initialEnv
  await Bun.sleep(10)
})
function hold(error?: Error) {
  const stream = { started: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), error }
  streams.push(stream)
  pending.push(stream.finish)
  return stream
}
function setup() {
  const state = getDefaultAppState()
  const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext(), mcp: { ...state.mcp, clients: [], tools: [] } })
  const context = {
    options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], inactiveAgents: [], allowedAgentTypes: undefined } },
    messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: store.getState, setAppState: store.setState,
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as unknown as ToolUseContext
  return { store, context }
}
const allowed = async () => ({ behavior: 'allow' as const })
const input = { prompt: 'finish', description: 'counter probe', subagent_type: 'general-purpose' }
function launch(context: ToolUseContext, background = true) {
  const completion = AgentTool.call({ ...input, run_in_background: background }, context, allowed, { message: { id: 'msg_parent' } } as never)
  inFlight.push(completion.then(() => {}, () => {}))
  return completion
}
function denyMessage(limit: number) {
  return 'Concurrent subagent limit reached. You can run ' + limit + ' subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.'
}
async function settled(context: ToolUseContext, id: string) {
  for (let i = 0; i < 100; i++) {
    const task = context.getAppState().tasks[id]
    if (isLocalAgentTask(task) && task.status !== 'running') return task
    await Bun.sleep(5)
  }
  throw new Error('Agent did not settle: ' + id)
}

test('default AppState has an independent zero concurrency counter', () => {
  expect(getDefaultAppState()).toHaveProperty('runningSubagents', 0)
})
test('global guard counts active execution across callers, not launch receipts', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = ' +02 '
  const { context } = setup()
  const first = hold(), second = hold()
  const a = await launch(context), b = await launch(context)
  await Promise.all([first.started.promise, second.started.promise])
  const overflow = launch(context)
  await expect(overflow).rejects.toMatchObject({ name: 'AgentPreconditionError', message: denyMessage(2) })
  expect(context.getAppState()).toHaveProperty('runningSubagents', 2)
  expect(Object.keys(context.getAppState().tasks)).toHaveLength(2)
  first.finish.resolve()
  await settled(context, a.data.agentId)
  expect(context.getAppState()).toHaveProperty('runningSubagents', 1)
  const replacement = hold()
  const c = await launch(context)
  await replacement.started.promise
  second.finish.resolve(); replacement.finish.resolve()
  await Promise.all([settled(context, b.data.agentId), settled(context, c.data.agentId)])
  expect(context.getAppState()).toHaveProperty('runningSubagents', 0)
})
test('root counter refuses even with no task records and a stale subagent view', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
  const { context, store } = setup()
  const stale = store.getState()
  store.setState(prev => ({ ...prev, runningSubagents: 1 }))
  const nested = { ...context, getAppState: () => stale, setAppState: () => {}, getAppStateForTasks: store.getState, setAppStateForTasks: store.setState } as ToolUseContext
  await expect(launch(nested)).rejects.toMatchObject({ name: 'AgentPreconditionError', message: denyMessage(1) })
  expect(Object.keys(store.getState().tasks)).toHaveLength(0)
})
test('Mod author receives a deny object for global preconditions', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
  const { context, store } = setup()
  store.setState(prev => ({ ...prev, runningSubagents: 1 }))
  const host = createModToolHost(context, allowed)
  const snapshot: Parameters<typeof host.spawn>[1] = { hasHooks: () => false, dispatch: async (_event, value, core) => core(value), release() {} }
  await expect(host.spawn({ prompt: 'finish', subagentType: 'general-purpose' }, snapshot, new AbortController().signal, 'other-plugin')).resolves.toEqual({ deny: denyMessage(1) })
  expect(Object.keys(store.getState().tasks)).toHaveLength(0)
})
for (const error of [undefined, new Error('controlled stream failure'), new AbortError('controlled cancellation')]) {
  test('background settlement releases its slot: ' + (error?.name ?? 'success'), async () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
    const { context } = setup()
    const stream = hold(error)
    const receipt = await launch(context)
    await stream.started.promise
    expect(context.getAppState()).toHaveProperty('runningSubagents', 1)
    stream.finish.resolve()
    const task = await settled(context, receipt.data.agentId)
    expect(task.status).toBe(error instanceof AbortError ? 'killed' : error ? 'failed' : 'completed')
    expect(context.getAppState()).toHaveProperty('runningSubagents', 0)
  })
}
for (const error of [undefined, new Error('controlled continuation failure')]) {
  test('foreground to background keeps the same slot until stream settlement: ' + (error ? 'failure' : 'success'), async () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
    const { context } = setup()
    const stream = hold(error)
    const completion = launch(context, false)
    await stream.started.promise
    expect(context.getAppState()).toHaveProperty('runningSubagents', 1)
    const taskId = Object.keys(context.getAppState().tasks)[0]!
    expect(backgroundAgentTask(taskId, context.getAppState, context.setAppState)).toBe(true)
    expect((await completion).data.status).toBe('async_launched')
    await expect(launch(context)).rejects.toMatchObject({ message: denyMessage(1) })
    stream.finish.resolve()
    const task = await settled(context, taskId)
    expect(task.status).toBe(error ? 'failed' : 'completed')
    expect(context.getAppState()).toHaveProperty('runningSubagents', 0)
  })
}
test('foreground completion releases its slot without a background handoff', async () => {
  const { context } = setup()
  const stream = hold()
  const completion = launch(context, false)
  await stream.started.promise
  expect(context.getAppState()).toHaveProperty('runningSubagents', 1)
  stream.finish.resolve()
  expect((await completion).data.status).toBe('completed')
  expect(context.getAppState()).toHaveProperty('runningSubagents', 0)
})

test('concurrent preparation rechecks capacity before reserving a slot', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
  const { context } = setup()
  const stream = hold()
  const results = await Promise.allSettled([launch(context), launch(context)])
  const accepted = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  expect(accepted).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined).toMatchObject({ name: 'AgentPreconditionError', message: denyMessage(1) })
  await stream.started.promise
  expect(context.getAppState()).toHaveProperty('runningSubagents', 1)
  expect(Object.keys(context.getAppState().tasks)).toHaveLength(1)
})

}
