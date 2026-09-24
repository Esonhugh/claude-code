import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { query, type QueryParams } from './query.js'
import type { Tool, ToolUseContext } from './Tool.js'
import { asAgentId } from './types/ids.js'
import type { AssistantMessage, Message } from './types/message.js'
import { createModsRuntime, type ModSnapshot } from './services/mods/runtime.js'
import { createAssistantMessage, normalizeMessagesForAPI } from './utils/messages.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'
import { createModTurnCompletion } from './services/mods/turnAdapter.js'
import { createSystemMessage, createCompactBoundaryMessage, createUserMessage } from './utils/messages.js'
import { prependUserContext } from './utils/api.js'
import { getUserContextInstructionFiles, withUserContextInstructionFiles } from './context.js'
import { reconcilePromptContext } from './services/mods/promptContext.js'

function response(id: string, text: string, input = 10, output = 2): AssistantMessage {
  const message = createAssistantMessage({ content: text })
  Object.assign(message.message, {
    id, model: 'claude-test', stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  })
  return message
}

function harness(callModel: NonNullable<QueryParams['deps']>['callModel']) {
  const calls: Array<{ event: string; input: any; result: any; options: any }> = []
  const order: string[] = []
  let rewrite: ((result: any, input: any) => any) | undefined
  let failure: Error | undefined
  const snapshot: ModSnapshot = {
    hasHooks: event => event === 'turn.complete',
    release: () => { order.push('release') },
    dispatch: async (event, input, core, options) => {
      order.push('dispatch')
      const call = { event, input, result: undefined as any, options }
      calls.push(call)
      if (failure) throw failure
      const result = await core(input)
      call.result = result
      const modified = rewrite ? rewrite(result, input) : result
      options?.validateResult?.(modified, [result])
      return modified
    },
  }
  let appState = getDefaultAppState()
  const context = {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-test', tools: [], verbose: false,
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState, setAppState: (update: any) => { appState = update(appState) },
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    messages: [],
    mods: { capture: () => { order.push('capture'); return snapshot }, hasHooks: snapshot.hasHooks },
  } as unknown as ToolUseContext
  let activeTurnId: string | undefined
  context.mods = {
    ...context.mods,
    beginPublicTurn(turnId: string) {
      activeTurnId = turnId
      return () => {
        if (activeTurnId === turnId) activeTurnId = undefined
      }
    },
    get activePublicTurnId() { return activeTurnId },
  } as unknown as ToolUseContext['mods']
  const params: QueryParams = {
    messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'answer' } }],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), toolUseContext: context,
    querySource: 'repl_main_thread',
    deps: { uuid: randomUUID, microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }), callModel },
  }
  return { params, context, snapshot, calls, order,
    rewrite: (fn: typeof rewrite) => { rewrite = fn }, fail: (error: Error) => { failure = error } }
}

async function drain(iterator: ReturnType<typeof query>) {
  const messages: any[] = []
  while (true) {
    const step = await iterator.next()
    if (step.done) return { messages, terminal: step.value }
    messages.push(step.value)
  }
}

// Exercise control completions with an injected loop, but execute the exact
// public wrapper from query.ts rather than reimplementing its lifecycle.
const source = readFileSync(new URL('./query.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('query.ts', source, ts.ScriptTarget.Latest, true)
const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'query')!
const wrapperJS = ts.transpileModule(wrapper.getText(ast).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
}).outputText
function isolatedWrapper(loop: (...args: any[]) => AsyncGenerator<any, any>, diagnostics: any[], lifecycle: any[]) {
  return new Function('scope', `with (scope) { ${wrapperJS}; return query; }`)({
    queryLoop: loop, createModTurnCompletion, randomUUID, createSystemMessage,
    notifyCommandLifecycle: (...args: any[]) => lifecycle.push(args),
    logError: (error: any) => diagnostics.push(error), logForDebugging: (text: string) => diagnostics.push(text),
  }) as typeof query
}

afterEach(resetStateForTests)

