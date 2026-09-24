import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { dispatchModStream } from './dispatch.js'
import { createModEnvironmentHost } from './environment.js'
import type { ModDispatchHook, ModHookStream, ModInput } from './types.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const input = { turnId: 'turn', index: 0, model: 'fake', messageCount: 1 }
const result = { turnId: 'turn', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null }
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'mods-turn-step-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  const events: { message: string }[] = []
  const value = createModsRuntime({ onDiagnostic: event => events.push(event) })
  cleanups.push(() => value.dispose())
  await value.reconcile([{ name: 'fixture', storageId: 'fixture@inline', pluginRoot: root, entrypoints: [entry] }])
  expect(events).toEqual([])
  return { value, events }
}

test('loads an async generator and transforms chunks while retaining the final result', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) {
      const stream = next({ ...e, model: 'rewritten' });
      for await (const chunk of stream) yield { ...chunk, text: chunk.text.toUpperCase() };
      const result = await stream.result;
      return { ...result, answer: 'result-only' };
    });
  }`)
  const calls: unknown[] = []
  const stream = value.stream('turn.step', input, async function* (request) {
    calls.push(request)
    yield { kind: 'text', index: 0, text: 'hello' }
    return result
  })
  expect(await stream.next()).toEqual({ done: false, value: { kind: 'text', index: 0, text: 'HELLO' } })
  expect(calls).toEqual([{ ...input, model: 'rewritten' }])
  expect(await stream.next()).toMatchObject({ done: true, value: { answer: 'result-only' } })
  expect(await stream.result).toMatchObject({ answer: 'result-only' })
  expect(events).toEqual([])
})

test.each([
  `yield {kind:'text',index:0,text:42};`,
  `yield {kind:'engine',ref:-1};`,
  `return {...e,answer:'bad',toolUses:[],stopReason:'invalid',usage:null};`,
])('invalid streamed output is diagnosed and resumes core: %s', async body => {
  const {value,events}=await fixture(`export function register(on) { on('turn.step',async function* ($,e,next) { ${body} }); }`)
  const source=value.stream('turn.step',input,async function* () { yield {kind:'text',index:0,text:'valid'}; return result })
  expect(await Array.fromAsync(source)).toEqual([{kind:'text',index:0,text:'valid'}])
  expect(await source.result).toEqual(result)
  expect(events).toHaveLength(1)
  expect(events[0]!.message).toContain('Invalid turn.step')
})

test('generator short circuit makes no model call and yield delegation returns the result', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) {
      if (e.model === 'alone') { yield {kind:'text',index:0,text:'local'}; return; }
      const first = yield* next(e);
      const second = yield* next(e);
      return { ...second, answer: first.answer + second.answer };
    });
  }`)
  let calls = 0
  const core = async function* () { calls++; yield { kind: 'text', index: 0, text: 'hello' }; return result }
  const alone = value.stream('turn.step', { ...input, model: 'alone' }, core)
  expect((await Array.fromAsync(alone))).toEqual([{ kind: 'text', index: 0, text: 'local' }])
  expect(await alone.result).toMatchObject({ answer: '', stopReason: null })
  expect(calls).toBe(0)
  const twice = value.stream('turn.step', input, core)
  expect((await Array.fromAsync(twice))).toHaveLength(2)
  expect(await twice.result).toMatchObject({ answer: 'hellohello' })
  expect(calls).toBe(2)
  expect(events).toEqual([])
})

