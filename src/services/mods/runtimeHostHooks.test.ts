import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { createModsRuntime } from './runtime.js'
import { seatNativeModPlugins } from './native.js'
import type { ModDispatchHook } from './types.js'

const runtimes: ReturnType<typeof createModsRuntime>[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })
function runtime(options: Parameters<typeof createModsRuntime>[0] = {}) {
  const value = createModsRuntime(options)
  runtimes.push(value)
  return value
}
const source = `export function register(on) {
  on('classic.probe', async ($) => ({ value: await $.clock.now() }));
}`
function plugin(body = source, calls = ['clock.now'], extra = {}) {
  return seatNativeModPlugins([], {
    userSettings: null, flagSettings: null, policySettings: null,
    hookPolicy: { managedOnly: false, allDisabled: false }, subscriptionType: 'team',
  }, {
    name: 'classic.probe', storageId: 'probe@inline', pluginRoot: 'builtin:probe',
    entrypoints: ['builtin:probe/register.js'],
    modules: [{ path: 'builtin:probe/register.js', source: body }], links: [],
    events: ['classic.probe'], calls, nextTiers: [], options: {}, tier: 'prepend', fingerprint: body, ...extra,
  })
}
function hook(invoke: ModDispatchHook['invoke'], tier: ModDispatchHook['tier'] = 'user'): ModDispatchHook {
  return { plugin: 'embedding-host', tier, registration: { id: 1, event: 'clock.now', hasCatch: false }, invoke }
}

test('trusted callbacks use positional arguments, independent caller and sibling hooks', async () => {
  const value = runtime({ testing: true })
  const origins: unknown[] = []
  value.registerHostCallback({ ...hook(async () => ({})), registration: { id: 1, event: 'clock.now', hasCatch: false } },
    async ($: any) => {
      expect($.plugin.name).toBe('claude-code/testing')
      await $.store.set('key', { value: 7 })
      expect(await $.store.get('key')).toEqual({ value: 7 })
      return { value: await $.clock.now() }
    })
  value.registerHostHook({ ...hook(async (_input, next) => { origins.push(next.origin); return { value: 123 } }),
    plugin: 'claude-code/testing', registration: { id: 2, event: 'clock.now', hasCatch: false } })
  value.registerHostHook({ ...hook(async input => { expect(input).toEqual({key:'key', value:{value:7}}); return {value:undefined} }),
    registration: {id:3,event:'store.set',hasCatch:false} })
  value.registerHostHook({ ...hook(async input => { expect(input).toEqual({key:'key'}); return {value:{value:7}} }),
    registration: {id:4,event:'store.get',hasCatch:false} })
  expect(await value.dispatch('clock.now', {}, async () => ({}))).toEqual({value:123})
  expect(origins).toEqual([{plugin:'claude-code/testing',tier:'user'}])
})

test('trusted callback nested clock inherits cancellation and facade expires', async () => {
  const value = runtime({testing:true})
  const cancellation = new AbortController()
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let facade: any
  let nestedSignal: AbortSignal | undefined
  value.registerHostCallback({ ...hook(async () => ({})), registration: {id:1,event:'classic.probe',hasCatch:false} },
    async ($: any) => { facade = $; await $.clock.sleep(10); return {} })
  value.registerHostHook({ ...hook(async (_input, next) => {
    nestedSignal = next.signal
    entered()
    return new Promise((_resolve, reject) => next.signal.addEventListener('abort', () => reject(next.signal.reason), {once:true}))
  }), registration:{id:2,event:'clock.sleep',hasCatch:false} })
  const pending = value.dispatch('classic.probe', {}, async () => ({}), {signal:cancellation.signal})
  await ready
  cancellation.abort(new Error('cancel trusted callback'))
  await expect(pending).rejects.toMatchObject({name:'AbortError'})
  expect(nestedSignal?.aborted).toBe(true)
  await expect(facade.clock.now()).rejects.toThrow()
})