describe('public query prompt.context', () => {
  test('context rendering preserves ordered numeric names and omits empty snapshots', () => {
    const original = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      const input: Message[] = [createSystemMessage('unchanged', 'info')]
      const rendered = prependUserContext(input, [{name:'9',text:'first'},{name:'2',text:'second'}])
      expect(rendered[0]?.type).toBe('user')
      expect((rendered[0] as any).message.content).toContain('# 9\nfirst\n# 2\nsecond')
      expect(rendered[1]).toBe(input[0])
      expect(prependUserContext(input, [])).toBe(input)
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
  test('renders ordered rewritten blocks once before the model without running classic prompt hooks', async () => {
    const requests: any[] = []
    const h = harness(async function* (request) {
      requests.push(request)
      yield response('context', 'answer')
    })
    const events: string[] = []
    let released = 0
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context',
        release: () => { released++ },
        dispatch: async (event: string, input: any, _core: any, options: any) => {
          events.push(event)
          expect(input).toEqual({blocks:[{name:'claudeMd',text:'private instruction'},{name:'currentDate',text:'today'}]})
          const result = {blocks:[{name:'9',text:'first'},{name:'2',text:'second'},{name:'currentDate',text:'changed'}]}
          options.validateResult(result, [])
          return result
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.userContext = {claudeMd:'private instruction', currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext).toEqual({'9':'first','2':'second',currentDate:'changed'})
      return {messages, wasCompacted:false}
    }
    await drain(query(h.params))
    expect(events).toEqual(['prompt.context'])
    expect(released).toBe(1)
    expect(requests).toHaveLength(1)
    expect(h.params.userContext).toEqual({claudeMd:'private instruction',currentDate:'today'})
  })
})

describe('public query turn lifecycle', () => {
  test('dispatches main turn.start before the loop and shares its identity with turn.complete', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.params.publicTurn = { text: 'hello' }

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.start', 'turn.complete'])
    expect(h.calls[0]!.input.text).toBe('hello')
    expect(h.calls[0]!.result).toEqual({ turnId: h.calls[0]!.input.turnId })
    expect(h.calls[0]!.input.turnId).toBe(h.calls[1]!.input.turnId)
  })

  test('publishes the public turn id only while the query is in flight', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness(async function* () {
      entered.resolve()
      await release.promise
      yield response('one', 'answer')
    })
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }

    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    const running = drain(query(h.params))
    try {
      await entered.promise
      expect(h.context.mods?.activePublicTurnId).toBe(h.calls[0]!.input.turnId)
    } finally {
      release.resolve()
      await running
    }
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
  })

  test('keeps the public turn visible while start and completion hooks are pending', async () => {
    const startEntered = Promise.withResolvers<void>()
    const startRelease = Promise.withResolvers<void>()
    const completeEntered = Promise.withResolvers<void>()
    const completeRelease = Promise.withResolvers<void>()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.params.publicTurn = { text: 'hello' }
    const dispatch = h.snapshot.dispatch
    const ids: string[] = []
    h.snapshot.dispatch = async (event, input, core, options) => {
      ids.push(input.turnId as string)
      if (event === 'turn.start') {
        startEntered.resolve()
        await startRelease.promise
      } else {
        completeEntered.resolve()
        await completeRelease.promise
      }
      return dispatch(event, input, core, options)
    }
    const running = drain(query(h.params))
    try {
      await startEntered.promise
      expect(h.context.mods?.activePublicTurnId).toBe(ids[0])
      startRelease.resolve()
      await completeEntered.promise
      expect(ids[1]).toBe(ids[0])
      expect(h.context.mods?.activePublicTurnId).toBe(ids[1])
    } finally {
      startRelease.resolve()
      completeRelease.resolve()
      await running
    }
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
  })

  test('real runtime tracks public turns without any lifecycle hooks', async () => {
    const runtime = createModsRuntime()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.context.mods = runtime
    h.params.publicTurn = { text: 'hello' }
    const iterator = query(h.params)
    try {
      expect(runtime.activePublicTurnId).toBeUndefined()
      expect((await iterator.next()).done).toBe(false)
      expect(runtime.activePublicTurnId).toEqual(expect.any(String))
      await drain(iterator)
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      await runtime.dispose()
    }
  })

  test('closing an older query does not clear a newer public turn on the same runtime', async () => {
    const runtime = createModsRuntime()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.context.mods = runtime
    h.params.publicTurn = { text: 'hello' }
    const older = query(h.params)
    const newer = query(h.params)
    try {
      await older.next()
      const olderId = runtime.activePublicTurnId
      expect(olderId).toEqual(expect.any(String))
      await newer.next()
      const newerId = runtime.activePublicTurnId
      expect(newerId).toEqual(expect.any(String))
      expect(newerId).not.toBe(olderId)
      await older.return({ reason: 'consumer-return' })
      expect(runtime.activePublicTurnId).toBe(newerId)
      await newer.return({ reason: 'consumer-return' })
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      await older.return({ reason: 'consumer-return' })
      await newer.return({ reason: 'consumer-return' })
      await runtime.dispose()
    }
  })

  test('releases a start-only snapshot after the query', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.start'])
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('releases a start-only snapshot when turn.start fails', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    const error = new Error('turn.start failed')
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }
    h.fail(error)
    const dispatch = h.snapshot.dispatch
    h.snapshot.dispatch = (event, input, core, options) => {
      expect(h.context.mods?.activePublicTurnId).toBe(input.turnId as string)
      return dispatch(event, input, core, options)
    }

    await expect(drain(query(h.params))).rejects.toBe(error)

    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('does not dispatch turn.start without an explicit public turn', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.complete'])
  })

  for (const event of ['tool.list', 'tool.describe'] as const) {
    test(`keeps a ${event}-only snapshot through the model request and releases it once`, async () => {
      let received: ModSnapshot | undefined
      const h = harness(async function* ({ options }) {
        received = options.modsSnapshot
        yield response('one', 'answer')
      })
      h.snapshot.hasHooks = name => name === event

      await drain(query(h.params))

      expect(received).toBe(h.snapshot)
      expect(h.calls).toEqual([])
      expect(h.order).toEqual(['capture', 'release'])
    })
  }

  test('releases a catalog-only snapshot when the query fails', async () => {
    const h = harness(async function* () {})
    const error = new Error('microcompact failed')
    h.snapshot.hasHooks = event => event === 'tool.describe'
    h.params.deps!.microcompact = async () => { throw error }

    await expect(drain(query(h.params))).rejects.toBe(error)

    expect(h.order).toEqual(['capture', 'release'])
  })

  test('normal completion uses the final response, updated usage and real duration once', async () => {
    const h = harness(async function* () {
      const first = response('one', 'first', 10, 0)
      yield first
      first.message.usage.output_tokens = 7
      const second = response('two', 'final', 20, 0)
      yield second
      second.message.usage.output_tokens = 11
      await Bun.sleep(12)
    })
    h.context.queryTracking = { chainId: 'analytics-chain', depth: 0 }
    const run = await drain(query(h.params))
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(h.calls).toHaveLength(1)
    const { input, result, options } = h.calls[0]!
    expect(input).toMatchObject({ answer: 'final', isAborted: false, reason: 'answer' })
    expect(input.turnId).not.toBe('analytics-chain')
    expect(input).not.toHaveProperty('agentId')
    expect(input).not.toHaveProperty('refusal')
    expect(input.durationMs).toBeGreaterThanOrEqual(10)
    expect(input.usage).toEqual({ model: 'claude-test', input_tokens: 30, output_tokens: 18, cache_read_input_tokens: 6, cache_creation_input_tokens: 8 })
    expect(result).toEqual({ text: 'final', usage: input.usage })
    expect(options.signal).toBeUndefined()
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('same response blocks accumulate, repeated snapshots replace instead of append', async () => {
    const h = harness(async function* () {
      const first = response('one', 'A')
      yield first
      yield { ...first, message: { ...first.message, content: [{ type: 'text', text: 'AB' }] } }
      yield response('one', 'C')
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } }
    })
    await drain(query(h.params))
    expect(h.calls[0]?.input.answer).toBe('ABC')
    expect(h.calls[0]?.input.usage.output_tokens).toBe(9)
    expect(h.calls[0]?.input.usage.input_tokens).toBe(10)
  })

  test('main-loop rewrite is a UI system message, never an API assistant answer', async () => {
    const original = response('one', 'real answer')
    const h = harness(async function* () { yield original })
    h.rewrite(result => ({ ...result, text: 'hook annotation' }))
    const run = await drain(query(h.params))
    const added = run.messages.filter(message => message.type === 'system' && message.content === 'hook annotation')
    expect(added).toHaveLength(1)
    expect(normalizeMessagesForAPI([added[0]] as Message[], [])).toEqual([])
    expect(original.message.content[0]?.text).toBe('real answer')
    expect(run.terminal).toEqual({ reason: 'completed' })
  })

  test('subagent completion carries agent identity and does not display a rewrite', async () => {
    const h = harness(async function* () { yield response('one', 'child answer') })
    h.context.agentId = 'child-agent' as ToolUseContext['agentId']
    h.rewrite(result => ({ ...result, text: 'not for main UI' }))
    const run = await drain(query(h.params))
    expect(h.calls[0]?.input.agentId).toBe('child-agent')
    expect(run.messages.some(message => message.content === 'not for main UI')).toBe(false)
    expect(run.terminal).toEqual({ reason: 'completed' })
  })

  test.each([false, true])('subagents never replace the public turn, even with publicTurn=%s', async publicTurn => {
    const h = harness(async function* () { yield response('one', 'child answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.context.agentId = 'child-agent' as ToolUseContext['agentId']
    if (publicTurn) h.params.publicTurn = { text: 'inherited prompt' }
    const end = h.context.mods!.beginPublicTurn('parent-turn')
    const iterator = query(h.params)
    try {
      await iterator.next()
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      await drain(iterator)
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      expect(h.calls.map(call => call.event)).toEqual(['turn.complete'])
      expect(h.calls[0]!.input.turnId).not.toBe('parent-turn')
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      end()
    }
  })

  test('queries without an explicit public turn do not replace an existing public turn', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    const end = h.context.mods!.beginPublicTurn('parent-turn')
    const iterator = query(h.params)
    try {
      await iterator.next()
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      await drain(iterator)
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      end()
    }
  })

  test('abort dispatches without the cancelled query signal and releases afterwards', async () => {
    const h = harness(async function* () {
      expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
      yield response('one', 'partial')
      h.context.abortController.abort('interrupt')
    })
    h.params.publicTurn = { text: 'hello' }
    await drain(query(h.params))
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'aborted', isAborted: true, answer: 'partial' })
    expect(h.calls[0]?.options.signal).toBeUndefined()
    expect(h.order.at(-1)).toBe('release')
  })

  test('consumer return finalizes once without yielding a cleanup message', async () => {
    const h = harness(async function* () { yield response('one', 'unfinished') })
    h.params.publicTurn = { text: 'hello' }
    h.rewrite(() => ({ text: 'must not keep iterator alive' }))
    const iterator = query(h.params)
    let step = await iterator.next()
    while (!step.done && step.value.type !== 'assistant') step = await iterator.next()
    expect(step.done).toBe(false)
    expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
    expect(await iterator.return({ reason: 'consumer-return' })).toEqual({ done: true, value: { reason: 'consumer-return' } })
    await iterator.return({ reason: 'again' })
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'aborted', isAborted: true, answer: 'unfinished' })
    expect(h.order.at(-1)).toBe('release')
  })

  test('uncaught query failure still finalizes', async () => {
    const h = harness(async function* () {})
    const error = new Error('microcompact failed')
    h.params.publicTurn = { text: 'hello' }
    h.params.deps!.microcompact = async () => {
      expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
      throw error
    }
    await expect(drain(query(h.params))).rejects.toBe(error)
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'error', isAborted: false, answer: '' })
    expect(h.order.at(-1)).toBe('release')
  })

  test('turn identity stays separate from analytics tracking and is fresh for each public query', async () => {
    const analyticsIds: string[] = []
    const h = harness(async function* ({ options }) {
      analyticsIds.push(options.queryTracking!.chainId)
      yield response(randomUUID(), 'answer')
    })
    await drain(query(h.params))
    await drain(query(h.params))
    const turnIds = h.calls.map(call => call.input.turnId)
    expect(turnIds[0]).not.toBe(turnIds[1])
    expect(analyticsIds[0]).not.toBe(analyticsIds[1])
    expect(turnIds).not.toEqual(analyticsIds)
    expect(h.context.queryTracking).toBeUndefined()
  })

  test('refusal derives only from the API stop reason, with null unsupplied metadata', async () => {
    const h = harness(async function* () {
      const message = response('refused', 'No')
      message.message.stop_reason = 'refusal'
      yield message
    })
    await drain(query(h.params))
    expect(h.calls[0]?.input).toMatchObject({ reason: 'refusal', refusal: { category: null, explanation: null } })
  })

  test('synthetic API errors do not fabricate response usage or refusal metadata', async () => {
    const h = harness(async function* () {
      yield {type:'stream_event', event:{type:'ping'}}
      throw new Error('API unavailable')
    })
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('model_error')
    expect(h.calls[0]?.input.reason).toBe('error')
    expect(h.calls[0]?.input).not.toHaveProperty('usage')
    expect(h.calls[0]?.input).not.toHaveProperty('refusal')
  })
})

