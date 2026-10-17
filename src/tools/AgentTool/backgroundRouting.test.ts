import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createStore } from '../../state/store.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { createTeammateContext, runWithTeammateContext } from '../../utils/teammateContext.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const childFlag = 'CLAUDE_CODE_AGENT_ROUTING_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  for (const disabled of ['0', '1']) test('Agent background routing through the real lifecycle, disabled=' + disabled, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-routing-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-agent-concurrency-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: disabled },
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
const backgroundDisabled = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1'
const observedExecutionModes: boolean[] = []
const streams: Array<{ started: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>>; error?: Error }> = []
mock.module('./runAgent.js', () => ({
  async *runAgent(params: { isAsync: boolean }) {
    const stream = streams.shift()
    if (!stream) throw new Error('Unexpected agent execution')
    observedExecutionModes.push(params.isAsync)
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
  observedExecutionModes.length = 0
  if (initialEnv === undefined) delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
  else process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = initialEnv
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
async function settled(context: ToolUseContext, id: string) {
  for (let i = 0; i < 100; i++) {
    const task = context.getAppState().tasks[id]
    if (isLocalAgentTask(task) && task.status !== 'running') return task
    await Bun.sleep(5)
  }
  throw new Error('Agent did not settle: ' + id)
}

for (const [label, requested, definition, desired] of [
  ['omitted background defaults to async', undefined, undefined, true],
  ['explicit false keeps foreground', false, undefined, false],
  ['explicit true launches async', true, undefined, true],
  ['definition false does not override the omitted default', undefined, false, true],
  ['definition true overrides explicit false', false, true, true],
] as const) {
  test(label, async () => {
    const expected = !backgroundDisabled && desired
    const { context } = setup()
    context.options.agentDefinitions.activeAgents = [{ ...GENERAL_PURPOSE_AGENT, background: definition }]
    const stream = hold()
    const completion = AgentTool.call({ ...input, ...(requested !== undefined && { run_in_background: requested }) }, context, allowed, { message: { id: 'msg_parent' } } as never)
    inFlight.push(completion.then(() => {}, () => {}))
    await stream.started.promise
    try { expect(observedExecutionModes).toEqual([expected]) }
    finally { stream.finish.resolve() }
    const result = await completion
    expect(result.data.status).toBe(expected ? 'async_launched' : 'completed')
    if (expected) await settled(context, result.data.agentId)
    expect(context.getAppState().runningSubagents).toBe(0)
  })
}

for (const rewrite of [undefined, false, true]) {
  test('agent.spawn exposes the resolved default and respects rewrite: ' + String(rewrite), async () => {
    const { context } = setup()
    const seen: unknown[] = []
    context.modsSnapshot = {
      hasHooks: event => event === 'agent.spawn',
      dispatch: async (_event, value, core) => {
        seen.push(value.background)
        return core({ ...value, ...(rewrite !== undefined && { background: rewrite }) })
      },
      release() {},
    } as NonNullable<ToolUseContext['modsSnapshot']>
    const stream = hold()
    const completion = AgentTool.call(input, context, allowed, { message: { id: 'msg_parent' } } as never)
    inFlight.push(completion.then(() => {}, () => {}))
    await stream.started.promise
    try {
      expect(seen).toEqual([!backgroundDisabled])
      expect(observedExecutionModes).toEqual([!backgroundDisabled && (rewrite ?? true)])
    } finally { stream.finish.resolve() }
    const result = await completion
    expect(result.data.status).toBe(backgroundDisabled || rewrite === false ? 'completed' : 'async_launched')
    if (!backgroundDisabled && rewrite !== false) await settled(context, result.data.agentId)
    expect(context.getAppState().runningSubagents).toBe(0)
  })
}


for (const source of ['built-in', 'userSettings'] as const) {
  test('only the built-in web-fetch helper ignores implicit background: ' + source, async () => {
    const { context } = setup()
    context.options.agentDefinitions.activeAgents = [{ ...GENERAL_PURPOSE_AGENT, agentType: 'web-fetch', source, getSystemPrompt: () => 'web-fetch routing probe' }]
    const stream = hold()
    const completion = AgentTool.call({ ...input, subagent_type: 'web-fetch' }, context, allowed, { message: { id: 'msg_parent' } } as never)
    inFlight.push(completion.then(() => {}, () => {}))
    await stream.started.promise
    const expected = !backgroundDisabled && source !== 'built-in'
    try { expect(observedExecutionModes).toEqual([expected]) }
    finally { stream.finish.resolve() }
    const result = await completion
    expect(result.data.status).toBe(expected ? 'async_launched' : 'completed')
    if (expected) await settled(context, result.data.agentId)
    expect(context.getAppState().runningSubagents).toBe(0)
  })
}

test('in-process teammate keeps omitted background synchronous', async () => {
  const { context } = setup()
  const stream = hold()
  const teammate = createTeammateContext({ agentId: 'worker@routing', agentName: 'worker', teamName: 'routing', planModeRequired: false, parentSessionId: 'routing-parent', abortController: new AbortController() })
  const completion = runWithTeammateContext(teammate, () => AgentTool.call(input, context, allowed, { message: { id: 'msg_parent' } } as never))
  inFlight.push(completion.then(() => {}, () => {}))
  await stream.started.promise
  try { expect(observedExecutionModes).toEqual([false]) }
  finally { stream.finish.resolve() }
  expect((await completion).data.status).toBe('completed')
  expect(context.getAppState().runningSubagents).toBe(0)
})
}
