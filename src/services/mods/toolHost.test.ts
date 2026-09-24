import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { isForkSubagentEnabled } from '../../tools/AgentTool/forkSubagent.js'
import { getSessionSettingsCache, setSessionSettingsCache, resetSettingsCache, setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModDispatchHook, ModInput } from './types.js'
import type { ModSnapshot } from './runtime.js'
import { createModToolHost } from './toolHost.js'
import { runModToolCall } from './toolAdapter.js'
import { runToolUse } from '../tools/toolExecution.js'
import { resolveHookPermissionDecision } from '../tools/toolHooks.js'
import { GENERAL_PURPOSE_AGENT } from '../../tools/AgentTool/built-in/generalPurposeAgent.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

function fixture(hooks: ModDispatchHook[] = []) {
  const calls: { input: unknown; context: ToolUseContext }[] = []
  const permissions: Parameters<CanUseToolFn>[] = []
  const mapped: unknown[] = []
  const failures: string[] = []
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
  const tool = {
    name: 'AuthorFixture',
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'ask', message: 'Confirm fixture' }),
    call: async (input: unknown, context: ToolUseContext) => {
      calls.push({ input, context })
      return { data: input }
    },
    mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) => {
      mapped.push(data)
      return { type: 'tool_result', tool_use_id: id, content: `mapped:${data.value}` }
    },
  } as unknown as Tool
  const snapshot: ModSnapshot = {
    hasHooks: event => hooks.some(hook => hook.registration.event === event),
    dispatch: (event, input, core, options) => dispatchModEvent({ event, input, core, hooks, ...options, onFailure: (_plugin, error) => { failures.push(String(error)) } }),
    release: () => { throw new Error('Host must not release the runtime snapshot') },
  }
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(), messages: [],
    getAppState: () => state, setAppState: () => {}, setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
  const canUseTool: CanUseToolFn = async (...args) => {
    permissions.push(args)
    return { behavior: 'allow' }
  }
  return { tool, snapshot, context, state, calls, permissions, mapped, failures, host: createModToolHost(context, canUseTool) }
}

function hook(event: string, invoke: ModDispatchHook['invoke']): ModDispatchHook {
  return { plugin: 'observer', tier: 'user', registration: { id: 1, event, hasCatch: false }, invoke }
}