test.each(['turnId', 'index', 'messageCount', 'agentId'])('turn.step pins %s and recovers without sending a forged request', async key => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) { return yield* next({ ...e, ${key}: 'forged' }); });
  }`)
  const seen: unknown[] = []
  const source = value.stream('turn.step', { ...input, agentId: 'child' }, async function* (request) {
    seen.push(request)
    yield {kind:'text',index:0,text:'hello'}
    return result
  })
  await Array.fromAsync(source)
  expect(seen).toEqual([{ ...input, agentId: 'child' }])
  expect(events).toHaveLength(1)
  expect(events[0]!.message).toContain(`cannot rewrite ${key}`)
})

test('midstream failure keeps yielded chunks and resumes the existing model request', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) {
      const stream = next(e);
      yield (await stream.next()).value;
      throw Error('midstream');
    }).catch(async function* ($, e, next) {
      yield {kind:'text',index:0,text:'recovered'};
      return yield* next(e);
    });
  }`)
  let calls = 0
  const source = value.stream('turn.step', input, async function* () {
    calls++
    yield { kind: 'text', index: 0, text: 'first' }
    yield { kind: 'text', index: 0, text: 'second' }
    return result
  })
  expect((await Array.fromAsync(source))).toEqual(['first', 'recovered', 'second'].map(text => ({kind:'text',index:0,text})))
  expect(await source.result).toEqual(result)
  expect(calls).toBe(1)
  expect(events).toHaveLength(1)
})

test('a transform throwing inside for-await preserves the unconsumed downstream response', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($,e,next) {
      for await (const c of next(e)) { if(c.text === 'second') throw Error('transform failed'); yield c; }
    });
  }`)
  let calls=0
  const source=value.stream('turn.step',input,async function* () {
    calls++; for(const text of ['first','second','third']) yield {kind:'text',index:0,text}; return result
  })
  const chunks=await Array.fromAsync(source)
  expect(chunks).toEqual(['first','third'].map(text=>({kind:'text',index:0,text})))
  expect(await source.result).toEqual(result)
  expect(calls).toBe(1)
  expect(events).toHaveLength(1)
})

test('catch replays a completed next result without a second model request', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) { yield* next(e); throw Error('after response'); })
      .catch(async function* ($, e, next) {
        const stream = next({});
        const r = yield* stream;
        return {...r,answer:(await stream.result).answer + ':caught'};
      });
  }`)
  let calls = 0
  const source = value.stream('turn.step', input, async function* () { calls++; yield {kind:'text',index:0,text:'hello'}; return result })
  expect(await Array.fromAsync(source)).toEqual([{kind:'text',index:0,text:'hello'}])
  expect(await source.result).toMatchObject({answer:'hello:caught'})
  expect(calls).toBe(1)
  expect(events).toHaveLength(1)
})