test('trusted callback facade expires after successful return', async () => {
  const value = runtime({testing:true})
  let facade: any
  value.registerHostCallback({tier:'core',registration:{id:1,event:'classic.probe',hasCatch:false}}, async $ => {
    facade = $
    return {done:true}
  })
  expect(await value.dispatch('classic.probe', {}, async () => ({}))).toEqual({done:true})
  await expect(facade.clock.now()).rejects.toThrow('Host callback invocation ended')
})

test('trusted callback clock validates duration, unwraps denial and supports cancellation handles', async () => {
  const value = runtime({testing:true})
  let ticks = 0
  value.registerHostCallback({tier:'core',registration:{id:1,event:'classic.probe',hasCatch:false}}, async ($: any) => {
    await expect($.clock.sleep(-1)).rejects.toThrow('Invalid clock duration')
    expect(() => $.clock.every(0, () => {})).toThrow('Invalid clock duration')
    await expect($.clock.now()).rejects.toThrow('clock denied')
    const signal = AbortSignal.abort(new Error('explicit clock cancellation'))
    await expect($.clock.sleep(1, {signal})).rejects.toThrow()
    const timer = $.clock.after(1, () => { ticks++ })
    expect(typeof timer.cancel).toBe('function')
    timer.cancel(); timer.cancel()
    await Promise.resolve()
    return {ticks}
  })
  value.registerHostHook({...hook(async () => ({deny:'clock denied'})),registration:{id:2,event:'clock.now',hasCatch:false}})
  value.registerHostHook({...hook(async () => ({value:undefined})),registration:{id:3,event:'clock.after',hasCatch:false}})
  expect(await value.dispatch('classic.probe', {}, async () => ({}))).toEqual({ticks:0})
})

test('trusted callback clock fires once and repeats until cancelled within its invocation', async () => {
  const value = runtime({testing:true})
  const ticks: string[] = []
  value.registerHostCallback({tier:'core',registration:{id:1,event:'classic.probe',hasCatch:false}}, async ($: any) => {
    const once = Promise.withResolvers<void>()
    $.clock.after(1, () => { ticks.push('after'); once.resolve() })
    await once.promise
    const repeated = Promise.withResolvers<void>()
    const timer = $.clock.every(1, () => {
      ticks.push('every')
      if (ticks.length === 4) { timer.cancel(); repeated.resolve() }
    })
    await repeated.promise
    return {ticks}
  })
  for (const [id, event] of ['clock.after', 'clock.every'].entries()) {
    value.registerHostHook({...hook(async () => ({value:undefined})),registration:{id:id+2,event,hasCatch:false}})
  }
  expect(await value.dispatch('classic.probe', {}, async () => ({}))).toEqual({ticks:['after','every','every','every']})
})

test('session rebind fences a pending trusted callback state write', async () => {
  const diagnostics: unknown[] = []
  const value = runtime({testing:true,onDiagnostic: diagnostic => diagnostics.push(diagnostic)})
  await value.bind({cwd:'builtin:probe',sessionId:'old',surface:'terminal',isInteractive:true})
  const ref = {plugin:'claude-code/testing',key:'session'}
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  value.registerHostCallback({tier:'core',registration:{id:1,event:'testing.pending',hasCatch:false}}, async ($: any) => {
    await $.state.set(ref, 'old')
    entered.resolve()
    await resume.promise
    await expect($.state.set(ref, 'late')).rejects.toThrow(/reset/)
    return {value:'fenced'}
  })
  value.registerHostCallback({tier:'core',registration:{id:2,event:'testing.current',hasCatch:false}}, async ($: any) => {
    return $.state.get(ref)
  })
  const pending = value.dispatch('testing.pending', {}, async () => ({}))
  await entered.promise
  await value.bind({cwd:'builtin:probe',sessionId:'new',surface:'terminal',isInteractive:true})
  resume.resolve()
  const result = await pending
  expect(diagnostics).toEqual([])
  expect(result).toEqual({value:'fenced'})
  expect(await value.dispatch('testing.current', {}, async () => ({}))).toEqual({value:undefined,version:0})
})

