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

const childFlag = 'CLAUDE_CODE_FORK_MODE_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  for (const variant of ['interactive', 'print', 'opt-in', 'off', 'disabled', 'headless']) test('Fork mode through the real Agent lifecycle: ' + variant, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-routing-')))
    const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-agent-concurrency-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [childFlag]: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: variant === 'disabled' ? '1' : '0', CLAUDE_CODE_FORK_MODE_VARIANT: variant, ...(variant === 'off' ? { CLAUDE_CODE_FORK_SUBAGENT: '0' } : variant === 'opt-in' || variant === 'headless' ? { CLAUDE_CODE_FORK_SUBAGENT: '1' } : {}) },
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
const variant = process.env.CLAUDE_CODE_FORK_MODE_VARIANT!
const backgroundDisabled = variant === 'disabled'
const { setIsInteractive } = await import('../../bootstrap/state.js')
setIsInteractive(['interactive', 'off', 'disabled'].includes(variant))
const forkEnabled = !['print', 'off'].includes(variant)
const headless = variant === 'headless'
const observedParams: Record<string, unknown>[] = []
const observedExecutionModes: boolean[] = []
const streams: Array<{ started: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>>; error?: Error }> = []
mock.module('./runAgent.js', () => ({
  async *runAgent(params: { isAsync: boolean; [key: string]: unknown }) {
    observedParams.push(params)
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
  observedParams.length = 0
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
    agentId: headless ? 'aheadless' : undefined, renderedSystemPrompt: ['PARENT-SYSTEM-PROMPT'], messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
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

const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const parent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Agent', input: {}, caller: { type: 'direct' } }] })
async function execute(request: Partial<typeof input> & { run_in_background?: boolean; model?: string }, context = setup().context) {
  if (context.messages.length === 0) context.messages = [createUserMessage({ content: 'INHERITED-HISTORY' })]
  const stream = hold()
  const completion = AgentTool.call({ ...input, ...request }, context, allowed, parent)
  inFlight.push(completion.then(() => {}, () => {}))
  await Promise.race([stream.started.promise, completion.then(() => new Promise<void>(() => {}))])
  const params = observedParams.at(-1)!
  stream.finish.resolve()
  const result = await completion
  if (result.data.status === 'async_launched') await settled(context, result.data.agentId)
  expect(context.getAppState().runningSubagents).toBe(0)
  return { result, params }
}

test('schema and prompt describe explicit forks and the general-purpose default', async () => {
  const { getPrompt } = await import('./prompt.js')
  const prompt = await getPrompt([GENERAL_PURPOSE_AGENT])
  expect(prompt).toContain('If omitted, the general-purpose agent is used.')
  expect(prompt.includes('subagent_type: "fork"')).toBe(forkEnabled)
  expect(prompt).not.toContain('omit it to fork yourself')
  expect('run_in_background' in AgentTool.inputSchema.shape).toBe(!forkEnabled && !backgroundDisabled)
})

test('omitted type uses general-purpose; fork mode forces async unless caller is headless', async () => {
  const { params, result } = await execute({ subagent_type: undefined, run_in_background: false })
  expect((params.agentDefinition as { agentType: string }).agentType).toBe('general-purpose')
  expect(params.forkContextMessages).toBeUndefined()
  expect(params.useExactTools).toBeUndefined()
  const async = forkEnabled && !backgroundDisabled && !headless
  expect(params.isAsync).toBe(async)
  expect(result.data.status).toBe(async ? 'async_launched' : 'completed')
})

test('omitted background follows the headless caller exception', async () => {
  const { params } = await execute({})
  expect(params.isAsync).toBe(!backgroundDisabled && !headless)
})

test('script calls use the explicit fork route even in noninteractive default sessions', async () => {
  const context = setup().context
  context.innerCall = true
  if (variant === 'off') {
    await expect(AgentTool.call({ ...input, subagent_type: 'fork' }, context, allowed, parent)).rejects.toThrow("Agent type 'fork' not found")
    expect(observedParams).toHaveLength(0)
    return
  }
  const { params } = await execute({ subagent_type: 'F_O-R K', model: 'haiku' }, context)
  expect((params.agentDefinition as { agentType: string }).agentType).toBe('fork')
  expect(params.forkContextMessages).toBe(context.messages)
  expect(params.useExactTools).toBe(true)
  expect((params.override as { systemPrompt: unknown }).systemPrompt).toBe(context.renderedSystemPrompt)
  expect(params.resolvedModel).toBe(context.options.mainLoopModel)
  expect(params.isAsync).toBe(!backgroundDisabled)
})

test('Mods host marks a script call and preserves explicit fork selection', async () => {
  if (variant === 'off') return
  const context = setup().context
  context.messages = [parent]
  const { createModToolHost } = await import('../../services/mods/toolHost.js')
  const stream = hold()
  const host = createModToolHost(context, allowed)
  const launch = host.spawn({ prompt: 'host fork', subagentType: 'fork' }, {
    hasHooks: () => false, release() {}, dispatch: async (_event, value, core) => core(value),
  } as NonNullable<ToolUseContext['modsSnapshot']>, context.abortController.signal, 'fixture')
  inFlight.push(launch.then(() => {}, () => {}))
  await Promise.race([stream.started.promise, launch.then(() => new Promise<void>(() => {}))])
  const params = observedParams.at(-1)!
  expect((params.agentDefinition as { agentType: string }).agentType).toBe('fork')
  expect((params.toolUseContext as ToolUseContext).innerCall).toBe(true)
  expect(params.forkContextMessages).toBe(context.messages)
  stream.finish.resolve()
  const result = await launch
  expect(result).toHaveProperty('agentId')
  if ('agentId' in result && result.agentId) {
    if (!backgroundDisabled) await settled(context, result.agentId)
    else {
      expect(context.getAppState().tasks[result.agentId]).toBeUndefined()
      for (let i = 0; i < 100 && context.getAppState().runningSubagents !== 0; i++) await Bun.sleep(5)
    }
  }
  expect(context.getAppState().runningSubagents).toBe(0)
})

test('explicit fork is unavailable when disabled; custom fork definitions shadow it', async () => {
  const context = setup().context
  if (!forkEnabled) {
    await expect(AgentTool.call({ ...input, subagent_type: 'fork' }, context, allowed, parent)).rejects.toThrow("Agent type 'fork' not found")
    expect(observedParams).toHaveLength(0)
  }
  context.options.agentDefinitions.activeAgents = [{ ...GENERAL_PURPOSE_AGENT, agentType: 'F_OR-K', source: 'userSettings', getSystemPrompt: () => 'CUSTOM-FORK' }]
  const { params } = await execute({ subagent_type: 'fork', run_in_background: false }, context)
  expect((params.agentDefinition as { agentType: string }).agentType).toBe('F_OR-K')
  expect(params.forkContextMessages).toBeUndefined()
})

test('missing general-purpose requires a type and offers fork only when available', async () => {
  const context = setup().context
  context.options.agentDefinitions.activeAgents = []
  await expect(AgentTool.call({ ...input, subagent_type: undefined }, context, allowed, parent)).rejects.toThrow(
    'subagent_type is required: the general-purpose agent is not available in this session. Available agents: ' + (forkEnabled ? 'fork' : 'none'),
  )
  expect(observedParams).toHaveLength(0)
})

test('allowed types, explicit deny, recursion and remote isolation reject before execution', async () => {
  if (!forkEnabled) return
  for (const guard of ['allowed', 'deny', 'recursive', 'remote']) {
    const context = setup().context
    let message: string
    if (guard === 'allowed') {
      context.options.agentDefinitions.allowedAgentTypes = ['general-purpose']
      message = "Agent type 'fork' not found"
    } else if (guard === 'deny') {
      const permission = context.getAppState().toolPermissionContext
      context.setAppState(state => ({ ...state, toolPermissionContext: { ...permission, alwaysDenyRules: { userSettings: ['Agent(fork)'] } } }))
      message = "Agent type 'fork' has been denied by permission rule 'Agent(fork)' from userSettings."
    } else if (guard === 'recursive') {
      context.options.querySource = 'agent:builtin:fork'
      message = 'Fork is not available inside a forked worker.'
    } else message = 'Fork cannot use isolation: "remote"'
    await expect(AgentTool.call({ ...input, subagent_type: 'fork', ...(guard === 'remote' ? { isolation: 'remote' } : {}) }, context, allowed, parent)).rejects.toThrow(message)
    expect(observedParams).toHaveLength(0)
    expect(context.getAppState().runningSubagents).toBe(0)
  }
})

test('fork ignores the global subagent model override and script identity is invocation-local', async () => {
  const context = setup().context
  context.innerCall = true
  const { createSubagentContext } = await import('../../utils/forkedAgent.js')
  const child = createSubagentContext(context)
  expect(child.innerCall).toBeUndefined()
  if (variant === 'off') return
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
  try {
    const { params } = await execute({ subagent_type: 'fork' }, context)
    expect(params.resolvedModel).toBe(context.options.mainLoopModel)
  } finally { delete process.env.CLAUDE_CODE_SUBAGENT_MODEL }
})

test('fork inherits the parent plan model rather than its bubble permission mode', async () => {
  if (variant === 'off') return
  const { setMainLoopModelOverride } = await import('../../bootstrap/state.js')
  const { getDefaultOpusModel } = await import('../../utils/model/model.js')
  const context = setup().context
  context.innerCall = true
  context.setAppState(state => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'plan' } }))
  setMainLoopModelOverride('opusplan')
  try {
    const { params } = await execute({ subagent_type: 'fork' }, context)
    expect(params.resolvedModel).toBe(getDefaultOpusModel())
    const large = createAssistantMessage({ content: 'large parent context' })
    large.message.model = context.options.mainLoopModel
    large.message.usage.input_tokens = 200_001
    context.messages = [large]
    const extended = await execute({ subagent_type: 'fork' }, context)
    expect(extended.params.resolvedModel).toBe(context.options.mainLoopModel)
  } finally { setMainLoopModelOverride(null) }
})

test('Agent is immediately available in fork mode and the session latch obeys hard opt-out', async () => {
  const { isDeferredTool } = await import('../ToolSearchTool/prompt.js')
  const { isForkSubagentEnabled } = await import('./forkSubagent.js')
  const { regenerateSessionId } = await import('../../bootstrap/state.js')
  expect(isForkSubagentEnabled()).toBe(forkEnabled)
  if (forkEnabled) expect(isDeferredTool(AgentTool)).toBe(false)
  regenerateSessionId()
  setIsInteractive(false)
  delete process.env.CLAUDE_CODE_FORK_SUBAGENT
  expect(isForkSubagentEnabled()).toBe(false)
  process.env.CLAUDE_CODE_FORK_SUBAGENT = 'true'
  expect(isForkSubagentEnabled()).toBe(true)
  delete process.env.CLAUDE_CODE_FORK_SUBAGENT
  expect(isForkSubagentEnabled()).toBe(true)
  process.env.CLAUDE_CODE_FORK_SUBAGENT = 'false'
  expect(isForkSubagentEnabled()).toBe(false)
  delete process.env.CLAUDE_CODE_FORK_SUBAGENT
  expect(isForkSubagentEnabled()).toBe(true)
  regenerateSessionId()
  expect(isForkSubagentEnabled()).toBe(false)
  setIsInteractive(true)
  expect(isForkSubagentEnabled()).toBe(true)
  expect('run_in_background' in AgentTool.inputSchema.shape).toBe(false)
  process.env.CLAUDE_CODE_FORK_SUBAGENT = '0'
  expect('run_in_background' in AgentTool.inputSchema.shape).toBe(!backgroundDisabled)
})

}