test.each(['', '.catch(async function* ($, e, next) { return yield* next(e); })'])('downstream failures reject result without replaying or blaming the hook: %s', async catching => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) { const stream=next(e); for await (const c of stream) yield c; return await stream.result; })${catching};
  }`)
  let calls = 0
  const source = value.stream('turn.step', input, async function* () {
    calls++; yield {kind:'text',index:0,text:'partial'}; throw Error('fake model failed')
  })
  expect((await source.next()).value).toEqual({kind:'text',index:0,text:'partial'})
  // Await outside Bun's rejects matcher: it blocks Worker host-call delivery while waiting here.
  let failure: unknown
  try { await source.next() } catch (error) { failure = error }
  expect(String(failure)).toContain('fake model failed')
  await expect(source.result).rejects.toThrow('fake model failed')
  expect(calls).toBe(1)
  expect(events).toEqual([])
})

test('a Worker can throw into a downstream generator that catches and completes its result', async () => {
  const {value,events}=await fixture(`export function register(on) {
    on('turn.step',async function* ($,e,next) {
      const stream=next(e);
      yield (await stream.next()).value;
      yield (await stream.throw(Error('injected'))).value;
      const r=yield* stream;
      return {...r,answer:(await stream.result).answer};
    });
    on('turn.step',async function* ($,e,next) { return yield* next(e); });
  }`)
  let closed=0
  const stream=value.stream('turn.step',input,async function* () {
    try {
      try { yield {kind:'text',index:0,text:'first'} }
      catch(error) { yield {kind:'text',index:0,text:(error as Error).message} }
      return result
    } finally {closed++}
  })
  expect(await Array.fromAsync(stream)).toEqual(['first','injected'].map(text=>({kind:'text',index:0,text})))
  expect(await stream.result).toEqual(result)
  expect(closed).toBe(1)
  expect(events).toEqual([])
})

test('throw into a public runtime stream reaches the Worker without prematurely rejecting result', async () => {
  const {value,events}=await fixture(`export function register(on) {
    on('turn.step',async function* ($,e,next) {
      try { yield {kind:'text',index:0,text:'first'}; }
      catch(error) { yield {kind:'text',index:0,text:error.message}; }
      return {turnId:e.turnId,index:e.index,answer:'caught',toolUses:[],stopReason:'end_turn',usage:null};
    });
  }`)
  let calls=0
  const stream=value.stream('turn.step',input,async function* () {calls++;yield {kind:'text',index:0,text:'unexpected'};return result})
  expect((await stream.next()).value).toEqual({kind:'text',index:0,text:'first'})
  expect(await stream.throw(Error('injected'))).toEqual({done:false,value:{kind:'text',index:0,text:'injected'}})
  expect(await stream.next()).toMatchObject({done:true,value:{answer:'caught'}})
  expect(await stream.result).toMatchObject({answer:'caught'})
  expect(calls).toBe(0)
  expect(events).toEqual([])
})

test('$.turn.step is a synchronous stream and skips only its calling registration', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) {
      const stream = $.turn.step({ ...e, model: 'nested' });
      const r = yield* stream;
      return { ...r, answer: (await stream.result).answer };
    });
    on('turn.step', async function* ($, e, next) {
      for await (const c of next(e)) yield {...c, text: c.text + '!'};
    });
  }`)
  const calls: ModInput[] = []
  const source = value.stream('turn.step', input, async function* (request) {
    calls.push(request)
    yield {kind:'text',index:0,text:'nested'}
    return result
  })
  expect(await Array.fromAsync(source)).toEqual([{kind:'text',index:0,text:'nested!'}])
  expect(calls).toEqual([{...input,model:'nested'}])
  expect(await source.result).toEqual(result)
  expect(events).toEqual([])
})

test.each([false, true])('a captured stream remains usable across plugin reconciliation until closed (pulled=%s)', async pulled => {
  const {value,events}=await fixture(`export function register(on) {
    on('turn.step',async function* ($,e,next) { for await(const c of next(e)) yield {...c,text:c.text+'!'}; });
  }`)
  const snapshot=value.capture()
  const source=snapshot.stream!('turn.step',input,async function* () {
    yield {kind:'text',index:0,text:'first'}; yield {kind:'text',index:0,text:'second'}; return result
  })
  if (pulled) expect((await source.next()).value).toEqual({kind:'text',index:0,text:'first!'})
  await value.reconcile([])
  snapshot.release()
  expect(await Array.fromAsync(source)).toEqual((pulled ? ['second!'] : ['first!', 'second!']).map(text => ({kind:'text',index:0,text})))
  expect(await source.result).toEqual(result)
  expect(events).toEqual([])
})

test('next.to skips eligible tiers without reopening the model stream', async () => {
  const seen: string[]=[]
  const source=dispatchModStream({event:'turn.step',input,hooks:[
    {...hook(async function* (e,next) { return yield* (next as unknown as {to(e:ModInput,tier:string):ModHookStream}).to(e,'core') }),tier:'prepend'},
    {...hook(async function* (e,next) { seen.push('user'); return yield* next(e) }),plugin:'user'},
  ],core:async function* () { seen.push('core'); yield 'one'; return result }})
  expect(await Array.fromAsync(source)).toEqual(['one'])
  expect(await source.result).toEqual(result)
  expect(seen).toEqual(['core'])
})