test('trusted callback state uses runtime storage, its own owner and CAS', async () => {
  const value = runtime({testing:true})
  const ref = {plugin:'claude-code/testing',key:'count',id:'one'}
  const foreign = {plugin:'sec-default',key:'count'}
  await value.reconcile(plugin(`export function register(on) {
    on('classic.probe', async ($) => $.state.set({plugin:'sec-default',key:'count'}, 7));
  }`, ['state.set'], {state:{writes:[foreign]}}))
  await value.dispatch('classic.probe', {}, async () => ({}))
  value.registerHostCallback({tier:'core',registration:{id:1,event:'testing.state',hasCatch:false}}, async ($: any) => {
    expect(await $.state.get(foreign)).toEqual({value:7,version:1})
    await expect($.state.set(foreign, 8)).rejects.toThrow('only its owner writes it')
    expect(await $.state.get(ref)).toEqual({value:undefined,version:0})
    expect(await $.state.set(ref, 1, {ifVersion:0})).toEqual({isSet:true,version:1})
    expect(await $.state.set(ref, 2, {ifVersion:0})).toEqual({isSet:false,version:1})
    expect(await $.state.get(ref)).toEqual({value:1,version:1})
    expect(await $.state.set(ref, 3, {ifVersion:1})).toEqual({isSet:true,version:2})
    return await $.state.get(ref)
  })
  expect(await value.dispatch('testing.state', {}, async () => ({}))).toEqual({value:3,version:2})
})

test('trusted callback state retains its dispatch snapshot until CAS refreshes it', async () => {
  const diagnostics: unknown[] = []
  const value = runtime({testing:true,onDiagnostic:event => diagnostics.push(event)})
  const ref = {plugin:'claude-code/testing',key:'snapshot'}
  const ready = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  value.registerHostCallback({tier:'core',registration:{id:1,event:'testing.read',hasCatch:false}}, async ($: any) => {
    expect(await $.state.get(ref)).toEqual({value:undefined,version:0})
    ready.resolve()
    await resume.promise
    expect(await $.state.get(ref)).toEqual({value:undefined,version:0})
    expect(await $.state.set(ref, 2, {ifVersion:0})).toEqual({isSet:false,version:1})
    return await $.state.get(ref)
  })
  value.registerHostCallback({tier:'core',registration:{id:2,event:'testing.write',hasCatch:false}}, async ($: any) =>
    ({value:await $.state.set(ref, 1)}))
  const pending = value.dispatch('testing.read', {}, async () => ({}))
  await ready.promise
  try {
    const written = await value.dispatch('testing.write', {}, async () => ({}))
    expect(diagnostics).toEqual([])
    expect(written).toEqual({value:{isSet:true,version:1}})
  } finally { resume.resolve() }
  expect(await pending).toEqual({value:1,version:1})
})

test('trusted callback cannot write state during render', async () => {
  const value = runtime({testing:true})
  value.registerHostCallback({tier:'core',registration:{id:1,event:'ui.render',hasCatch:false}}, async ($: any) => {
    const ref = {plugin:'claude-code/testing',key:'render'}
    await expect($.state.set(ref, 1)).rejects.toThrow('ui.render is pure')
    expect(await $.state.get(ref)).toEqual({value:undefined,version:0})
    return {type:'Box',children:[]}
  })
  expect(await value.dispatch('ui.render', {surface:'terminal',component:'Status',requestId:'state'}, async () => ({})))
    .toEqual({type:'Box',children:[]})
})