test('mid-turn drain preserves admitted context and never injects a core-refused prompt', async () => {
  const { enqueue, getCommandQueue, resetCommandQueue } = await import('./utils/messageQueueManager.js')
  const { createUserMessage } = await import('./utils/messages.js')
  const { createAttachmentMessage } = await import('./utils/attachments.js')
  const admitted = [
    createUserMessage({ content: '/rewritten-as-text' }),
    createAttachmentMessage({ type: 'hook_additional_context', content: ['retained admission context'], hookName: 'prompt.submit', toolUseID: 'hook-admitted', hookEvent: 'UserPromptSubmit' }),
  ]
  const requests: any[] = []
  const h = harness(async function* (request) {
    requests.push(request)
    if (requests.length === 1) {
      enqueue({ value: 'raw input must not return', mode: 'prompt', admitted: {
        messages: admitted, shouldQuery: true, admission: { text: '/rewritten-as-text' },
      } })
      enqueue({ value: 'refused prompt', mode: 'prompt', admitted: {
        messages: [createUserMessage({ content: 'refused prompt' })], shouldQuery: false,
        admission: { drop: 'stopped by core' },
      } })
      yield createAssistantMessage({ content: [{ type: 'tool_use', caller: { type: 'direct' }, id: 'fixture-call', name: 'UnavailableFixture', input: {} }] })
    } else yield response('done', 'answer')
  })
  try {
    const run = await drain(query(h.params))
    expect(requests).toHaveLength(2)
    expect(run.messages).toContainEqual(admitted[0])
    expect(run.messages).toContainEqual(admitted[1])
    expect(JSON.stringify(requests[1].messages)).toContain('retained admission context')
    expect(JSON.stringify(requests[1].messages)).not.toContain('raw input must not return')
    expect(JSON.stringify(requests[1].messages)).not.toContain('refused prompt')
    expect(getCommandQueue().map(command => command.value)).toEqual(['refused prompt'])
  } finally {
    resetCommandQueue()
  }
})