describe('author tool host through the real executor', () => {
  test('spawn preserves omitted subagent type on the AgentTool production path', async () => {
    const f = fixture()
    let actualInput: Record<string, unknown> | undefined
    const call = spyOn(AgentTool, 'call').mockImplementation(async (input, context) => {
      actualInput = input
      context.modAgentStarted?.({ model: 'test-model', agentId: 'started-agent' })
      return {} as never
    })
    try {
      await f.host.spawn({ prompt: 'Review changes' }, f.snapshot, new AbortController().signal, 'author')
      expect(actualInput).not.toHaveProperty('subagent_type')
    } finally {
      call.mockRestore()
    }
  })

  test('spawn resolves at the AgentTool started boundary, uses parent context, and handles detached failure', async () => {
    const f = fixture()
    const parent = createAssistantMessage({ content: 'parent context' })
    f.context.messages = [parent]
    const started = Promise.withResolvers<{ model: string; agentId: string }>()
    const failed = new Error('detached completion failed')
    let actualParent: unknown
    const call = spyOn(AgentTool, 'call').mockImplementation(async (_input, context, _canUseTool, parentMessage) => {
      actualParent = parentMessage
      context.modAgentStarted?.({ model: 'test-model', agentId: 'started-agent' })
      started.resolve({ model: 'test-model', agentId: 'started-agent' })
      throw failed
    })
    try {
      const result = await f.host.spawn({ prompt: 'Review changes' }, f.snapshot, new AbortController().signal, 'author')
      expect(result).toEqual(await started.promise)
      expect(actualParent).toBe(parent)
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      call.mockRestore()
    }
  })

  test('spawn uses the real parent assistant context when available', async () => {
    if (!isForkSubagentEnabled()) return
    const f = fixture()
    f.context.options.mainLoopModel = 'claude-sonnet-4-6'
    f.context.options.agentDefinitions = {
      activeAgents: [GENERAL_PURPOSE_AGENT],
      allAgents: [GENERAL_PURPOSE_AGENT],
      allowedAgentTypes: undefined,
    }
    const parent = createAssistantMessage({
      content: [{
        type: 'tool_use', caller: { type: 'direct' }, id: 'mod-parent-spawn',
        name: 'Agent', input: { prompt: 'Review changes' },
      }],
    })
    let state = {
      ...getDefaultAppState(), ...f.state,
      mcp: { ...getDefaultAppState().mcp, clients: [], tools: [] },
      tasks: {}, agentNameRegistry: new Map(),
    }
    f.context.messages = [parent]
    f.context.getAppState = () => state as never
    f.context.setAppState = updater => {
      state = typeof updater === 'function' ? updater(state as never) as never : updater as never
    }
    const result = await f.host.spawn({ prompt: 'Review changes' }, f.snapshot, new AbortController().signal, 'author')
    expect(state.tasks[result.agentId!]).toMatchObject({ agentType: 'fork', spawnedBy: 'author' })
  })

  test('spawn registers a real background agent and returns once it starts', async () => {
    const f = fixture()
    f.context.options.mainLoopModel = 'claude-sonnet-4-6'
    f.context.options.agentDefinitions = {
      activeAgents: [GENERAL_PURPOSE_AGENT],
      allAgents: [GENERAL_PURPOSE_AGENT],
      allowedAgentTypes: undefined,
    }
    let state = {
      ...getDefaultAppState(),
      ...f.state,
      mcp: { ...getDefaultAppState().mcp, clients: [], tools: [] },
      tasks: {},
      agentNameRegistry: new Map(),
    }
    f.context.getAppState = () => state as never
    f.context.setAppState = updater => {
      state = typeof updater === 'function' ? updater(state as never) as never : updater as never
    }
    const result = await f.host.spawn({ prompt: 'Review changes' }, f.snapshot, new AbortController().signal, 'author')
    expect(result).toEqual({ model: expect.any(String), agentId: expect.any(String) })
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
      expect(state.tasks[result.agentId!]).toMatchObject({
        type: 'local_agent', status: 'running', prompt: 'Review changes', agentType: 'general-purpose', spawnedBy: 'author', isBackgrounded: true,
      })
      expect(state.tasks[result.agentId!]!.parentAgentId).toBeUndefined()
    }

    f.context.agentId = 'nested-parent' as ToolUseContext['agentId']
    f.context.options.subagentDepth = 1
    const nested = await f.host.spawn({ prompt: 'Nested review', subagentType: 'general-purpose' }, f.snapshot, new AbortController().signal, 'nested-author')
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
      expect(state.tasks[nested.agentId!]).toMatchObject({
        parentAgentId: 'nested-parent', spawnedBy: 'nested-author', spawnDepth: 2,
      })
    }
  })

  test('spawn deny creates no task and abort propagates', async () => {
    const denied = fixture([hook('agent.spawn', async () => ({ deny: 'No agent' }))])
    denied.context.options.agentDefinitions = { activeAgents: [GENERAL_PURPOSE_AGENT], allAgents: [GENERAL_PURPOSE_AGENT], allowedAgentTypes: undefined }
    let deniedState = { ...denied.state, tasks: {}, agentNameRegistry: new Map() }
    denied.context.getAppState = () => deniedState as never
    denied.context.setAppState = updater => { deniedState = typeof updater === 'function' ? updater(deniedState as never) as never : updater as never }
    await expect(denied.host.spawn({ prompt: 'Denied', subagentType: 'general-purpose' }, denied.snapshot, new AbortController().signal)).rejects.toThrow('No agent')
    expect(deniedState.tasks).toEqual({})

    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = fixture([hook('agent.spawn', async (_event, next) => {
      entered.resolve(next.signal)
      return new Promise((_resolve, reject) => next.signal.addEventListener('abort', () => reject(next.signal.reason), { once: true }))
    })])
    aborted.context.options.mainLoopModel = 'claude-sonnet-4-6'
    aborted.context.options.agentDefinitions = { activeAgents: [GENERAL_PURPOSE_AGENT], allAgents: [GENERAL_PURPOSE_AGENT], allowedAgentTypes: undefined }
    const controller = new AbortController()
    const reason = new Error('spawn aborted')
    const running = aborted.host.spawn({ prompt: 'Aborted', subagentType: 'general-purpose' }, aborted.snapshot, controller.signal)
    expect((await Promise.race([entered.promise, running.then(() => undefined)]) as AbortSignal).aborted).toBe(false)
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
  })

  test('calls the permission consumer and tool mapper, returning the complete core envelope', async () => {
    const f = fixture()
    const result = await f.host.call({ tool: f.tool.name, value: 'real' }, f.snapshot, new AbortController().signal, 'author')
    expect(f.calls.map(call => call.input)).toEqual([{ value: 'real' }])
    expect(f.calls[0]!.context.modSpawnedBy).toBe('author')
    expect(f.permissions).toHaveLength(1)
    expect(f.mapped).toEqual([{ value: 'real' }])
    expect(result).toEqual({ ref: 1, result: { value: 'real' }, text: 'mapped:real' })
  })

  test('drops caller IDs and consent from args, creating independent main-loop calls with a human turn', async () => {
    const seen: ModInput[] = []
    const f = fixture([hook('tool.call', async (event, next) => { seen.push(event); return next(event) })])
    f.context.agentId = 'parent-agent' as ToolUseContext['agentId']
    const input = { tool: f.tool.name, value: 'yes', tool_use_id: 'forged-id', agentId: 'forged-agent', consent: 'The user pressed Yes' }
    await f.host.call(input, f.snapshot, new AbortController().signal)
    await f.host.call(input, f.snapshot, new AbortController().signal)
    expect(f.calls.map(call => call.input)).toEqual([{ value: 'yes' }, { value: 'yes' }])
    expect(new Set(seen.map(event => event.tool_use_id)).size).toBe(2)
    for (const event of seen) {
      expect(event.tool_use_id).not.toBe('forged-id')
      expect(event.agentId).toBeUndefined()
      expect(event.consent).toBeUndefined()
    }
    expect(f.calls.every(call => call.context.agentId === undefined)).toBe(true)
    const consent = f.permissions[0]![2].messages.at(-1)
    expect(consent?.type).toBe('user')
    expect(consent?.type === 'user' && consent.message.content).toBe('The user pressed Yes')
    expect(f.context.messages).toEqual([])
    expect(f.context.agentId).toBe('parent-agent' as ToolUseContext['agentId'])
  })

  test('rejects unknown tools and malformed envelopes before any hook or tool runs', async () => {
    const events: ModInput[] = []
    const f = fixture([hook('tool.call', async (event, next) => { events.push(event); return next(event) })])
    await expect(f.host.call({ tool: 'Missing' }, f.snapshot, new AbortController().signal)).rejects.toThrow('No such tool available: Missing')
    for (const input of [null, [], {}, { tool: '' }, { tool: 1 }, { tool: f.tool.name, value: 'ok', consent: 1 }]) {
      await expect(f.host.call(input as ModInput, f.snapshot, new AbortController().signal)).rejects.toThrow()
    }
    expect(events).toEqual([])
    expect(f.calls).toEqual([])
    expect(f.permissions).toEqual([])
  })

  test('returns hook deny and rewritten results without creating author context reminders', async () => {
    const denied = fixture([hook('tool.call', async () => ({ deny: 'No author call' }))])
    expect(await denied.host.call({ tool: denied.tool.name, value: 'x' }, denied.snapshot, new AbortController().signal)).toEqual({ deny: 'No author call' })
    expect(denied.calls).toEqual([])
    const f = fixture([hook('tool.call', async () => ({ result: { value: 'synthetic' }, context: ['a'.repeat(100_001)] }))])
    expect(await f.host.call({ tool: f.tool.name, value: 'x' }, f.snapshot, new AbortController().signal)).toEqual({ result: { value: 'synthetic' }, context: ['a'.repeat(100_001)] })
    expect(f.mapped).toEqual([{ value: 'synthetic' }])
    expect(f.calls).toEqual([])
    const updates = await runModToolCall({
      snapshot: f.snapshot, tool: f.tool, toolUseID: 'author-no-reminder', input: { value: 'x' },
      toolUseContext: { ...f.context, modToolCallResult: () => {} },
      assistantMessage: createAssistantMessage({ content: 'author' }), core: async () => [],
    })
    expect(updates.some(update => update.message.type === 'attachment')).toBe(false)
  })

  test('propagates author abort to the actual tool and rejects without aborting the session', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<void>()
    f.tool.call = async (_input, context) => {
      const signal = context.abortController.signal
      entered.resolve(signal)
      await finish.promise
      return { data: { value: 'late' } }
    }
    const controller = new AbortController()
    const failure = new Error('author cancelled')
    const running = f.host.call({ tool: f.tool.name, value: 'x' }, f.snapshot, controller.signal)
    const rejected = running.then(() => undefined, error => error)
    try {
      const actual = await entered.promise
      controller.abort(failure)
      expect(actual.aborted).toBe(true)
      expect(actual.reason).toBe(failure)
      expect(f.context.abortController.signal.aborted).toBe(false)
    } finally {
      finish.resolve()
      expect(await rejected).toBe(failure)
    }
    const preAborted = fixture()
    await expect(preAborted.host.call({ tool: preAborted.tool.name, value: 'x' }, preAborted.snapshot, controller.signal)).rejects.toThrow('author cancelled')
    expect(preAborted.calls).toEqual([])
    expect(preAborted.permissions).toEqual([])
  })

  test('the executor consumes tool.check deny after Pre and before its dialog', async () => {
    const order: string[] = []
    let question: unknown, origin: unknown, core: unknown
    const f = fixture([
      hook('classic.PreToolUse', async (event, next) => { order.push('pre'); return next(event) }),
      hook('tool.check', async (event, next) => {
        order.push('check')
        question = event
        origin = next.origin
        core = await next(event)
        return { decision: 'deny', reason: 'Mod permission veto' }
      }),
    ])
    const result = await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
    expect(question).toMatchObject({ tool: 'AuthorFixture', input: { value: 'run' }, tool_use_id: expect.any(String) })
    expect(origin).toEqual({ plugin: 'engine', tier: 'core' })
    expect(core).toEqual({ decision: 'ask', reason: 'Confirm fixture' })
    expect(order).toEqual(['pre', 'check'])
    expect(f.calls).toEqual([])
    expect(f.permissions).toEqual([])
    expect(result).toMatchObject({ ref: 1, isError: true, text: 'Mod permission veto', result: 'Error: Mod permission veto' })
  })

  test('does not leak the author result callback into actual tools and nested invocations', async () => {
    const f = fixture()
    await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
    expect(f.calls[0]!.context.modToolCallResult).toBeUndefined()
  })

  test('consumes allow and ask, preserves pinned inputs, and keeps managed denies and safety prompts', async () => {
    for (const decision of ['allow', 'ask'] as const) {
      const f = fixture([hook('tool.check', async () => ({ decision, reason: 'Mod decision' }))])
      await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
      expect(f.calls).toHaveLength(1)
      expect(f.permissions).toHaveLength(decision === 'ask' ? 1 : 0)
      if (decision === 'ask') expect(f.permissions[0]![5]).toMatchObject({ behavior: 'ask', message: 'Mod decision' })
    }
    const managed = fixture([hook('tool.check', async () => ({ decision: 'allow' }))])
    managed.state.toolPermissionContext = { ...managed.state.toolPermissionContext, alwaysDenyRules: { policySettings: [managed.tool.name] } }
    expect(await managed.host.call({ tool: managed.tool.name, value: 'run' }, managed.snapshot, new AbortController().signal)).toMatchObject({ isError: true })
    expect(managed.calls).toEqual([])
    expect(managed.permissions).toEqual([])
    const safety = fixture([hook('tool.check', async () => ({ decision: 'allow' }))])
    safety.tool.checkPermissions = async () => ({ behavior: 'ask', message: 'Sensitive path', decisionReason: { type: 'safetyCheck', reason: 'Sensitive path', classifierApprovable: false } })
    await safety.host.call({ tool: safety.tool.name, value: 'run' }, safety.snapshot, new AbortController().signal)
    expect(safety.permissions[0]![5]).toMatchObject({ behavior: 'ask', message: 'Sensitive path' })
    for (const patch of [{ tool: 'Other' }, { input: { value: 'forged' } }, { tool_use_id: 'forged' }]) {
      const f = fixture([hook('tool.check', (event, next) => next({ ...event, ...patch }))])
      const result = await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
      expect(f.failures).toEqual([expect.stringContaining('cannot rewrite')])
      expect(result).toMatchObject({ result: { value: 'run' } })
      expect(f.calls.map(call => call.input)).toEqual([{ value: 'run' }])
      expect(f.permissions[0]![1]).toEqual({ value: 'run' })
    }
  })

  test('validates hook output with the real schema and retains thrown tool errors', async () => {
    const invalid = fixture([hook('tool.call', async () => ({ result: { value: 1 } }))])
    expect(await invalid.host.call({ tool: invalid.tool.name, value: 'run' }, invalid.snapshot, new AbortController().signal)).toMatchObject({ result: { value: 'run' } })
    expect(invalid.failures).toEqual([expect.stringContaining('output schema')])
    expect(invalid.calls.map(call => call.input)).toEqual([{ value: 'run' }])
    expect(invalid.mapped).toEqual([{ value: 'run' }])
    const failed = fixture([hook('tool.call', (event, next) => next(event))])
    failed.tool.call = async () => { throw new Error('real failure') }
    expect(await failed.host.call({ tool: failed.tool.name, value: 'run' }, failed.snapshot, new AbortController().signal)).toMatchObject({ ref: 1, isError: true, text: expect.stringContaining('real failure') })
  })

  test('author callback sees managed-reviewed context, never the pre-review content', async () => {
    const f = fixture([hook('tool.call', async () => ({ result: { value: 'synthetic' }, context: ['unreviewed'] }))])
    let captured: unknown
    await runModToolCall({
      snapshot: f.snapshot, tool: f.tool, toolUseID: 'reviewed-author', input: { value: 'x' },
      toolUseContext: { ...f.context, modToolCallResult: value => { captured = value } },
      assistantMessage: createAssistantMessage({ content: 'author' }), core: async () => [],
      review: async (_input, output) => ({ output, messages: [], context: ['reviewed'] }),
    })
    expect(captured).toEqual({ result: { value: 'synthetic' }, context: ['reviewed'] })
  })

  test('preserves failed core ref and hook context after repeated executions', async () => {
    const f = fixture([hook('tool.call', async (event, next) => {
      await next(event)
      const result = await next(event) as object
      return { ...result, context: ['Keep failure context'] }
    })])
    f.tool.call = async () => { throw new Error('twice failed') }
    expect(await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)).toMatchObject({ ref: 2, isError: true, context: ['Keep failure context'] })
  })

  test('consumes a hook mutating next verdict without losing the core identity', async () => {
    const f = fixture([hook('tool.check', async (event, next) => {
      const result = await next(event) as { decision: string }
      result.decision = 'allow'
      return result
    })])
    f.tool.checkPermissions = async () => ({ behavior: 'deny', message: 'Local refusal', decisionReason: { type: 'other', reason: 'Local refusal' } })
    await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
    expect(f.calls).toHaveLength(1)
    expect(f.permissions).toEqual([])
  })

  test('returns executor failures as core error envelopes rather than a missing-result rejection', async () => {
    const f = fixture()
    f.tool.validateInput = async () => { throw new Error('validator failed') }
    const result = await f.host.call({ tool: f.tool.name, value: 'run' }, f.snapshot, new AbortController().signal)
    expect(result).toMatchObject({ ref: 1, isError: true, result: expect.stringContaining('validator failed'), text: expect.stringContaining('validator failed') })
    expect(f.calls).toEqual([])
  })

  test('engine calls consume check-only snapshots and author snapshots override the origin', async () => {
    const origins: unknown[] = []
    const f = fixture([hook('tool.check', async (_event, next) => { origins.push(next.origin); return { decision: 'deny', reason: 'blocked' } })])
    const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, name: f.tool.name, id: 'engine-id', input: { value: 'x' } }
    const updates = await Array.fromAsync(runToolUse(block, createAssistantMessage({ content: [block] }), async () => { throw new Error('No dialog') }, { ...f.context, modsSnapshot: f.snapshot }))
    expect(JSON.stringify(updates)).toContain('blocked')
    const supplied = f.snapshot.dispatch
    f.snapshot.dispatch = (event, input, core, options) => supplied(event, input, core, { ...options, origin: { plugin: 'author', tier: 'user' } })
    await f.host.call({ tool: f.tool.name, value: 'x' }, f.snapshot, new AbortController().signal)
    expect(origins).toEqual([{ plugin: 'engine', tier: 'core' }, { plugin: 'author', tier: 'user' }])
    expect(f.calls).toEqual([])
  })

  test('a user Pre deny cannot mask a managed rule when tool.check changes it to allow', async () => {
    const f = fixture([
      hook('classic.PreToolUse', async () => ({ deny: 'User Pre refusal' })),
      hook('tool.check', async () => ({ decision: 'allow' })),
    ])
    f.state.toolPermissionContext = { ...f.state.toolPermissionContext, alwaysDenyRules: { policySettings: [f.tool.name] } }
    expect(await f.host.call({ tool: f.tool.name, value: 'x' }, f.snapshot, new AbortController().signal)).toMatchObject({ isError: true })
    expect(f.calls).toEqual([])
  })

  test('managed Pre veto stays outside plugin permission overrides', async () => {
    const f = fixture([hook('tool.check', async () => ({ decision: 'allow' }))])
    const result = await resolveHookPermissionDecision(
      { behavior: 'deny', message: 'Managed veto', decisionReason: { type: 'hook', hookName: 'PreToolUse', hookSource: 'policySettings' } },
      f.tool, { value: 'x' }, { ...f.context, modsSnapshot: f.snapshot },
      async () => { throw new Error('No dialog') }, createAssistantMessage({ content: 'test' }), 'managed-veto',
    )
    expect(result.decision).toMatchObject({ behavior: 'deny', message: 'Managed veto' })
  })

  test('rejects non-string tool.check decisions rather than coercing them', async () => {
    const f = fixture([hook('tool.check', async () => ({ decision: { toString: () => 'allow' } }))])
    await f.host.call({ tool: f.tool.name, value: 'x' }, f.snapshot, new AbortController().signal)
    expect(f.failures).toEqual([expect.stringContaining('must return a decision')])
    expect(f.permissions).toHaveLength(1)
  })

  test('check validates inputs and propagates cancellation to declarative checks only', async () => {
    const f = fixture()
    for (const input of [null, [], {}, { tool: '' }, { tool: f.tool.name }, { tool: f.tool.name, input: { value: 1 } }])
      await expect(f.host.check(input as { tool: string; input: unknown }, new AbortController().signal)).rejects.toThrow()
    await expect(f.host.check({ tool: 'Missing', input: {} }, new AbortController().signal)).rejects.toThrow('No such tool')
    const controller = new AbortController()
    const entered = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<void>()
    f.tool.checkPermissions = async (_args, context) => {
      entered.resolve(context.abortController.signal)
      await finish.promise
      return { behavior: 'allow' }
    }
    const failure = new Error('check aborted')
    const result = f.host.check({ tool: f.tool.name, input: { value: 'x' } }, controller.signal).then(() => undefined, error => error)
    try {
      const signal = await entered.promise
      controller.abort(failure)
      expect(signal.aborted).toBe(true)
    } finally {
      finish.resolve()
      expect(await result).toBe(failure)
    }
    expect(f.permissions).toEqual([])
    expect(f.calls).toEqual([])
  })

  test('check reads declarative rules and mode without invoking Pre, dialogs, or tools', async () => {
    const f = fixture([hook('classic.PreToolUse', async () => { throw new Error('Pre must not run') })])
    const input = { tool: f.tool.name, input: { value: 'query' } }
    expect(await f.host.check(input, new AbortController().signal)).toEqual({ decision: 'ask', reason: 'Confirm fixture' })
    f.state.toolPermissionContext = { ...f.state.toolPermissionContext, mode: 'bypassPermissions' }
    expect((await f.host.check(input, new AbortController().signal)).decision).toBe('allow')
    f.state.toolPermissionContext = { ...f.state.toolPermissionContext, alwaysDenyRules: { policySettings: [f.tool.name] } }
    expect(await f.host.check(input, new AbortController().signal)).toMatchObject({ decision: 'deny', rule: f.tool.name })
    expect(f.permissions).toEqual([])
    expect(f.calls).toEqual([])
  })
})