test('trusted callback state hooks preserve identity and CAS while allowing value rewrites', async () => {
  const value = runtime({testing:true})
  const ref = {plugin:'claude-code/testing',key:'rewrite',id:'one'}
  value.registerHostCallback({tier:'core',registration:{id:1,event:'testing.state',hasCatch:false}}, async ($: any) => {
    const stop = value.registerHostHook({...hook(async (input, next) => {
      expect(next.origin).toEqual({plugin:'claude-code/testing',tier:'core'})
      expect(input.previous).toBeUndefined()
      return next({...ref,value:4})
    }),registration:{id:2,event:'state.set',hasCatch:false}})
    expect(await $.state.set(ref, 1, {ifVersion:0})).toEqual({isSet:true,version:1})
    stop()
    for (const [field, replacement] of Object.entries({plugin:'sec-default',key:'other',id:'two',ifVersion:0,previous:99})) {
      const revoke = value.registerHostHook({...hook(async (input, next) => {
        await expect(next({...input,[field]:replacement})).rejects.toThrow('cannot rewrite')
        return {isSet:false,version:1}
      }),registration:{id:3,event:'state.set',hasCatch:false}})
      expect(await $.state.set(ref, 2, {ifVersion:1})).toEqual({isSet:false,version:1})
      revoke()
    }
    for (const field of ['plugin','key','id']) {
      const revoke = value.registerHostHook({...hook(async (input, next) => {
        await expect(next({...input,[field]:'other'})).rejects.toThrow('cannot rewrite plugin, key or id')
        return next(input)
      }),registration:{id:4,event:'state.get',hasCatch:false}})
      expect(await $.state.get(ref)).toEqual({value:4,version:1})
      revoke()
    }
    return await $.state.get(ref)
  })
  expect(await value.dispatch('testing.state', {}, async () => ({}))).toEqual({value:4,version:1})
})

test('testing terminal blocks nested capabilities before host providers', async () => {
  const model = mock(() => 'production-model')
  const captureUsage = mock(() => { throw new Error('production usage provider') })
  const toolHost = mock(() => { throw new Error('production tool provider') })
  const value = runtime({ testing: true, services: { model, captureUsage, toolHost } })
  const calls = ['clock.now', 'session.model', 'session.usage', 'tool.check', 'mcp.call']
  await value.reconcile(plugin(`export function register(on) {
    on('classic.probe', async ($) => {
      const errors = [];
      for (const call of [() => $.clock.now(), () => $.session.model(),
        () => $.session.usage(), () => $.tool.check({tool:'probe',input:{}}),
        () => $.mcp.call('probe','probe')]) {
        try { await call(); errors.push('escaped'); } catch (error) { errors.push(error.message); }
      }
      return {errors};
    });
  }`, calls))
  expect(await value.dispatch('classic.probe', {}, async () => { throw new Error('outer bottom') }))
    .toEqual({ errors: calls.map(event => `Unhandled plugin test event: ${event}`) })
  expect(model).not.toHaveBeenCalled()
  expect(captureUsage).not.toHaveBeenCalled()
  expect(toolHost).not.toHaveBeenCalled()
})

test('testing terminal lets exact mocks handle unavailable capabilities', async () => {
  const value = runtime({ testing: true })
  for (const [id, event, result] of [[1, 'session.usage', { value: { startedAt: 1791080000123, context: { window: 100 }, rateLimits: [] } }],
    [2, 'mcp.call', { value: { content: [] } }]] as const) {
    value.registerHostHook({ ...hook(async () => result), registration: { id, event, hasCatch: false } })
  }
  await value.reconcile(plugin(`export function register(on) {
    on('classic.probe', async ($) => ({usage: await $.session.usage(), mcp: await $.mcp.call('probe','probe')}));
  }`, ['session.usage', 'mcp.call']))
  expect(await value.dispatch('classic.probe', {}, async () => { throw new Error('outer bottom') }))
    .toEqual({ usage: { startedAt: 1791080000123, context: { window: 100 }, rateLimits: [] }, mcp: { content: [] } })
})