test('model request catalogs follow refreshed tools between query iterations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-catalog-refresh-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('tool.describe', ($, e) => ({description:e.description}));
      on('tool.call', async ($) => ({result:await $.tool.list()}));
    }`)
    await runtime.reconcile([{name:'catalog-refresh',storageId:'catalog-refresh@inline',pluginRoot:root,entrypoints:[entry]}])
    const { z } = await import('zod/v4')
    const makeTool = (name: string) => ({
      name,inputSchema:z.object({}),inputJSONSchema:{type:'object',properties:{}},
      prompt:async () => name,maxResultSizeChars:Infinity,isConcurrencySafe:()=>false,
      mapToolResultToToolResultBlockParam:(data: unknown,id:string)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),
    }) as unknown as Tool
    const first = makeTool('InitialCatalog')
    const refreshed = makeTool('RefreshedCatalog')
    const catalogs: unknown[] = []
    const h = harness(async function* (request) {
      catalogs.push(await request.options.modsSnapshot!.dispatch('tool.call',{tool:'catalog'},async()=>({result:'unexpected'})))
      if (catalogs.length === 1) {
        yield createAssistantMessage({content:[{type:'tool_use',caller:{type:'direct'},id:'catalog-refresh-call',name:first.name,input:{}}]})
      } else yield response('catalog-done','answer')
    })
    h.context.mods = runtime
    h.context.options.tools = [first]
    h.context.options.refreshTools = () => [refreshed]
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(catalogs).toEqual([
      {result:[{name:first.name,description:first.name,mcp:false}]},
      {result:[{name:refreshed.name,description:refreshed.name,mcp:false}]},
    ])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('model requests receive a catalog-bound Mods snapshot even without turn lifecycle hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-catalog-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('tool.describe', ($, e) => ({description:e.description+' projected'}));
      on('tool.call', async ($) => ({result:await $.tool.list()}));
    }`)
    await runtime.reconcile([{name:'catalog-query',storageId:'catalog-query@inline',pluginRoot:root,entrypoints:[entry]}])
    const retained: ModSnapshot[] = []
    let requests = 0
    const h = harness(async function* (request) {
      requests++
      const snapshot = request.options.modsSnapshot!
      expect(snapshot).toBeDefined()
      retained.push(snapshot)
      expect(await snapshot.dispatch('tool.call', {tool:'catalog'}, async () => ({result:'unexpected'}))).toEqual({
        result:[{name:'CatalogProbe',description:'Original catalog description',mcp:false}],
      })
      yield response('catalog','answer')
    })
    h.context.options.tools = [{name:'CatalogProbe',inputJSONSchema:{type:'object',properties:{}},prompt:async () => 'Original catalog description'} as unknown as Tool]
    h.context.mods = runtime
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(requests).toBe(1)
    expect(retained).toHaveLength(1)
    await expect(retained[0]!.dispatch('tool.list', {}, async () => ({value:[]}))).rejects.toThrow('snapshot released')
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker prompt.context runs once for a snapshot across model recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const value = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...value.blocks, {name:'plugin',text:'extra'}]};
      });
    }`)
    await runtime.reconcile([{name:'context-query',storageId:'context-query@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('prompt.context')).toBe(true)
    const observed: any[] = []
    const dispatch = runtime.capture
    runtime.capture = () => {
      const snapshot = dispatch()
      return {...snapshot, dispatch: async (event, input, core, options) => {
        const result = await snapshot.dispatch(event,input,core,options)
        if (event === 'prompt.context') observed.push(result)
        return result
      }}
    }
    let requests = 0
    const h = harness(async function* () {
      requests++
      if (requests === 1) {
        const exhausted = response('limit','partial')
        Object.assign(exhausted, {apiError:'max_output_tokens', isApiErrorMessage:true})
        yield exhausted
      } else yield response('one','answer')
    })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    await drain(query(h.params))
    expect(requests).toBe(2)
    expect(observed).toEqual([{blocks:[{name:'currentDate',text:'today'},{name:'plugin',text:'extra'}]}])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker rejects duplicate context names and keeps the completed inner rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-invalid-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const result = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...result.blocks, {name:'currentDate',text:'duplicate'}]};
      });
    }`)
    await runtime.reconcile([{name:'invalid-context',storageId:'invalid-context@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    let models = 0
    let compactions = 0
    const h = harness(async function* () { models++; yield response('one','answer') })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      compactions++
      expect(forkContext.userContext).toEqual({currentDate:'today'})
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    expect(models).toBe(1)
    expect(compactions).toBe(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({message:expect.stringContaining('unique named text blocks')})
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real runtime wiring: Worker turn.complete rewrite reaches the public query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-turn-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        return { ...result, text: 'runtime annotation' };
      });
    }`)
    await runtime.reconcile([{ name: 'turn-query', storageId: 'turn-query@inline', pluginRoot: root, entrypoints: [entry] }])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('turn.complete')).toBe(true)
    const h = harness(async function* () { yield response('one', 'real answer') })
    h.context.mods = runtime
    const run = await drain(query(h.params))
    expect(diagnostics).toEqual([])
    expect(run.messages.some(message => message.type === 'system' && message.content === 'runtime annotation')).toBe(true)
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

for (const mode of ['none', 'no-hook', 'hook']) {
  for (const ending of ['return', 'throw', 'close']) {
    test(`actual wrapper preserves command lifecycle: ${mode}/${ending}`, async () => {
      const h = harness(async function* () {})
      if (mode === 'none') h.context.mods = undefined
      if (mode === 'no-hook') h.snapshot.hasHooks = () => false
      const lifecycle: any[] = []
      const diagnostics: any[] = []
      const original = new Error('query failure')
      const run = isolatedWrapper(async function* (_params, consumed) {
        consumed.push('command')
        lifecycle.push(['command', 'started'])
        yield { type: 'stream_request_start' }
        if (ending === 'throw') throw original
        return { reason: 'completed' }
      }, diagnostics, lifecycle)(h.params)
      await run.next()
      if (ending === 'throw') await expect(run.next()).rejects.toBe(original)
      else if (ending === 'close') await run.return({ reason: 'consumer' })
      else await run.next()
      expect(lifecycle).toEqual(ending === 'return'
        ? [['command', 'started'], ['command', 'completed']]
        : [['command', 'started']])
      expect(diagnostics).toEqual([])
      expect(h.calls).toHaveLength(mode === 'hook' ? 1 : 0)
      if (mode === 'hook') expect(h.calls[0]?.input.reason).toBe(
        ending === 'close' ? 'aborted' : ending === 'throw' ? 'error' : 'answer')
    })
  }
}

for (const ending of ['return', 'throw', 'close']) {
  test(`finalizer failure is diagnostic without overriding ${ending}`, async () => {
    const h = harness(async function* () {})
    h.params.publicTurn = { text: 'hello' }
    h.fail(new Error('dispatch failed'))
    const original = new Error('original failure')
    const diagnostics: any[] = []
    const run = isolatedWrapper(async function* () {
      yield { type: 'stream_request_start' }
      if (ending === 'throw') throw original
      return { reason: 'completed' }
    }, diagnostics, [])(h.params)
    await run.next()
    expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
    if (ending === 'throw') await expect(run.next()).rejects.toBe(original)
    else if (ending === 'close') expect(await run.return({ reason: 'consumer' })).toEqual({ done: true, value: { reason: 'consumer' } })
    else expect(await run.next()).toEqual({ done: true, value: { reason: 'completed' } })
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(diagnostics.some(value => String(value).includes('Mods turn.complete failed'))).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.order.at(-1)).toBe('release')
  })
}


test('mid-turn drain leaves an unadmitted plugin prompt in the host queue', async () => {
  const { enqueue, getCommandQueue, resetCommandQueue } = await import('./utils/messageQueueManager.js')
  const requests: any[] = []
  const h = harness(async function* (request) {
    requests.push(request)
    if (requests.length === 1) {
      enqueue({
        value: 'plugin follow-up must wait for admission',
        mode: 'prompt',
        priority: 'later',
        promptSubmitReceipt: { admit() {}, cancel() {} },
        promptSubmitMetadata: {
          origin: { kind: 'plugin', name: 'fixture' },
          wait: false,
        },
      })
      yield createAssistantMessage({ content: [{ type: 'tool_use', caller: { type: 'direct' }, id: 'fixture-call', name: 'UnavailableFixture', input: {} }] })
    } else yield response('done', 'answer')
  })
  try {
    await drain(query(h.params))
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).not.toContain('plugin follow-up must wait for admission')
    expect(getCommandQueue().map(command => command.value)).toEqual([
      'plugin follow-up must wait for admission',
    ])
  } finally {
    resetCommandQueue()
  }
})

test('hands the actual instruction snapshot to hooks and preserves replacement provenance for forks', async () => {
    const files = [{ path: '/fixture/CLAUDE.md', kind: 'project' as const, content: 'original marker' }]
    const original = reconcilePromptContext({ blocks: [], instructionFiles: files }, { blocks: [], instructionFiles: [] })
    const replacement = [{ ...files[0]!, content: 'replacement marker' }]
    const h = harness(async function* () { yield response('context-sources', 'answer') })
    h.params.userContext = withUserContextInstructionFiles(
      Object.fromEntries(original.blocks.map(block => [block.name, block.text])), files,
    )
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context', release() {},
        dispatch: async (_event: string, input: any, core: any, options: any) => {
          expect(input.instructionFiles).toEqual(files)
          const rewritten = options.restoreInput({ ...input, instructionFiles: replacement }, input)
          expect(rewritten.blocks[0].text).toContain('replacement marker')
          expect(rewritten.blocks[0].text).not.toContain('original marker')
          return core(rewritten)
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext.claudeMd).toContain('replacement marker')
      expect(getUserContextInstructionFiles(forkContext.userContext)).toEqual(replacement)
      return { messages, wasCompacted: false }
    }
    await drain(query(h.params))
    expect(getUserContextInstructionFiles(h.params.userContext)).toEqual(files)
  })

test('renders ordered rewritten blocks once before the model without running classic prompt hooks', async () => {
    const requests: any[] = []
    const h = harness(async function* (request) {
      requests.push(request)
      yield response('context', 'answer')
    })
    const events: string[] = []
    let released = 0
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context',
        release: () => { released++ },
        dispatch: async (event: string, input: any, _core: any, options: any) => {
          events.push(event)
          expect(input).toEqual({blocks:[{name:'claudeMd',text:'private instruction'},{name:'currentDate',text:'today'}]})
          const result = {blocks:[{name:'9',text:'first'},{name:'2',text:'second'},{name:'currentDate',text:'changed'}]}
          options.validateResult(result, [])
          return result
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.userContext = {claudeMd:'private instruction', currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext).toEqual({'9':'first','2':'second',currentDate:'changed'})
      return {messages, wasCompacted:false}
    }
    await drain(query(h.params))
    expect(events).toEqual(['prompt.context'])
    expect(released).toBe(1)
    expect(requests).toHaveLength(1)
    expect(h.params.userContext).toEqual({claudeMd:'private instruction',currentDate:'today'})
  })

for (const ending of ['return', 'throw', 'close', 'abort'] as const) {
  test(`prompt.context-only snapshot releases exactly once on ${ending}`, async () => {
    const h = harness(async function* () { yield response('context-only', 'answer') })
    h.snapshot.hasHooks = event => event === 'prompt.context'
    h.context.mods!.hasHooks = h.snapshot.hasHooks
    const error = new Error('context failed')
    if (ending === 'throw') h.fail(error)
    if (ending === 'abort') {
      h.snapshot.dispatch = async (_event, _input, _core, options) => {
        h.context.abortController.abort(error)
        options!.signal!.throwIfAborted()
      }
    }
    const iterator = query(h.params)
    if (ending === 'throw' || ending === 'abort') await expect(drain(iterator)).rejects.toBe(error)
    else if (ending === 'close') {
      await iterator.next()
      await iterator.return({ reason: 'consumer-return' })
    } else await drain(iterator)
    expect(h.order.filter(step => step === 'capture')).toHaveLength(1)
    expect(h.order.filter(step => step === 'release')).toHaveLength(1)
  })
}

test('real Worker caches context per input generation and invalidates through the saved engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-cache-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
      on('tool.call', async $ => {await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'context-cache',storageId:'context-cache@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string, string>[] = []
    const h = harness(async function* () { yield response('cached-context', 'answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    h.params.userContext = {date:'first'}
    await drain(query(h.params))
    h.params.userContext = {date:'changed but not invalidated'}
    await drain(query(h.params))
    h.context.agentId = asAgentId('child')
    h.params.userContext = {}
    await drain(query(h.params))
    await drain(query(h.params))
    expect(contexts).toEqual([
      {date:'first',calls:'1'}, {date:'changed but not invalidated',calls:'2'},
      {calls:'3'}, {calls:'3'},
    ])
    delete h.context.agentId
    expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:'invalidated'})
    h.params.userContext = {date:'refreshed'}
    await drain(query(h.params))
    h.context.agentId = asAgentId('child')
    h.params.userContext = {}
    await drain(query(h.params))
    expect(contexts).toEqual([
      {date:'first',calls:'1'}, {date:'changed but not invalidated',calls:'2'},
      {calls:'3'}, {calls:'3'},
      {date:'refreshed',calls:'4'}, {calls:'5'},
    ])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root, {recursive:true,force:true})
  }
})

test('context invalidation while a real Worker is pending cannot repopulate the cleared cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-pending-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  const release = Promise.withResolvers<void>()
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', async ($,e,next) => {
        const count=++calls;
        await next(e);
        return {blocks:[{name:'calls',text:String(count)}]};
      });
      on('tool.call', async $ => {await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'pending-context',storageId:'pending-context@inline',pluginRoot:root,entrypoints:[entry]}])
    const entered = Promise.withResolvers<void>()
    const capture = runtime.capture
    let first = true
    runtime.capture = services => {
      const snapshot = capture(services)
      return { ...snapshot, dispatch: (event, input, core, options) => snapshot.dispatch(event,input,async value => {
        if (event === 'prompt.context' && first) {
          first = false
          entered.resolve()
          await release.promise
        }
        return core(value)
      },options) }
    }
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('pending-context', 'answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    const pending = drain(query(h.params))
    await entered.promise
    try {
      expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toEqual({result:'invalidated'})
      await drain(query(h.params))
    } finally { release.resolve(); await pending }
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'2'},{calls:'1'},{calls:'2'}])
    expect(diagnostics).toEqual([])
  } finally {
    release.resolve()
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('context cache does not reuse a result for different explicit input', async () => {
  const h = harness(async function* () { yield response('context-input', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot, { promptContexts: new Map() })
  h.rewrite((_result, input) => ({ blocks: input.blocks }))
  const contexts: Record<string, string>[] = []
  h.params.deps!.autocompact = async (messages, _context, forkContext) => {
    contexts.push(forkContext.userContext)
    return { messages, wasCompacted: false }
  }

  h.params.userContext = { scenario: 'first' }
  await drain(query(h.params))
  h.params.userContext = { scenario: 'second' }
  await drain(query(h.params))

  expect(contexts).toEqual([{ scenario: 'first' }, { scenario: 'second' }])
  expect(h.calls.map(call => call.event)).toEqual(['prompt.context', 'prompt.context'])
})

test('context cache evicts failed work and never exposes its owned blocks to consumers', async () => {
  const h = harness(async function* () { yield response('cached', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  const cache = new Map()
  Object.assign(h.snapshot, {promptContexts:cache})
  const error = new Error('read failed')
  h.fail(error)
  await expect(drain(query(h.params))).rejects.toBe(error)
  expect(cache.size).toBe(0)
  h.fail(undefined)
  h.params.userContext = {context:'original'}
  const contexts: Record<string,string>[] = []
  h.params.deps!.autocompact = async (messages, _context, forkContext) => {
    contexts.push({...forkContext.userContext})
    forkContext.userContext.context = 'mutated by consumer'
    return {messages,wasCompacted:false}
  }
  await drain(query(h.params))
  await drain(query(h.params))
  expect(contexts).toEqual([{context:'original'},{context:'original'}])
  expect(h.calls.map(call=>call.event)).toEqual(['prompt.context','prompt.context'])
})

test('an aborted context-cache waiter releases without cancelling the query computing the context', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () { yield response('waiter', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot, {promptContexts:new Map()})
  const dispatch = h.snapshot.dispatch
  h.snapshot.dispatch = async (...args) => {
    entered.resolve()
    await release.promise
    return dispatch(...args)
  }
  const first = drain(query(h.params))
  await entered.promise
  const controller = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controller}}))
  const error = new Error('waiter cancelled')
  let settled = false
  const result = second.catch(reason => { settled = true; return reason })
  controller.abort(error)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await result).toBe(error)
    expect(h.order.filter(step=>step==='release')).toHaveLength(1)
    expect(h.context.abortController.signal.aborted).toBe(false)
  } finally {
    release.resolve()
    await first
    await result
  }
  expect(h.calls).toHaveLength(1)
  expect(h.order.filter(step=>step==='release')).toHaveLength(2)
})

test('cancelling the context computation owner does not fail another live query waiting for it', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('survivor','answer')})
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot,{promptContexts:new Map()})
  let reads = 0
  h.params.refreshUserContext = async () => {
    if (++reads === 1) { entered.resolve(); await release.promise }
    return {source:'fresh'}
  }
  const first = drain(query(h.params))
  await entered.promise
  const secondController = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:secondController}}))
  const error = new Error('context owner cancelled')
  const firstResult = first.catch(reason => reason)
  const secondResult = second.catch(reason => reason)
  h.context.abortController.abort(error)
  release.resolve()
  expect(await firstResult).toBe(error)
  expect(await secondResult).toMatchObject({terminal:{reason:'completed'}})
  expect(secondController.signal.aborted).toBe(false)
  expect(reads).toBe(2)
  expect(h.calls).toHaveLength(1)
  expect(h.order.filter(step=>step==='release')).toHaveLength(2)
})

test('a live context waiter retries without waiting for the cancelled owner read to settle', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('survivor','answer')})
  h.snapshot.hasHooks = event => event === 'prompt.context'
  const cache = new Map()
  Object.assign(h.snapshot,{promptContexts:cache})
  let reads = 0
  h.params.refreshUserContext = async () => {
    const read = ++reads
    if (read === 1) { entered.resolve(); await release.promise }
    return {source:`read-${read}`}
  }
  const first = drain(query(h.params)).catch(error => error)
  await entered.promise
  const ownerResult = cache.get(undefined).result.catch(() => {})
  const controller = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controller}}))
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error('live waiter is blocked on cancelled context read')), 1000)
  try {
    const reason = new Error('cancel raw context read')
    h.context.abortController.abort(reason)
    expect(await first).toBe(reason)
    expect(await Promise.race([second,deadline.promise])).toMatchObject({terminal:{reason:'completed'}})
    expect(reads).toBe(2)
    expect(h.calls).toHaveLength(1)
  } finally {
    clearTimeout(timer)
    release.resolve()
    await ownerResult
    await second
  }
  expect((await cache.get(undefined).result).blocks).toEqual([{name:'source',text:'read-2'}])
  expect(h.order.filter(step => step === 'release')).toHaveLength(2)
})

test('a live query recomputes context after the real Worker computation owner is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-owner-cancel-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  const entered = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const snapshots: ModSnapshot[] = []
  const releases: number[] = []
  const controllers = [new AbortController(), new AbortController()]
  const running: Promise<unknown>[] = []
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const call=++calls;
        const result=await next(e);
        return {blocks:[...result.blocks,{name:'calls',text:String(call)}]};
      });
    }`)
    await runtime.reconcile([{name:'owner-cancel',storageId:'owner-cancel@inline',pluginRoot:root,entrypoints:[entry]}])
    const capture = runtime.capture
    let coreCalls = 0
    runtime.capture = services => {
      const snapshot = capture(services)
      const index = snapshots.length
      snapshots.push(snapshot)
      return {
        ...snapshot,
        get promptContexts() {
          if (index === 1) waiting.resolve()
          return snapshot.promptContexts
        },
        dispatch: (event, input, core, options) => snapshot.dispatch(event, input, async (value, signal) => {
          if (event === 'prompt.context' && ++coreCalls === 1) {
            entered.resolve()
            await new Promise<void>(resolve => {
              const abort = () => { cancelled.resolve(); resolve() }
              signal!.addEventListener('abort', abort, {once:true})
              if (signal!.aborted) abort()
            })
            signal!.throwIfAborted()
          }
          return core(value, signal)
        }, options),
        release() { releases.push(index); snapshot.release() },
      }
    }
    let requests = 0
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { requests++; yield response('survivor', 'answer') })
    h.context.mods = runtime
    h.context.abortController = controllers[0]!
    let reads = 0
    h.params.refreshUserContext = async () => ({source:`read-${++reads}`})
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    const first = drain(query(h.params)).catch(error => error)
    running.push(first)
    await entered.promise
    const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controllers[1]!}}))
    running.push(second)
    await waiting.promise
    const reason = new Error('context owner cancelled')
    controllers[0]!.abort(reason)
    expect(await first).toBe(reason)
    await cancelled.promise
    expect(await second).toMatchObject({terminal:{reason:'completed'}})
    expect(contexts).toEqual([{source:'read-2',calls:'2'}])
    expect(requests).toBe(1)
    expect(reads).toBe(2)
    expect(coreCalls).toBe(2)
    expect(controllers[1]!.signal.aborted).toBe(false)
    expect(releases.toSorted()).toEqual([0,1])
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots)
      await expect(snapshot.dispatch('prompt.context', {}, async input => input)).rejects.toThrow('snapshot released')
    expect(diagnostics).toEqual([])
  } finally {
    for (const controller of controllers) controller.abort()
    await Promise.allSettled(running)
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('concurrent queries share the pending context reread as well as its hook dispatch', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('reread','answer')})
  h.snapshot.hasHooks = event=>event==='prompt.context'
  Object.assign(h.snapshot,{promptContexts:new Map()})
  let reads = 0
  h.params.refreshUserContext = async () => {
    reads++
    entered.resolve()
    await release.promise
    return {source:'fresh'}
  }
  const first = drain(query(h.params))
  await entered.promise
  const second = drain(query(h.params))
  release.resolve()
  await Promise.all([first,second])
  expect(reads).toBe(1)
  expect(h.calls).toHaveLength(1)
})