test('Worker observes live budget and trace across generator pulls', async () => {
  const { value, events } = await fixture(`export function register(on) {
    on('turn.step', async function* ($, e, next) {
      const before = next.budget.remainingMs;
      await $.clock.sleep(20, {signal:next.signal});
      const after = next.budget.remainingMs;
      const r = yield* next(e);
      const trace = next.trace;
      if (!(before > after && next.budget.ms === 10000 && trace.length === 1 && trace[0].chunks === 1)) throw Error('bad live meter');
      return r;
    });
  }`)
  const source = value.stream('turn.step',input,async function* () { yield {kind:'text',index:0,text:'one'}; return result })
  await Array.fromAsync(source)
  expect(await source.result).toEqual(result)
  expect(events).toEqual([])
})

test('runtime abort while yielded releases the Worker and result without another pull', async () => {
  const { value, events } = await fixture(`let ended=false; export function register(on) {
    on('turn.step', async function* ($,e,next) { try { return yield* next(e); } finally { ended=true; } });
    on('tool.call', () => ({result:ended}));
  }`)
  const abort = new AbortController()
  let closed = false
  const source = value.stream('turn.step',input,async function* () { try { yield {kind:'text',index:0,text:'one'}; return result } finally { closed=true } },{signal:abort.signal})
  await source.next()
  abort.abort(new Error('suspended abort'))
  await expect(source.result).rejects.toThrow('suspended abort')
  await source.return(undefined)
  expect(closed).toBe(true)
  expect(await value.dispatch('tool.call',{tool:'probe',tool_use_id:'probe'},async () => ({result:false}))).toEqual({result:true})
  expect(events).toEqual([])
})

test('abort interrupts a pending Worker pull and closes the model iterator', async () => {
  const { value, events } = await fixture(`let ended = false; export function register(on) {
    on('turn.step', async function* ($, e, next) {
      try { return yield* next(e); } finally { ended = true; }
    });
    on('tool.call', () => ({result:ended}));
  }`)
  const abort = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let closed = false
  const source = value.stream('turn.step', input, async function* (_request, signal) {
    try {
      started()
      await new Promise<void>((resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once:true}))
      yield {kind:'text',index:0,text:'unreachable'}
      return result
    } finally { closed = true }
  }, {signal:abort.signal})
  const pending = source.next()
  await ready
  abort.abort(new Error('test interrupted'))
  await expect(pending).rejects.toThrow('test interrupted')
  await expect(source.result).rejects.toThrow('test interrupted')
  await source.return(undefined)
  expect(closed).toBe(true)
  expect(await value.dispatch('tool.call', {tool:'probe',tool_use_id:'probe'}, async () => ({result:false}))).toEqual({result:true})
  expect(events).toEqual([])
})

function hook(body: (e: ModInput, next: (e: ModInput) => ModHookStream) => AsyncGenerator<unknown, unknown>): ModDispatchHook {
  return { plugin: 'test', tier: 'user', registration: { id: 1, event: 'turn.step', hasCatch: false },
    invoke: async () => { throw Error('not ordinary') }, invokeStream: (e, next) => body(e, next as unknown as (e: ModInput) => ModHookStream) }
}

test('abort while suspended closes stream and rejects result without another pull', async () => {
  const abort = new AbortController()
  let closed = false
  const source = dispatchModStream({event:'turn.step', input, hooks:[], signal:abort.signal,
    core: async function* () { try { yield 'one'; return result } finally { closed = true } }})
  await source.next()
  abort.abort(new Error('interrupt suspended'))
  await expect(Promise.race([source.result, Bun.sleep(100).then(() => 'still open')])).rejects.toThrow('interrupt suspended')
  expect(closed).toBe(true)
})

