import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message, StreamEvent } from '../../types/message.js'
import type { ModDispatchHook, ModInput } from '../../services/mods/types.js'
import type { ModSnapshot } from '../../services/mods/runtime.js'
import type { queryModelWithStreaming } from '../../services/api/claude.js'

const childEnv = 'CLAUDE_CODE_PM1_AGENT_TURN_TEST_CHILD'

if (process.env[childEnv] === '1') {
  await isolatedTests()
} else {
  test('[PM1 producer] actual runAgent lifecycle uses the real QueryLoop in an isolated process', async () => {
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '10000', import.meta.path], {
      cwd: import.meta.dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-pm1-producer', [childEnv]: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 40_000,
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`PM1 isolated producer suite failed (${code})\n${stdout}\n${stderr}`)
      expect(`${stdout}\n${stderr}`).toContain('PM1 actual producer suite finished')
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
    }
  }, 45_000)
}

async function isolatedTests(): Promise<void> {
  type ModelInput = Parameters<typeof queryModelWithStreaming>[0]
  type ModelScript = (input: ModelInput) => ReturnType<typeof queryModelWithStreaming>
  let script: ModelScript
  let modelCalls: ModelInput[] = []
  let coreClosed = 0
  let coreLimit = 1
  let rejectedOverflow = 0
  let stopOverflow: (() => Promise<void>) | undefined
  const actualProvider = await import('../../services/api/claude.js')
  // Only the external model I/O boundary is replaced. runAgent/query/deps,
  // prompt construction, compaction, dispatch and persistence remain real.
  mock.module('../../services/api/claude.js', () => ({
    ...actualProvider,
    async *queryModelWithStreaming(input: ModelInput) {
      if (modelCalls.length >= coreLimit) {
        rejectedOverflow++
        void stopOverflow?.().catch(() => {})
        throw new Error('PM1 bounded model call limit exceeded')
      }
      modelCalls.push(input)
      try { yield* script(input) } finally { coreClosed++ }
    },
  }))

  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { query } = await import('../../query.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
  const { asAgentId, asSessionId } = await import('../../types/ids.js')
  const { getSessionId, getSessionProjectDir, switchSession, clearInvokedSkills } = await import('../../bootstrap/state.js')
  const { flushSessionStorage } = await import('../../utils/sessionStorage.js')
  const { resetGitFileWatcher } = await import('../../utils/git/gitFilesystem.js')
  const { clearBundledSkills, registerBundledSkill } = await import('../../skills/bundledSkills.js')
  const { clearCommandsCache } = await import('../../commands.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { runAgent } = await import('./runAgent.js')
  type Runtime = ReturnType<typeof createModsRuntime>
  type AgentParams = Parameters<typeof runAgent>[0]
  type TurnEvent = { event: string; input: ModInput }
  type Lease = { snapshot: ModSnapshot; released: number; events: string[] }

  const fixture = await mkdtemp(join(tmpdir(), 'mods-pm1-agent-turn-'))
  const project = join(fixture, 'project')
  await mkdir(project)
  const previousSession = getSessionId(), previousProject = getSessionProjectDir()
  const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  const runtimes: Runtime[] = []

  function response(id = `pm1-response-${modelCalls.length}`): AssistantMessage {
    const message = createAssistantMessage({ content: 'FINITE_AGENT_ANSWER' })
    Object.assign(message.message, {
      id, model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    })
    return message
  }

  function makeContext(runtime: Runtime): ToolUseContext {
    let state = getDefaultAppState()
    return {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: updater => { state = updater(state) },
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
      messages: [], mods: runtime,
    } as ToolUseContext
  }

  async function makeRuntime(options: Parameters<typeof createModsRuntime>[0] = {}): Promise<Runtime> {
    const runtime = createModsRuntime(options)
    runtimes.push(runtime)
    await runtime.bind({ cwd: project, sessionId: getSessionId(), surface: null, isInteractive: false })
    return runtime
  }

  function observeTurns(runtime: Runtime, events: TurnEvent[], complete?: ModDispatchHook['invoke'], tier: ModDispatchHook['tier'] = 'user'): void {
    runtime.registerHostHook({
      plugin: 'pm1-observer', tier, registration: { id: 1, event: 'turn.start', hasCatch: false },
      invoke: async (input, next) => { events.push({ event: 'turn.start', input }); return next(input) },
    })
    runtime.registerHostHook({
      plugin: 'pm1-observer', tier, registration: { id: 2, event: 'turn.step', hasCatch: false },
      invoke: async () => { throw new Error('turn.step must use the stream consumer') },
      invokeStream: async function* (input, next) {
        events.push({ event: 'turn.step', input })
        const stream = next(input)
        for await (const chunk of stream) yield chunk
        return await stream.result
      },
    })
    runtime.registerHostHook({
      plugin: 'pm1-observer', tier, registration: { id: 3, event: 'turn.complete', hasCatch: false },
      invoke: async (input, next, catching) => {
        events.push({ event: 'turn.complete', input })
        return complete ? complete(input, next, catching) : next(input)
      },
    })
  }

  function observeLeases(runtime: Runtime): Lease[] {
    const captures: Lease[] = []
    const capture = runtime.capture
    runtime.capture = services => {
      const original = capture(services)
      const lease: Lease = { snapshot: original, released: 0, events: [] }
      const wrapped: ModSnapshot = {
        ...original,
        dispatch(event, input, core, options) {
          expect(lease.released).toBe(0)
          lease.events.push(event)
          return original.dispatch(event, input, core, options)
        },
        stream(event, input, core, options) {
          expect(lease.released).toBe(0)
          lease.events.push(event)
          return original.stream!(event, input, core, options)
        },
        release() { lease.released++; original.release() },
      }
      lease.snapshot = wrapped
      captures.push(lease)
      return wrapped
    }
    return captures
  }

  function params(runtime: Runtime, patch: Partial<AgentParams> = {}): AgentParams {
    return {
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'finite real agent task' })],
      toolUseContext: makeContext(runtime), canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false, querySource: 'agent:custom', availableTools: [],
      override: { userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      ...patch,
    }
  }

  async function drain(iterator: ReturnType<typeof runAgent>): Promise<Message[]> {
    const messages: Message[] = []
    while (true) {
      const item = await iterator.next()
      if (item.done === true) return messages
      messages.push(item.value)
    }
  }

  beforeEach(() => {
    switchSession(asSessionId(randomUUID()), project)
    clearInvokedSkills(); clearBundledSkills(); clearCommandsCache()
    modelCalls = []; coreClosed = 0; coreLimit = 1; rejectedOverflow = 0; stopOverflow = undefined
    script = async function* () { yield response() }
  })
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
    clearInvokedSkills(); clearBundledSkills(); clearCommandsCache()
    await flushSessionStorage()
    resetGitFileWatcher()
  })

  for (const querySource of ['agent:custom', 'repl_main_thread']) {
    test(`[PM1 producer] real runAgent owns step and completion independently of source ${querySource}`, async () => {
      const runtime = await makeRuntime()
      const events: TurnEvent[] = []
      observeTurns(runtime, events)
      const messages = await drain(runAgent(params(runtime, { querySource })))
      expect(modelCalls).toHaveLength(1)
      expect(coreClosed).toBe(1)
      expect(messages.some(message => message.type === 'assistant')).toBe(true)
      expect(events.map(event => event.event)).toEqual(['turn.step', 'turn.complete'])
      const [step, complete] = events
      expect(step!.input.agentId).toBe(modelCalls[0]!.options.agentId)
      expect(complete!.input.agentId).toBe(step!.input.agentId)
      expect(complete!.input.turnId).toBe(step!.input.turnId)
      expect(complete!.input).toMatchObject({ reason: 'answer', isAborted: false, answer: 'FINITE_AGENT_ANSWER',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } })
      expect(runtime.activePublicTurnId).toBeUndefined()
    })
  }

  test('[PM1 producer] two real runs preserve agent identity and mint distinct turn identities', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    observeTurns(runtime, events)
    coreLimit = 2
    const agentId = asAgentId('pm1-real-resume')
    const options = params(runtime)
    for (let i = 0; i < 2; i++) await drain(runAgent({ ...options, override: { ...options.override, agentId } }))
    expect(modelCalls).toHaveLength(2)
    expect(events.map(event => event.event)).toEqual(['turn.step', 'turn.complete', 'turn.step', 'turn.complete'])
    expect(events.map(event => event.input.agentId)).toEqual([agentId, agentId, agentId, agentId])
    expect(events[0]!.input.turnId).toBe(events[1]!.input.turnId)
    expect(events[2]!.input.turnId).toBe(events[3]!.input.turnId)
    expect(events[0]!.input.turnId).not.toBe(events[2]!.input.turnId)
    expect(coreClosed).toBe(2)
  })

  test('[PM1 producer] consumer.return closes the real core and emits exactly one aborted completion', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    observeTurns(runtime, events)
    const iterator = runAgent(params(runtime))
    try {
      let item = await iterator.next()
      while (item.done === false && item.value.type !== 'assistant') item = await iterator.next()
      expect(item.done).toBe(false)
      await iterator.return(undefined)
      expect(modelCalls).toHaveLength(1)
      expect(coreClosed).toBe(1)
      expect(events.filter(event => event.event === 'turn.complete').map(event => event.input))
        .toEqual([expect.objectContaining({ reason: 'aborted', isAborted: true, agentId: modelCalls[0]!.options.agentId })])
      await iterator.return(undefined)
      expect(events.filter(event => event.event === 'turn.complete')).toHaveLength(1)
    } finally { await iterator.return(undefined) }
  })

  test('[PM1 producer] a real built-in callback failure remains the primary error and completes as error', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    observeTurns(runtime, events)
    const failure = new Error('PM1_CALLBACK_PRIMARY')
    const definition = { ...GENERAL_PURPOSE_AGENT, callback() { throw failure } }
    await expect(drain(runAgent(params(runtime, { agentDefinition: definition })))).rejects.toBe(failure)
    expect(modelCalls).toHaveLength(1)
    expect(coreClosed).toBe(1)
    const complete = events.filter(event => event.event === 'turn.complete')
    expect(complete).toHaveLength(1)
    expect(complete[0]!.input).toMatchObject({ reason: 'error', isAborted: false, answer: 'FINITE_AGENT_ANSWER' })
  })

  test('[PM1 producer] an actual skill preload rejection completes before any model request', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    observeTurns(runtime, events)
    const failure = new Error('PM1_PRELOAD_PRIMARY')
    let skillCalls = 0
    registerBundledSkill({ name: 'pm1-reject-preload', description: 'Finite failing setup boundary',
      async getPromptForCommand() { skillCalls++; throw failure } })
    const definition = { ...GENERAL_PURPOSE_AGENT, skills: ['pm1-reject-preload'] }
    await expect(drain(runAgent(params(runtime, { agentDefinition: definition })))).rejects.toBe(failure)
    expect(skillCalls).toBe(1)
    expect(modelCalls).toHaveLength(0)
    expect(coreClosed).toBe(0)
    expect(events.map(event => event.event)).toEqual(['turn.complete'])
    expect(events[0]!.input).toMatchObject({ reason: 'error', isAborted: false, answer: '' })
    expect(events[0]!.input.usage).toBeUndefined()
  })

  test('[PM1 producer] completion uses a fresh lease after the real query lease was released', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    const leases = observeLeases(runtime)
    const releasedAtComplete: number[] = []
    observeTurns(runtime, events, async (input, next) => {
      const queryLease = leases.find(lease => lease.snapshot === modelCalls[0]?.options.modsSnapshot)
      if (!queryLease) throw new Error('Real model request did not carry an observed query lease')
      releasedAtComplete.push(queryLease.released)
      return next(input)
    })
    await drain(runAgent(params(runtime)))
    expect(modelCalls).toHaveLength(1)
    const queryLease = leases.find(lease => lease.snapshot === modelCalls[0]!.options.modsSnapshot)
    const completionLeases = leases.filter(lease => lease.events.includes('turn.complete'))
    expect(queryLease).toBeDefined()
    expect(completionLeases).toHaveLength(1)
    expect(releasedAtComplete).toEqual([1])
    expect(completionLeases[0]!.snapshot).not.toBe(queryLease!.snapshot)
    expect(queryLease!.released).toBe(1)
    expect(completionLeases[0]!.released).toBe(1)
    expect(leases.every(lease => lease.released === 1)).toBe(true)
  })

  test('[PM1 producer] a completion hook and diagnostic sink failure cannot replace a callback error', async () => {
    const diagnostics: string[] = []
    const runtime = await makeRuntime({ onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic.stage)
      throw new Error('PM1_DIAGNOSTIC_SECONDARY')
    } })
    const events: TurnEvent[] = []
    observeTurns(runtime, events, async () => { throw new Error('PM1_COMPLETE_SECONDARY') })
    const failure = new Error('PM1_CALLBACK_PRIMARY_WITH_SECONDARIES')
    await expect(drain(runAgent(params(runtime, {
      agentDefinition: { ...GENERAL_PURPOSE_AGENT, callback() { throw failure } },
    })))).rejects.toBe(failure)
    expect(modelCalls).toHaveLength(1)
    expect(coreClosed).toBe(1)
    expect(events.filter(event => event.event === 'turn.complete')).toHaveLength(1)
    expect(events.find(event => event.event === 'turn.complete')!.input.reason).toBe('error')
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  test('[PM1 producer] main releases its registry before completion while preserving the event identity', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    const activeAtCompletion: Array<string | undefined> = []
    let activeAtModel: string | undefined
    observeTurns(runtime, events, async (input, next) => {
      activeAtCompletion.push(runtime.activePublicTurnId)
      return next(input)
    })
    script = async function* () { activeAtModel = runtime.activePublicTurnId; yield response('pm1-main-release') }
    const context = makeContext(runtime)
    const iterator = query({ messages: [createUserMessage({ content: 'main turn' })],
      systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {}, toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), querySource: 'sdk', publicTurn: { text: 'main turn' },
    })
    try {
      while (!(await iterator.next()).done) { /* Consume the real public producer. */ }
      expect(modelCalls).toHaveLength(1)
      expect(activeAtModel).toBeDefined()
      expect(events.map(event => event.event)).toEqual(['turn.start', 'turn.step', 'turn.complete'])
      expect(events.map(event => event.input.turnId)).toEqual([activeAtModel, activeAtModel, activeAtModel])
      expect(activeAtCompletion).toEqual([undefined])
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally { await iterator.return({ reason: 'pm1-test-cleanup' }) }
  })

  for (const hadStepHook of [false, true]) {
    test(`[PM1 producer] real agent completion selects reloaded handlers only if bound initially (step=${hadStepHook})`, async () => {
      const runtime = await makeRuntime()
      const entry = join(fixture, `agent-reload-${hadStepHook}.ts`)
      const input = { name: `pm1-agent-reload-${hadStepHook}`, storageId: `pm1-agent-reload-${hadStepHook}@inline`, pluginRoot: fixture, entrypoints: [entry] }
      const stepHook = hadStepHook ? "on('turn.step',async function* ($,e,next){const s=next(e);for await(const c of s)yield c;return await s.result;});" : ''
      await writeFile(entry, `export function register(on) {${stepHook}on('tool.call',()=>({result:[]}));}`)
      await runtime.reconcile([input])
      expect(runtime.hasHooks('turn.step')).toBe(hadStepHook)
      expect(runtime.hasHooks('turn.complete')).toBe(false)
      const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
      script = async function* () { entered.resolve(); await resume.promise; yield response('pm1-agent-reload') }
      const options = params(runtime)
      const iterator = runAgent(options)
      const pending = drain(iterator)
      void pending.catch(() => {})
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Agent ended before model boundary') })])
        expect(modelCalls[0]!.options.agentId).toBeDefined()
        await writeFile(entry, `let events=[]; export function register(on) {${stepHook}
          on('turn.complete',($,e,next)=>{events.push(e);return next(e);});on('tool.call',()=>({result:events}));
        }`)
        await runtime.reconcile([input])
        expect(runtime.hasHooks('turn.complete')).toBe(true)
        resume.resolve()
        await pending
        expect(modelCalls).toHaveLength(1)
        expect(coreClosed).toBe(1)
        const value = await runtime.dispatch('tool.call', {}, async () => ({ result: [] })) as { result: ModInput[] }
        expect(value.result).toHaveLength(hadStepHook ? 1 : 0)
        if (hadStepHook) expect(value.result[0]).toMatchObject({ agentId: modelCalls[0]!.options.agentId, reason: 'answer', isAborted: false })
        expect(runtime.activePublicTurnId).toBeUndefined()
      } finally {
        resume.resolve()
        options.toolUseContext.abortController.abort()
        await pending.catch(() => {})
        await iterator.return(undefined)
      }
    }, 10_000)
  }

  test('[PM1 producer] main registers without turn hooks and invokes the current reloaded completion handler', async () => {
    const runtime = await makeRuntime()
    const entry = join(fixture, 'reload-register.ts')
    const input = { name: 'pm1-reload', storageId: 'pm1-reload@inline', pluginRoot: fixture, entrypoints: [entry] }
    await writeFile(entry, "export function register(on) {on('tool.call',()=>({result:[]}));}")
    await runtime.reconcile([input])
    expect(runtime.hasHooks('turn.step')).toBe(false)
    expect(runtime.hasHooks('turn.complete')).toBe(false)
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    script = async function* () { entered.resolve(); await resume.promise; yield response('pm1-main-reload') }
    const context = makeContext(runtime)
    const iterator = query({ messages: [createUserMessage({ content: 'main public task' })],
      systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {}, toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), querySource: 'sdk',
      publicTurn: { text: 'main public task' },
    })
    const pending = (async () => {
      const messages: Array<Message | StreamEvent> = []
      while (true) { const item = await iterator.next(); if (item.done) return messages; messages.push(item.value) }
    })()
    void pending.catch(() => {})
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Main query ended before model boundary') })])
      const turnId = runtime.activePublicTurnId
      expect(turnId).toBeDefined()
      await writeFile(entry, `let events=[]; export function register(on) {
        on('turn.complete',async ($,e,next)=>{events.push(e);const value=await next(e);return {...value,text:'MAIN_COMPLETION_FROM_RELOADED_MOD'};});
        on('tool.call',()=>({result:events}));
      }`)
      await runtime.reconcile([input])
      expect(runtime.hasHooks('turn.complete')).toBe(true)
      expect(runtime.activePublicTurnId).toBe(turnId)
      resume.resolve()
      const messages = await pending
      expect(modelCalls).toHaveLength(1)
      expect(coreClosed).toBe(1)
      const value = await runtime.dispatch('tool.call', {}, async () => ({ result: [] })) as { result: ModInput[] }
      expect(value.result).toHaveLength(1)
      expect(value.result[0]).toMatchObject({ turnId, reason: 'answer', isAborted: false })
      expect(value.result[0]!.agentId).toBeUndefined()
      expect(JSON.stringify(messages)).toContain('MAIN_COMPLETION_FROM_RELOADED_MOD')
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      resume.resolve()
      context.abortController.abort()
      await pending.catch(() => {})
      await iterator.return({ reason: 'pm1-test-cleanup' })
    }
  }, 10_000)




  // Historical runs/28 expected transparent teardown rejection here. Fixed 289
  // Ms -> FVt -> core Ss as a Ug handler closes suspended streams through gt,
  // which absorbs return cleanup errors. Active body errors still propagate.
  for (const hasBodyError of [false, true]) {
    test(`[PM1 close postfix] registered core-Ug cleanup preserves the ${hasBodyError ? 'body error' : 'normal return'}`, async () => {
      const runtime = await makeRuntime(), events: TurnEvent[] = []
      observeTurns(runtime, events)
      const leases = observeLeases(runtime)
      const bodyFailure = new Error('PM1_REAL_BODY_PRIMARY'), closeFailure = new Error('PM1_REAL_CORE_CLOSE')
      script = async function* () { try { yield response('pm1-close-error') } finally { await Promise.reject(closeFailure) } }
      const iterator = runAgent(params(runtime, {
        ...(hasBodyError ? { onQueryProgress() { if (modelCalls.length > 0 && coreClosed === 0) throw bodyFailure } } : {}),
      }))
      try {
        if (hasBodyError) await expect(drain(iterator)).rejects.toBe(bodyFailure)
        else {
          let item = await iterator.next()
          while (item.done === false && item.value.type !== 'assistant') item = await iterator.next()
          expect(item.done).toBe(false)
          await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined })
        }
        expect(modelCalls).toHaveLength(1)
        expect(coreClosed).toBe(1)
        expect(events.filter(event => event.event === 'turn.complete')).toHaveLength(1)
        expect(events.find(event => event.event === 'turn.complete')!.input.reason).toBe(hasBodyError ? 'error' : 'aborted')
        expect(runtime.currentTurn(modelCalls[0]!.options.agentId)).toBeUndefined()
        expect(leases.map(lease => lease.released)).toEqual([1, 1])
      } finally { await iterator.return(undefined).catch(() => {}) }
    }, 10_000)
  }

  test('[PM1 close trace] actual query return yields its converted cleanup error before releasing its snapshot', async () => {
    const runtime = await makeRuntime(), events: TurnEvent[] = []
    observeTurns(runtime, events)
    const leases = observeLeases(runtime), context = makeContext(runtime)
    context.agentId = asAgentId(randomUUID())
    const owner = runtime.beginAgentTurn(context.agentId)!
    const closeFailure = new Error('PM1_TRACE_CORE_CLOSE')
    script = async function* () { try { yield response('pm1-trace-close') } finally { await Promise.reject(closeFailure) } }
    const iterator = query({ messages: [createUserMessage({ content: 'finite query close trace' })],
      systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext: context, querySource: 'agent:custom',
    })
    try {
      let item = await iterator.next(), pulls = 1
      while (item.done === false && item.value.type !== 'assistant' && pulls++ < 20) item = await iterator.next()
      expect(item.done).toBe(false)
      const firstReturn = await iterator.return(undefined)
      expect(firstReturn.done).toBe(false)
      if (firstReturn.done === true) throw new Error('Expected actual query cleanup conversion before release')
      expect(firstReturn.value.type).toBe('assistant')
      if (firstReturn.value.type !== 'assistant') throw new Error('Expected query cleanup API error')
      expect(firstReturn.value.isApiErrorMessage).toBe(true)
      expect(JSON.stringify(firstReturn.value.message.content)).toContain(closeFailure.message)
      expect(coreClosed).toBe(1)
      expect(leases.map(lease => lease.released)).toEqual([0])
      const secondReturn = await iterator.return(undefined)
      expect(secondReturn.done).toBe(true)
      expect(leases.map(lease => lease.released)).toEqual([1])
      process.stdout.write(`PM1 close trace ${JSON.stringify({ firstDone: firstReturn.done, firstAPIError: firstReturn.value.isApiErrorMessage,
        secondDone: secondReturn.done, coreClosed, leaseReleased: leases[0]!.released })}\n`)
    } finally { await iterator.return(undefined).catch(() => {}); owner.release() }
  }, 10_000)

  // Fixed 289's actual QueryLoop sa consumer also ignores provider return
  // cleanup rejection, even without a turn registry. Body errors remain primary.
  for (const hasBodyError of [false, true]) {
    test(`[PM1 direct close postfix] unregistered real provider preserves the ${hasBodyError ? 'body error' : 'normal return'}`, async () => {
      const runtime = await makeRuntime()
      const leases = observeLeases(runtime)
      let admissions = 0
      const beginAgentTurn = runtime.beginAgentTurn
      runtime.beginAgentTurn = agentId => {
        const owner = beginAgentTurn(agentId)
        if (owner) admissions++
        return owner
      }
      const bodyFailure = new Error('PM1_DIRECT_BODY_PRIMARY'), closeFailure = new Error('PM1_DIRECT_CORE_CLOSE')
      script = async function* () { try { yield response('pm1-direct-close-error') } finally { await Promise.reject(closeFailure) } }
      const iterator = runAgent(params(runtime, {
        ...(hasBodyError ? { onQueryProgress() { if (modelCalls.length > 0 && coreClosed === 0) throw bodyFailure } } : {}),
      }))
      try {
        if (hasBodyError) await expect(drain(iterator)).rejects.toBe(bodyFailure)
        else {
          let item = await iterator.next()
          while (item.done === false && item.value.type !== 'assistant') item = await iterator.next()
          expect(item.done).toBe(false)
          await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined })
        }
        expect(modelCalls).toHaveLength(1)
        expect(coreClosed).toBe(1)
        expect(runtime.currentTurn(modelCalls[0]!.options.agentId)).toBeUndefined()
        expect(admissions).toBe(0)
        expect(leases.flatMap(lease => lease.events)).toEqual([])
        expect(leases.map(lease => lease.released)).toEqual([1])
      } finally { await iterator.return(undefined).catch(() => {}) }
    }, 10_000)
  }

  for (const retirement of ['session-change','dispose'] as const) {
    test(`[PM1 lifetime postfix] a real pending runAgent cannot dispatch completion through a retired ${retirement} owner`, async () => {
      const runtime=await makeRuntime(),events:TurnEvent[]=[]
      const leases=observeLeases(runtime)
      observeTurns(runtime,events)
      const entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>()
      script=async function* (){entered.resolve();await resume.promise;yield response('pm1-retired-owner')}
      const options=params(runtime),iterator=runAgent(options)
      const pending=drain(iterator)
      void pending.catch(()=>{})
      let disposal:Promise<void>|undefined
      try {
        await Promise.race([entered.promise,pending.then(()=>{throw new Error('runAgent ended before the bounded provider boundary')})])
        const agentId=modelCalls[0]!.options.agentId!
        const owner=runtime.currentTurn(agentId)
        expect(owner).toBeDefined()
        expect(events.map(event=>event.event)).toEqual(['turn.step'])
        if(retirement==='session-change')await runtime.bind({cwd:project,sessionId:'pm1-retired-new-session',surface:null,isInteractive:false})
        else disposal=runtime.dispose()
        expect(runtime.currentTurn(agentId)).toBeUndefined()
        resume.resolve()
        await pending
        await disposal
        expect(modelCalls).toHaveLength(1)
        expect(coreClosed).toBe(1)
        expect(events.map(event=>event.event)).toEqual(['turn.step'])
        expect(runtime.currentTurn(agentId)).toBeUndefined()
        expect(leases.every(lease=>lease.released===1)).toBe(true)
        expect(await owner!.finish({aborted:false,failed:false})).toBeUndefined()
        expect(events.map(event=>event.event)).toEqual(['turn.step'])
      } finally {
        resume.resolve();options.toolUseContext.abortController.abort()
        await pending.catch(()=>{});await iterator.return(undefined);await disposal
      }
    },10_000)
  }

  test('[PM1 actual fork] author completion invokes the real internal fork after the main registry is released', async () => {
    const runtime = await makeRuntime()
    stopOverflow = () => runtime.dispose()
    const leases = observeLeases(runtime)
    const independentEvents: TurnEvent[] = []
    observeTurns(runtime, independentEvents, undefined, 'prepend')
    const entry = join(fixture, 'completion-fork.ts')
    await writeFile(entry, `let events=[],receipt;
      export function register(on) {
        on('turn.start',($,e,next)=>{events.push({event:'start',turnId:e.turnId});return next(e);});
        on('turn.step',async function* ($,e,next){events.push({event:'step',turnId:e.turnId,agentId:e.agentId});
          const stream=next(e);for await(const chunk of stream)yield chunk;return await stream.result;});
        on('turn.complete',async ($,e,next)=>{events.push({event:'complete',turnId:e.turnId,agentId:e.agentId});
          receipt=await $.model.fork({prompt:'finite internal completion fork'});return next(e);});
        on('tool.call',()=>({result:{events,receipt}}));
      }`)
    await runtime.reconcile([{name:'pm1-completion-fork',storageId:'pm1-completion-fork@inline',pluginRoot:fixture,entrypoints:[entry]}])
    coreLimit = 2
    const parentIds: Array<string | undefined> = [], matchingTurns: unknown[] = []
    script = async function* (input) {
      parentIds.push(runtime.activePublicTurnId)
      matchingTurns.push(runtime.currentTurn(input.options.agentId))
      if (input.options.querySource === 'hook_prompt')
        yield {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:2}}}
      yield response(input.options.querySource === 'hook_prompt' ? 'pm1-internal-fork' : 'pm1-parent')
    }
    const context = makeContext(runtime)
    const iterator = query({messages:[createUserMessage({content:'public parent completion'})],
      systemPrompt:asSystemPrompt(['REAL_PARENT_SYSTEM']),userContext:{project:'REAL_PARENT_CONTEXT'},systemContext:{},
      toolUseContext:context,canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:'sdk',
      publicTurn:{text:'public parent completion'}})
    try {
      const messages: unknown[] = []
      while (true) {const item=await iterator.next();if(item.done)break;messages.push(item.value)}
      expect(modelCalls).toHaveLength(2)
      expect(rejectedOverflow).toBe(0)
      expect(coreClosed).toBe(2)
      expect(modelCalls.map(call=>call.options.querySource)).toEqual(['sdk','hook_prompt'])
      expect(modelCalls[0]!.options.agentId).toBeUndefined()
      expect(modelCalls[1]!.options.agentId).toEqual(expect.any(String))
      expect(parentIds[0]).toEqual(expect.any(String))
      expect(parentIds[1]).toBeUndefined()
      expect(matchingTurns[0]).toBeDefined()
      expect(matchingTurns[1]).toBeUndefined()
      expect(modelCalls[1]!.systemPrompt).toEqual(modelCalls[0]!.systemPrompt)
      expect(JSON.stringify(modelCalls[1]!.messages)).toContain('public parent completion')
      const probe=await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:{events:Array<{event:string;turnId:string;agentId?:string}>;receipt:unknown}}
      expect(probe.result.events.map(event=>event.event)).toEqual(['start','step','complete'])
      expect(probe.result.events.map(event=>event.turnId)).toEqual([parentIds[0],parentIds[0],parentIds[0]])
      expect(probe.result.events.every(event=>event.agentId===undefined)).toBe(true)
      expect(independentEvents.map(event=>event.event)).toEqual(['turn.start','turn.step','turn.complete'])
      expect(independentEvents.map(event=>event.input.turnId)).toEqual([parentIds[0],parentIds[0],parentIds[0]])
      expect(independentEvents.every(event=>event.input.agentId===undefined)).toBe(true)
      expect(independentEvents.filter(event=>event.input.agentId===modelCalls[1]!.options.agentId)).toEqual([])
      expect(probe.result.receipt).toEqual({isAnswered:true,text:'FINITE_AGENT_ANSWER',
        usage:{input_tokens:0,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}})
      expect(runtime.currentTurn()).toBeUndefined()
      expect(runtime.currentTurn(modelCalls[1]!.options.agentId)).toBeUndefined()
      expect(leases.every(lease=>lease.released===1)).toBe(true)
      expect(JSON.stringify(messages)).toContain('FINITE_AGENT_ANSWER')
    } finally {context.abortController.abort();await iterator.return({reason:'pm1-test-cleanup'})}
  }, 10_000)

  test('[PM1 actual fork] a real author hook-only agent step forks a genuinely cached main query without borrowing the agent owner', async () => {
    const runtime = await makeRuntime()
    stopOverflow = () => runtime.dispose()
    coreLimit = 2
    const warmContext = makeContext(runtime)
    const warm = query({messages:[createUserMessage({content:'genuine cache warmup'})],systemPrompt:asSystemPrompt(['REAL_WARMUP_SYSTEM']),
      userContext:{project:'REAL_WARMUP_CONTEXT'},systemContext:{},toolUseContext:warmContext,
      canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:'sdk',publicTurn:{text:'genuine cache warmup'}})
    try {while(!(await warm.next()).done) { /* The first real provider response produces the cache snapshot. */ }}
    finally {await warm.return({reason:'pm1-warmup-cleanup'})}
    expect(modelCalls).toHaveLength(1)
    expect(runtime.currentTurn()).toBeUndefined()
    const independentEvents: TurnEvent[] = []
    observeTurns(runtime, independentEvents, undefined, 'prepend')
    const leases = observeLeases(runtime)
    const entry = join(fixture,'step-fork.ts')
    await writeFile(entry, `let events=[],receipt;
      export function register(on) {
        on('turn.step',async function* ($,e){events.push({event:'step',turnId:e.turnId,agentId:e.agentId});
          receipt=await $.model.fork({prompt:'finite internal step fork'});
          if(!receipt.isAnswered)throw new Error('real cached fork did not answer');
          yield {kind:'text',index:0,text:receipt.text};yield {kind:'stop',stopReason:'end_turn',usage:null};
          return {turnId:e.turnId,index:e.index,answer:receipt.text,toolUses:[],stopReason:'end_turn',usage:null};});
        on('turn.complete',($,e,next)=>{events.push({event:'complete',turnId:e.turnId,agentId:e.agentId});return next(e);});
        on('tool.call',()=>({result:{events,receipt}}));
      }`)
    await runtime.reconcile([{name:'pm1-step-fork',storageId:'pm1-step-fork@inline',pluginRoot:fixture,entrypoints:[entry]}])
    const agentId=asAgentId('pm1-real-hook-only-agent')
    const observations: Array<{main:unknown;parent:unknown;matching:unknown}> = []
    script=async function* (input){
      observations.push({main:runtime.currentTurn(),parent:runtime.currentTurn(agentId),matching:runtime.currentTurn(input.options.agentId)})
      yield {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:2}}}
      yield response('pm1-step-internal-fork')
    }
    const options=params(runtime)
    const messages=await drain(runAgent({...options,override:{...options.override,agentId}}))
    expect(modelCalls).toHaveLength(2)
      expect(rejectedOverflow).toBe(0)
    expect(coreClosed).toBe(2)
    expect(modelCalls.map(call=>call.options.querySource)).toEqual(['sdk','hook_prompt'])
    expect(modelCalls[1]!.options.agentId).toEqual(expect.any(String))
    expect(modelCalls[1]!.options.agentId).not.toBe(agentId)
    expect(observations).toHaveLength(1)
    expect(observations[0]!.main).toBeUndefined()
    expect(observations[0]!.parent).toBeDefined()
    expect(observations[0]!.matching).toBeUndefined()
    expect(modelCalls[1]!.systemPrompt).toEqual(modelCalls[0]!.systemPrompt)
    expect(JSON.stringify(modelCalls[1]!.messages)).toContain('genuine cache warmup')
    const probe=await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:{events:Array<{event:string;turnId:string;agentId?:string}>;receipt:unknown}}
    expect(probe.result.events.map(event=>event.event)).toEqual(['step','complete'])
    expect(probe.result.events.map(event=>event.agentId)).toEqual([agentId,agentId])
    expect(probe.result.events[0]!.turnId).toBe(probe.result.events[1]!.turnId)
    expect(independentEvents.map(event=>event.event)).toEqual(['turn.step','turn.complete'])
    expect(independentEvents.map(event=>event.input.agentId)).toEqual([agentId,agentId])
    expect(independentEvents.map(event=>event.input.turnId)).toEqual([probe.result.events[0]!.turnId,probe.result.events[0]!.turnId])
    expect(independentEvents.filter(event=>event.input.agentId===modelCalls[1]!.options.agentId)).toEqual([])
    expect(leases.every(lease=>lease.released===1)).toBe(true)
    expect(probe.result.receipt).toEqual({isAnswered:true,text:'FINITE_AGENT_ANSWER',
      usage:{input_tokens:0,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}})
    expect(messages.filter(message=>message.type==='assistant').flatMap(message=>message.message.content)).toEqual([{type:'text',text:'FINITE_AGENT_ANSWER'}])
    expect(runtime.currentTurn(agentId)).toBeUndefined()
    expect(runtime.currentTurn(modelCalls[1]!.options.agentId)).toBeUndefined()
  }, 10_000)

  test('[PM1 producer] cleanup isolated producer fixture', async () => {
    await flushSessionStorage()
    switchSession(previousSession, previousProject ?? undefined)
    if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
    resetGitFileWatcher()
    await rm(fixture, { recursive: true, force: true })
    console.log('PM1 actual producer suite finished')
  })
}