test('testing terminal blocks public cores including next and next.to without host effects', async () => {
  const value = runtime({ testing: true })
  const core = mock(async () => ({ value: 'production' }))
  const events = ['clock.now', 'clock.sleep', 'env.get', 'env.set', 'fs.read', 'fs.write',
    'fs.list', 'fs.stat', 'fs.exists', 'fs.ancestors', 'process.run', 'http.fetch',
    'store.get', 'settings.read', 'session.usage', 'mcp.call', 'model.complete',
    'agent.spawn', 'tool.call', 'prompt.submit', 'ui.log', 'ui.status', 'ui.toast']
  for (const [id, event] of events.entries()) {
    value.registerHostHook({ ...hook((input, next) => id % 2 ? next.to(input, 'core') : next(input)),
      registration: { id, event, hasCatch: false } })
    await expect(value.dispatch(event, {}, core)).rejects.toThrow(`Unhandled plugin test event: ${event}`)
  }
  expect(core).not.toHaveBeenCalled()
})

test('testing terminal blocks streaming cores and admits a stream mock', async () => {
  const value = runtime({ testing: true })
  // eslint-disable-next-line require-yield -- Probes a result-only stream with no chunks.
  const core = mock(async function* () { return { production: true } })
  const input = { model: 'test-model', turnId: 'turn', index: 0 }
  const stream = value.stream('turn.step', input, core)
  await expect(stream.next()).rejects.toThrow('Unhandled plugin test event: turn.step')
  await expect(stream.result).rejects.toThrow('Unhandled plugin test event: turn.step')
  const result = { turnId: 'turn', index: 0, answer: 'mock', toolUses: [], stopReason: 'end_turn', usage: null }
  value.registerHostHook({ ...hook(async () => result),
    // eslint-disable-next-line require-yield -- A mock may finish without emitting chunks.
    invokeStream: async function* () { return result },
    registration: {id: 1, event: 'turn.step', hasCatch: false} })
  const mocked = value.stream('turn.step', input, core)
  expect(await mocked.next()).toEqual({done: true, value: result})
  expect(await mocked.result).toEqual(result)
  expect(core).not.toHaveBeenCalled()
})

const streamInput = {model:'test-model',turnId:'turn',index:0}
const streamResult = {turnId:'turn',index:0,answer:'mock',toolUses:[],stopReason:'end_turn',usage:null}
const streamChunk = {kind:'text',index:0,text:'first'}

test('trusted stream callback is lazy, preserves chunks/result and facade lifetime', async () => {
  const value = runtime({testing:true})
  let facade: any
  let frame: any
  let pulls = 0
  const ref = {plugin:'claude-code/testing',key:'stream'}
  value.registerHostHook({...hook(async (_input, next) => {
    expect(next.origin).toEqual({plugin:'claude-code/testing',tier:'user'})
    return {value:123}
  }),plugin:'claude-code/testing',registration:{id:2,event:'clock.now',hasCatch:false}})
  value.registerHostCallback({tier:'user',registration:{id:1,event:'turn.step',hasCatch:false}}, async function* ($: any, input, next) {
    facade = $; frame = next
    expect(input).toEqual(streamInput)
    expect(next.origin).toEqual({plugin:'embedding-caller',tier:'core'})
    expect($.plugin.name).toBe('claude-code/testing')
    expect(next.signal.aborted).toBe(false)
    expect(next.budget.ms).toBe(10_000)
    expect(await $.clock.now()).toBe(123)
    expect(await $.state.set(ref, 7)).toEqual({isSet:true,version:1})
    pulls++; yield streamChunk
    expect(await $.clock.now()).toBe(123)
    expect(await $.state.get(ref)).toEqual({value:7,version:1})
    pulls++; yield {...streamChunk,text:'second'}
    return streamResult
  })
  // eslint-disable-next-line require-yield -- An unexpected terminal rejects without emitting chunks.
  const stream = value.stream('turn.step', streamInput, async function* () { throw new Error('unexpected core') },
    {origin:{plugin:'embedding-caller',tier:'core'}})
  expect(pulls).toBe(0)
  expect(await stream.next()).toEqual({done:false,value:streamChunk})
  expect(pulls).toBe(1)
  const remaining = frame.budget.remainingMs
  const advanced = performance.now() + 30
  const clock = spyOn(performance, 'now').mockReturnValue(advanced)
  try { expect(frame.budget.remainingMs).toBe(remaining) } finally { clock.mockRestore() }
  expect(await facade.clock.now()).toBe(123)
  expect(await stream.next()).toEqual({done:false,value:{...streamChunk,text:'second'}})
  expect(pulls).toBe(2)
  expect(await stream.next()).toEqual({done:true,value:streamResult})
  expect(await stream.result).toEqual(streamResult)
  expect(frame.signal.aborted).toBe(true)
  await expect(facade.clock.now()).rejects.toThrow('Host callback invocation ended')
  await expect(facade.state.get(ref)).rejects.toThrow('Host callback invocation ended')
})