test('context cache follows session binding without resetting on an unchanged bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-binding-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', () => ({blocks:[{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'first'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'binding',storageId:'binding@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('binding','answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    delete h.context.agentId
    await runtime.bind({...binding})
    await drain(query(h.params))
    await runtime.bind({...binding,sessionId:'resumed'})
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'1'},{calls:'2'},{calls:'1'},{calls:'3'},{calls:'2'}])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('same-ID conversation restore invalidates main context without disturbing admitted queries or background agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-resume-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'same-id'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'resume',storageId:'resume@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('resume','answer') })
    h.context.mods = runtime
    h.params.userContext = {source:'original'}
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    delete h.context.agentId
    const previous = runtime.capture()
    try {
      runtime.invalidatePromptContext()
      await runtime.bind({...binding})
      h.params.userContext = {source:'restored'}
      await drain(query(h.params))
      h.context.agentId = asAgentId('background')
      await drain(query(h.params))
      expect(await previous.promptContexts!.get(undefined)!.result).toEqual({blocks:[
        {name:'source',text:'original'},{name:'calls',text:'1'},
      ],instructionFiles:[]})
      expect(contexts).toEqual([
        {source:'original',calls:'1'}, {source:'original',calls:'2'},
        {source:'restored',calls:'3'}, {source:'original',calls:'2'},
      ])
    } finally { previous.release() }
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('ending and rebinding the same conversation recomputes its context exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-ended-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', () => ({blocks:[{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'same-id'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'ended',storageId:'ended@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('ended','answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    await runtime.endSession('resume')
    await runtime.bind({...binding})
    await drain(query(h.params))
    await runtime.bind({...binding})
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'1'},{calls:'2'},{calls:'2'}])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('successful compaction rereads context before the same query sends its model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-compact-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
      on('tool.call',async $=>{await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'compact-context',storageId:'compact-context@inline',pluginRoot:root,entrypoints:[entry]}])
    const h = harness(async function* () {yield response('compact-context','answer')})
    h.context.mods = runtime
    h.params.userContext = {source:'old'}
    let refreshes = 0
    let source = 'old'
    Object.assign(h.params, {refreshUserContext:async()=>{refreshes++;return {source}}})
    let compact = false
    const boundary = createCompactBoundaryMessage('auto',100)
    const summary = createUserMessage({content:'summary'})
    const seen: Record<string,string>[] = []
    const captured: import('./utils/forkedAgent.js').CacheSafeParams[] = []
    const compactParams: import('./utils/forkedAgent.js').CacheSafeParams[] = []
    h.params.onCacheSafeParams = params => { captured.push(params) }
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      seen.push({...forkContext.userContext})
      compactParams.push(forkContext)
      if (!compact) return {messages,wasCompacted:false}
      compact = false
      source = 'reread'
      return {wasCompacted:true,compactionResult:{
        boundaryMarker:boundary,
        summaryMessages:[summary],attachments:[],hookResults:[],
      }}
    }
    await drain(query(h.params))
    expect(refreshes).toBe(1)
    compact = true
    await drain(query(h.params))
    expect(refreshes).toBe(2)
    h.params.messages = [boundary, summary]
    await drain(query(h.params))
    expect(seen).toEqual([
      {source:'old',calls:'1'}, {source:'old',calls:'1'}, {source:'reread',calls:'2'},
    ])
    expect(captured.map(params => params.userContext)).toEqual([
      {source:'old',calls:'1'}, {source:'reread',calls:'2'}, {source:'reread',calls:'2'},
    ])
    expect(compactParams.map(params => params.resolvedPromptContextBlocks)).toEqual([
      [{name:'source',text:'old'},{name:'calls',text:'1'}],
      [{name:'source',text:'old'},{name:'calls',text:'1'}],
      [{name:'source',text:'reread'},{name:'calls',text:'2'}],
    ])
    expect(refreshes).toBe(2)
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('a persisted compact boundary invalidates only its conversation once', async () => {
  const h = harness(async function* () {yield response('boundary','answer')})
  h.snapshot.hasHooks = event=>event==='prompt.context'
  const cache = new Map()
  const boundaries = new Map()
  Object.assign(h.snapshot, {promptContexts:cache,promptContextBoundaries:boundaries})
  let calls = 0
  h.rewrite(value=>({...value,blocks:[{name:'calls',text:String(++calls)}]}))
  const seen: Record<string,string>[] = []
  h.params.deps!.autocompact = async (messages,_context,forkContext) => {
    seen.push(forkContext.userContext)
    return {messages,wasCompacted:false}
  }
  await drain(query(h.params))
  h.context.agentId = asAgentId('child')
  await drain(query(h.params))
  h.params.messages = [createCompactBoundaryMessage('manual',100),createUserMessage({content:'summary'})]
  await drain(query(h.params))
  await drain(query(h.params))
  delete h.context.agentId
  h.params.messages = []
  await drain(query(h.params))
  expect(seen).toEqual([{calls:'1'},{calls:'2'},{calls:'3'},{calls:'3'},{calls:'1'}])
})

test('real Worker prompt.context runs once for a snapshot across model recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const value = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...value.blocks, {name:'plugin',text:'extra'}]};
      });
    }`)
    await runtime.reconcile([{name:'context-query',storageId:'context-query@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('prompt.context')).toBe(true)
    const observed: any[] = []
    const dispatch = runtime.capture
    runtime.capture = () => {
      const snapshot = dispatch()
      return {...snapshot, dispatch: async (event, input, core, options) => {
        const result = await snapshot.dispatch(event,input,core,options)
        if (event === 'prompt.context') observed.push(result)
        return result
      }}
    }
    let requests = 0
    const h = harness(async function* () {
      requests++
      if (requests === 1) {
        const exhausted = response('limit','partial')
        Object.assign(exhausted, {apiError:'max_output_tokens', isApiErrorMessage:true})
        yield exhausted
      } else yield response('one','answer')
    })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    await drain(query(h.params))
    expect(requests).toBe(2)
    expect(observed).toEqual([{blocks:[{name:'currentDate',text:'today'},{name:'plugin',text:'extra'}]}])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker rejects duplicate context names and keeps the completed inner rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-invalid-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const result = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...result.blocks, {name:'currentDate',text:'duplicate'}]};
      });
    }`)
    await runtime.reconcile([{name:'invalid-context',storageId:'invalid-context@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    let models = 0
    let compactions = 0
    const h = harness(async function* () { models++; yield response('one','answer') })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      compactions++
      expect(forkContext.userContext).toEqual({currentDate:'today'})
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    expect(models).toBe(1)
    expect(compactions).toBe(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({message:expect.stringContaining('unique named text blocks')})
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})