test('return while a pull is pending cancels immediately and runs generator cleanup', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let finished = false
  const source = dispatchModStream({event:'turn.step',input,hooks:[],
    core: async function* (_e,signal) {
      try {
        entered()
        await new Promise((_resolve,reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once:true}))
        yield 'never'
      } finally { finished = true }
    }})
  const pending = source.next()
  await started
  const returned = source.return(undefined)
  await expect(pending).rejects.toThrow('closed')
  await returned
  await expect(source.result).rejects.toThrow('closed')
  expect(finished).toBe(true)
})

test('dispatcher preserves the model error', async () => {
  const source = dispatchModStream({event:'turn.step',input,hooks:[hook(async function* (e,next) { return yield* next(e) })],
    core: async function* () { yield 'partial'; throw Error('model broke') }})
  await source.next()
  await expect(source.next()).rejects.toThrow('model broke')
  await expect(source.result).rejects.toThrow('model broke')
})

test('Worker timeout covers accumulated generator work and keeps the remaining response', async () => {
  const host=createModEnvironmentHost()
  cleanups.push(()=>host.dispose())
  const environment=await host.load({name:'meter',storageId:'meter',pluginRoot:'/virtual',entrypoints:['/virtual/register.js'],
    modules:[{path:'/virtual/register.js',source:`export function register(on) {
      on('turn.step',async function* ($,e,next) {
        for await(const c of next(e)) { await $.work(); yield c; }
      }).catch(async function* ($,e,next) {
        if(next.error.kind !== 'timeout' || next.budget.ms !== 1000) throw Error('missing timeout');
        return yield* next(e);
      });
    }`}],links:[],events:['turn.step'],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:'meter'})
  const registration=environment.registrations[0]!
  const failures:unknown[]=[]
  const source=dispatchModStream({event:'turn.step',input,budgetMs:1000,catchGraceMs:1000,
    hooks:[{plugin:'meter',tier:'user',registration,invoke:async()=>{throw Error('not ordinary')},
      invokeStream:(e,next,catching)=>environment.invokeStream(catching?registration.catchId!:registration.id,[{work:()=>Bun.sleep(375)},e],next)}],
    core:async function* () { for(let i=0;i<4;i++) { await Bun.sleep(1100); yield i } return result },
    onFailure:(_plugin,error)=>failures.push(error),
  })
  expect((await source.next()).value).toBe(0)
  await Bun.sleep(1100)
  expect((await source.next()).value).toBe(1)
  expect(await Array.fromAsync(source)).toEqual([3])
  expect(await source.result).toEqual(result)
  expect(failures).toHaveLength(1)
  expect(String(failures[0])).toContain('timed out')
},30000)

test('stream budget spans all pulls but excludes consumer and downstream waits', async () => {
  const failures: unknown[] = []
  const stream = dispatchModStream({ event: 'turn.step', input, budgetMs: 1000,
    hooks: [hook(async function* (e, next) {
      const below = next(e)
      for await (const c of below) { await Bun.sleep(375); yield c }
      return await below.result
    })],
    core: async function* () {
      for (let i = 0; i < 4; i++) { await Bun.sleep(1100); yield i }
      return result
    }, onFailure: (_plugin, error) => failures.push(error),
  })
  expect((await stream.next()).value).toBe(0)
  await Bun.sleep(1100)
  expect((await stream.next()).value).toBe(1)
  const rest = []
  for await (const c of stream) rest.push(c)
  expect(failures).toHaveLength(1)
  expect(String(failures[0])).toContain('timed out')
  expect(rest).toEqual([3])
  expect(await stream.result).toEqual(result)
}, 15000)

test('closing a suspended stream rejects result and returns downstream iterators', async () => {
  let closed = false
  const stream = dispatchModStream({ event: 'turn.step', input,
    hooks: [hook(async function* (e, next) { return yield* next(e) })],
    core: async function* () { try { yield 'one'; yield 'two'; return result } finally { closed = true } },
  })
  expect((await stream.next()).value).toBe('one')
  await stream.return(undefined)
  await expect(stream.result).rejects.toThrow('closed')
  await Bun.sleep(0)
  expect(closed).toBe(true)
})