test('trusted stream callback next(e) forwards downstream chunks and result', async () => {
  const value = runtime({testing:true})
  let downstream = 0
  value.registerHostCallback({tier:'user',registration:{id:1,event:'turn.step',hasCatch:false}}, async function* (_$, input, next) {
    const branch = next({...input,model:'rewritten'}) as unknown as AsyncGenerator<unknown, unknown> & {result:Promise<unknown>}
    const result = yield* branch
    expect(await branch.result).toEqual(streamResult)
    return result
  })
  value.registerHostCallback({tier:'append',registration:{id:2,event:'turn.step',hasCatch:false}}, async function* (_$, input) {
    expect(input.model).toBe('rewritten')
    downstream++; yield streamChunk
    return streamResult
  })
  // eslint-disable-next-line require-yield -- An unexpected terminal rejects without emitting chunks.
  const stream = value.stream('turn.step', streamInput, async function* () { throw new Error('unexpected core') })
  expect(await stream.next()).toEqual({done:false,value:streamChunk})
  expect(downstream).toBe(1)
  expect(await stream.next()).toEqual({done:true,value:streamResult})
  expect(await stream.result).toEqual(streamResult)
})

test('trusted stream callback forwards throw and reports callback failures without changing recovery', async () => {
  const diagnostics: {message:string}[] = []
  const value = runtime({testing:true,onDiagnostic:event => diagnostics.push(event)})
  let facade: any
  const injected = new Error('consumer throw')
  value.registerHostCallback({tier:'user',registration:{id:1,event:'turn.step',hasCatch:false}}, async function* ($) {
    facade = $
    try { yield streamChunk } catch (error) { expect(error).toBe(injected); throw new Error('callback failed') }
  })
  // eslint-disable-next-line require-yield -- An unexpected terminal rejects without emitting chunks.
  const stream = value.stream('turn.step', streamInput, async function* () { throw new Error('unexpected core') })
  expect(await stream.next()).toEqual({done:false,value:streamChunk})
  await expect(stream.throw(injected)).rejects.toThrow('Unhandled plugin test event: turn.step')
  await expect(stream.result).rejects.toThrow('Unhandled plugin test event: turn.step')
  expect(diagnostics.map(event => event.message)).toEqual(['callback failed'])
  await expect(facade.clock.now()).rejects.toThrow('Host callback invocation ended')
})

test('trusted stream callback return cancels downstream and invalidates both facades', async () => {
  const value = runtime({testing:true})
  const facades: any[] = [], signals: AbortSignal[] = []
  const closed = [Promise.withResolvers<void>(),Promise.withResolvers<void>()]
  for (const [index, tier] of (['user','append'] as const).entries()) {
    value.registerHostCallback({tier,registration:{id:index+1,event:'turn.step',hasCatch:false}}, async function* ($, input, next) {
      facades.push($); signals.push(next.signal)
      try {
        if (index === 0) return yield* (next(input) as unknown as AsyncGenerator<unknown, unknown>)
        yield streamChunk
        return streamResult
      } finally { closed[index]!.resolve() }
    })
  }
  // eslint-disable-next-line require-yield -- An unexpected terminal rejects without emitting chunks.
  const stream = value.stream('turn.step', streamInput, async function* () { throw new Error('unexpected core') })
  expect(await stream.next()).toEqual({done:false,value:streamChunk})
  await stream.return(undefined)
  await expect(stream.result).rejects.toThrow('Module stream closed before completion')
  await Promise.all(closed.map(item => item.promise))
  expect(signals.map(signal => signal.aborted)).toEqual([true,true])
  for (const facade of facades) {
    await expect(facade.clock.now()).rejects.toThrow()
    await expect(facade.state.get({plugin:'claude-code/testing',key:'closed'})).rejects.toThrow()
  }
})

test('trusted stream callback nested work pauses budget and inherits abort', async () => {
  const value = runtime({testing:true})
  const cancellation = new AbortController()
  const ready = Promise.withResolvers<void>()
  let frame: any, facade: any, nestedSignal: AbortSignal | undefined
  value.registerHostHook({...hook(async (_input, next) => {
    nestedSignal = next.signal
    ready.resolve()
    return new Promise((_resolve, reject) => next.signal.addEventListener('abort', () => reject(next.signal.reason), {once:true}))
  }),registration:{id:2,event:'clock.sleep',hasCatch:false}})
  value.registerHostCallback({tier:'user',registration:{id:1,event:'turn.step',hasCatch:false}}, async function* ($: any, _input, next) {
    facade = $; frame = next
    await $.clock.sleep(100)
    yield streamChunk
    return streamResult
  })
  // eslint-disable-next-line require-yield -- An unexpected terminal rejects without emitting chunks.
  const stream = value.stream('turn.step', streamInput, async function* () { throw new Error('unexpected core') }, {signal:cancellation.signal})
  const pending = stream.next()
  // Race entry against a failed pull so missing invokeStream fails rather than hanging.
  await Promise.race([ready.promise, pending])
  const remaining = frame.budget.remainingMs
  const advanced = performance.now() + 30
  const clock = spyOn(performance, 'now').mockReturnValue(advanced)
  try { expect(frame.budget.remainingMs).toBe(remaining) } finally { clock.mockRestore() }
  cancellation.abort(new Error('cancel stream callback'))
  await expect(pending).rejects.toThrow('cancel stream callback')
  await expect(stream.result).rejects.toThrow('cancel stream callback')
  expect(frame.signal.aborted).toBe(true)
  expect(nestedSignal?.aborted).toBe(true)
  await expect(facade.clock.now()).rejects.toThrow()
})

test('testing terminal preserves lifecycle and runtime-owned state and rendering', async () => {
  const diagnostics: unknown[] = []
  const value = runtime({ testing: true, onDiagnostic: event => diagnostics.push(event) })
  const ref = { plugin: 'sec-default', key: 'count' }
  await value.reconcile(plugin(`export function register(on) {
    on('classic.probe', async ($) => {
      const ref = {plugin:'sec-default',key:'count'};
      await $.state.set(ref, 7);
      await $.ui.invalidate('ui.render');
      return await $.state.get(ref);
    });
  }`, ['state.get', 'state.set', 'ui.invalidate'], { state: { reads: [ref], writes: [ref] } }))
  await value.bind({cwd: 'builtin:probe', sessionId: 'test', surface: 'terminal', isInteractive: true})
  const result = await value.dispatch('classic.probe', {}, async () => ({ missed: true }))
  expect(diagnostics).toEqual([])
  expect(result).toEqual({ value: 7, version: 1 })
  const render = mock(async () => ({type: 'Box', children: []}))
  expect(await value.dispatch('ui.render', {surface:'terminal',component:'Status',requestId:'probe'}, render))
    .toEqual({type: 'Box', children: []})
  expect(render).toHaveBeenCalledTimes(1)
})

test('an outer dispatch core cannot intercept a plugin nested clock.now', async () => {
  const value = runtime()
  await value.reconcile(plugin())
  let coreCalls = 0
  const result = await value.dispatch('classic.probe', {}, async () => {
    coreCalls++
    return { value: -1 }
  }) as { value: number }
  expect(coreCalls).toBe(0)
  expect(result.value).toBeGreaterThan(0)
})

test('host hook intercepts a plugin nested clock.now with its closure', async () => {
  const diagnostics: unknown[] = []
  const value = runtime({ onDiagnostic: event => diagnostics.push(event) })
  let clock = 123
  value.registerHostHook(hook(async () => ({ value: ++clock })))
  await value.reconcile(plugin())
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('classic.probe', {}, async () => ({ value: 'missed' }))).toEqual({ value: 124 })
  expect(clock).toBe(124)
})

test('host registrations are revocable, runtime-local, and visible to snapshots', async () => {
  const left = runtime(), right = runtime()
  const snapshot = left.capture()
  const stop = left.registerHostHook(hook(async () => ({ value: 17 })))
  expect(left.hasHooks('clock.now')).toBe(true)
  expect(snapshot.hasHooks('clock.now')).toBe(true)
  expect(right.hasHooks('clock.now')).toBe(false)
  expect(await snapshot.dispatch('clock.now', {}, async () => ({ value: 2 }))).toEqual({ value: 17 })
  expect(await right.dispatch('clock.now', {}, async () => ({ value: 2 }))).toEqual({ value: 2 })
  stop(); stop()
  expect(snapshot.hasHooks('clock.now')).toBe(false)
  expect(await snapshot.dispatch('clock.now', {}, async () => ({ value: 2 }))).toEqual({ value: 2 })
  snapshot.release()
  await left.dispose()
  expect(() => left.registerHostHook(hook(async () => ({})))).toThrow('Mods runtime disposed')
})

test('host hooks preserve tier order, matcher, next and next.to', async () => {
  const value = runtime()
  const calls: string[] = []
  for (const tier of ['builtin', 'append', 'user', 'prepend'] as const) {
    value.registerHostHook(hook(async (input, next) => {
      calls.push(tier)
      const result = tier === 'prepend' ? await next.to(input, 'append') : await next(input)
      calls.push(`${tier}:after`)
      return result
    }, tier))
  }
  value.registerHostHook({ ...hook(async () => { throw new Error('matcher should exclude this') }),
    registration: { id: 2, event: 'clock.*', matcher: { tag: 'other' }, hasCatch: false } })
  expect(await value.dispatch('clock.now', { tag: 'chosen' }, async () => {
    calls.push('core'); return { value: 42 }
  })).toEqual({ value: 42 })
  expect(calls).toEqual(['prepend', 'append', 'builtin', 'core', 'builtin:after', 'append:after', 'prepend:after'])
})

test('host failures use normal diagnostics and catch recovery', async () => {
  const diagnostics: { message: string }[] = []
  const value = runtime({ onDiagnostic: event => diagnostics.push(event) })
  const recovered: unknown[] = []
  value.registerHostHook({ ...hook(async (input, next, catching) => {
    if (!catching) throw new Error('host failure')
    recovered.push(next.error)
    return next(input)
  }), registration: { id: 1, event: 'clock.now', hasCatch: true } })
  expect(await value.dispatch('clock.now', {}, async () => ({ value: 9 }))).toEqual({ value: 9 })
  expect(diagnostics.map(item => item.message)).toEqual(['host failure'])
  expect(recovered).toMatchObject([{ kind: 'throw', message: 'host failure' }])
})

test('host hook pending work receives cancellation without running core', async () => {
  const value = runtime()
  const cancellation = new AbortController()
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let signal: AbortSignal | undefined
  let coreCalls = 0
  value.registerHostHook(hook(async (_input, next) => {
    signal = next.signal
    entered()
    return new Promise((_resolve, reject) => next.signal.addEventListener('abort', () => reject(next.signal.reason), { once: true }))
  }))
  const pending = value.dispatch('clock.now', {}, async () => { coreCalls++; return { value: 1 } }, { signal: cancellation.signal })
  await ready
  const reason = new Error('cancel host invocation')
  cancellation.abort(reason)
  const error = await pending.catch(error => error)
  expect(error).toBe(signal?.reason)
  expect(error).toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(true)
  expect(coreCalls).toBe(0)
})
