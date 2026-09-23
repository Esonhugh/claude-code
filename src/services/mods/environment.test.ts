import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModClockBridge, createModEnvironmentHost, createModStreamBridge } from './environment.js'
import type { ModDeclaration, ModNext } from './types.js'
import { dispatchModEvent, dispatchModStream } from './dispatch.js'
import { loadModDeclaration } from './loader.js'

const hosts: ReturnType<typeof createModEnvironmentHost>[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all([
    ...hosts.splice(0).map(host => host.dispose()),
    ...roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  ])
})

function declaration(source: string): ModDeclaration {
  return {
    name: 'fixture', storageId: 'fixture@local', pluginRoot: '/fixture',
    entrypoints: ['/fixture/register.js'], modules: [{ path: '/fixture/register.js', source }],
    links: [], events: ['session.start', 'tool.call', 'engine.create'], calls: [], nextTiers: [],
    options: { label: 'configured' }, tier: 'user', fingerprint: source,
  }
}
function host() { const value = createModEnvironmentHost(); hosts.push(value); return value }
function next(call: (input: Record<string, unknown>) => Promise<unknown>): ModNext {
  return Object.assign(call, {
    to: call, is: (event: string) => event === 'tool.call', signal: new AbortController().signal, event: 'tool.call',
    origin: { plugin: 'engine', tier: 'core' as const }, trace: [], budget: {ms:0,remainingMs:Infinity},
  })
}

describe('Mods Worker environment', () => {
  test('registers and invokes mcp.call hooks', async () => {
    const environment = await host().load({
      ...declaration(`export function register(on) {
        on('mcp.call', ($, e, next) => next({...e, tool:e.tool+'-rewritten'}));
      }`),
      events: ['mcp.call'],
    })
    expect(environment.registrations.map(registration => registration.event)).toEqual(['mcp.call'])
    const continuation = next(async input => input)
    continuation.event = 'mcp.call'
    expect(await environment.invoke(
      environment.registrations[0]!.id,
      [{}, {server:'claude.ai Gmail',tool:'create_draft',args:{subject:'Release notes'}}],
      continuation,
    )).toEqual({server:'claude.ai Gmail',tool:'create_draft-rewritten',args:{subject:'Release notes'}})
  })

  test('pulls streaming continuations lazily and exposes their final result synchronously', async () => {
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e, next) {
        const stream = next(e);
        if (stream.then || typeof stream.next !== 'function') throw Error('not a synchronous stream');
        for await (const chunk of stream) yield {text:chunk.text.toUpperCase()};
        return {answer:(await stream.result).answer, later:() => next(e)};
      });
    }`), events:['turn.step']})
    let pulls = 0
    const frame = next((() => (async function* () {
      pulls++; yield {text:'one'};
      pulls++; yield {text:'two'};
      pulls++; return {answer:'done'};
    })()) as any)
    frame.event = 'turn.step'
    const stream = environment.invokeStream(environment.registrations[0]!.id, [{}, {}], frame)
    expect((stream as any).then).toBeUndefined()
    expect(pulls).toBe(0)
    expect(await stream.next()).toEqual({done:false,value:{text:'ONE'}})
    expect(pulls).toBe(1)
    expect(await stream.next()).toEqual({done:false,value:{text:'TWO'}})
    expect(pulls).toBe(2)
    const end = await stream.next()
    expect(end.done).toBe(true)
    expect((end.value as any).answer).toBe('done')
    expect(await stream.result).toBe(end.value)
    const expired = await (end.value as any).later().then(() => null, (error: Error) => error)
    expect(expired.message).toMatch(/settled/)
    expect(pulls).toBe(3)
  })

  test('marked host stream bridges support $.turn.step without assimilating a generator', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($) => {
        const stream = $.turn.step({value:7});
        if (stream.then || typeof stream.next !== 'function') throw Error('not a synchronous stream');
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return {chunks,result:await stream.result};
      });
    }`))
    let pulls = 0
    const step = createModStreamBridge((input: any) => (async function* () {
      pulls++; yield input.value; return 'final';
    })())
    expect(await environment.invoke(environment.registrations[0]!.id, [{turn:{step}}])).toEqual({chunks:[7],result:'final'})
    expect(pulls).toBe(1)
    expect(await environment.invoke(environment.registrations[0]!.id, [{turn:{step}}])).toEqual({chunks:[7],result:'final'})
    expect(pulls).toBe(2)
  })

  test('streaming budget and trace remain live through yields and catch generator recovery', async () => {
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e, next) {
        const stream = next.to(e, 'core');
        yield (await stream.next()).value;
        const budget = next.budget;
        if (budget.ms !== 1000 || budget.remainingMs <= 0) throw Error('lost budget');
        throw Error('recover me');
      }).catch(async function* ($, e, next) {
        if (!next.called || next.error.message !== 'recover me') throw Error('lost catch metadata');
        const result = yield* next(e);
        return {...result,trace:next.trace.map(entry => entry.outcome)};
      });
    }`), events:['turn.step'], nextTiers:['core']})
    const registration = environment.registrations[0]!
    let pulls = 0
    const failures: string[] = []
    const stream = dispatchModStream({event:'turn.step',input:{turnId:'t',index:0,messageCount:1},budgetMs:1000,
      hooks:[{plugin:'fixture',tier:'prepend',registration,invoke:async () => {throw Error('not ordinary')},
        invokeStream:(input,continuation,catching) => environment.invokeStream(catching ? registration.catchId! : registration.id,[{},input],continuation)}],
      core:async function* () { pulls++; yield 'one'; pulls++; yield 'two'; return {answer:'done'} },
      onFailure:(_plugin,error) => failures.push((error as Error).message),
    })
    expect(await stream.next()).toEqual({done:false,value:'one'})
    expect(pulls).toBe(1)
    expect(await stream.next()).toEqual({done:false,value:'two'})
    expect(await stream.next()).toEqual({done:true,value:{answer:'done',trace:['returned']}})
    expect(await stream.result).toEqual({answer:'done',trace:['returned']})
    expect(failures).toEqual(['recover me'])
    expect(pulls).toBe(2)
  })

  test('stream rejection retains host error identity across pulls', async () => {
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e, next) { return yield* next(e); });
    }`), events:['turn.step']})
    const failure = new Error('stream beneath failed')
    const frame = next((() => (async function* () { yield 1; throw failure })()) as any)
    frame.event = 'turn.step'
    const stream = environment.invokeStream(environment.registrations[0]!.id,[{},{}],frame)
    expect(await stream.next()).toEqual({done:false,value:1})
    expect(await stream.next().then(() => null, error => error)).toBe(failure)
    expect(await stream.result.then(() => null, error => error)).toBe(failure)
  })

  test('stream return and throw cross the Worker and early close rejects result', async () => {
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e, next) { return yield* next(e); });
    }`), events:['turn.step']})
    let closed = 0
    const frame = next((() => (async function* () {
      try {
        try { yield 'first'; } catch (error) { yield 'caught:' + (error as Error).message; }
        return 'complete';
      } finally { closed++; }
    })()) as any)
    frame.event = 'turn.step'
    const first = environment.invokeStream(environment.registrations[0]!.id, [{}, {}], frame)
    expect(await first.next()).toEqual({done:false,value:'first'})
    expect(await first.throw(new Error('injected'))).toEqual({done:false,value:'caught:injected'})
    expect(await first.next()).toEqual({done:true,value:'complete'})
    expect(await first.result).toBe('complete')
    const second = environment.invokeStream(environment.registrations[0]!.id, [{}, {}], frame)
    expect(await second.next()).toEqual({done:false,value:'first'})
    expect(await second.return('stopped')).toEqual({done:true,value:'stopped'})
    const failure = await second.result.then(() => null, error => error)
    expect(failure.message).toMatch(/closed/)
    expect(closed).toBe(2)
  })

  test.each(['abort', 'dispose'])('stream %s releases a pending pull and its result without draining', async mode => {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e, next) {
        try { yield 'ready'; await $.hold(); yield 'never'; }
        finally { await $.released(); }
      });
    }`), events:['turn.step']})
    const controller = new AbortController()
    const frame = next(async () => ({})); frame.event = 'turn.step'; frame.signal = controller.signal
    const stream = environment.invokeStream(environment.registrations[0]!.id, [{
      hold: () => { entered.resolve(); return new Promise(() => {}) },
      released: () => released.resolve(),
    }, {}], frame)
    expect(await stream.next()).toEqual({done:false,value:'ready'})
    const pending = stream.next().then(() => null, error => error)
    await entered.promise
    if (mode === 'abort') controller.abort(new Error('canceled stream'))
    else await environment.dispose()
    expect(await pending).toBeInstanceOf(Error)
    expect(await stream.result.then(() => null, error => error)).toBeInstanceOf(Error)
    if (mode === 'abort') await released.promise
  })

  test('suspended stream disposal rejects result and reclaims a partially-read capability', async () => {
    const released = Promise.withResolvers<void>()
    const environment = await host().load({...declaration(`export function register(on) {
      on('turn.step', async function* ($, e) {
        const beneath = $.turn.step(e);
        yield (await beneath.next()).value;
        return yield* beneath;
      });
    }`), events:['turn.step']})
    const frame = next(async () => ({})); frame.event = 'turn.step'
    const step = createModStreamBridge(() => (async function* () {
      try { yield 'first'; yield 'never'; } finally { released.resolve(); }
    })())
    const stream = environment.invokeStream(environment.registrations[0]!.id,[{turn:{step}},{}],frame)
    expect(await stream.next()).toEqual({done:false,value:'first'})
    await environment.dispose()
    expect(await stream.result.then(() => null,error => error)).toBeInstanceOf(Error)
    await released.promise
  })

  test('retains a frozen engine identity without interning ordinary invocation data', async () => {
    const environment=await host().load(declaration(`let first, input;export function register(on) {
      on('tool.call',($,e)=>{
        const sameEngine=first===undefined||first===$,sameInput=input===e;
        first=$;input=e;
        return {sameEngine,sameInput,frozen:Object.isFrozen($),value:$.plugin.name};
      });
    }`))
    const engine=Object.freeze({plugin:Object.freeze({name:'fixture'})})
    const input=Object.freeze({marker:'input'})
    const handle=environment.registrations[0]!.id
    const expected={sameEngine:true,sameInput:false,frozen:true,value:'fixture'}
    expect(await environment.invoke(handle,[engine,input],next(async()=>({})))).toEqual(expected)
    expect(await environment.invoke(handle,[engine,input],next(async()=>({})))).toEqual(expected)
  })
  test('wildcard registrations preserve nested regexp and any-of matchers across the real Worker', async () => {
    const source = `export function register(on) {
      on('tool.*', {tool:['Read', /^ba/ig], details:{tags:/safe/g}}, async ($, e, next) => {
        const below = await next(e);
        return {result: 'matched:' + below.result, exact:next.is('tool.call',e)};
      });
      on('!tool.describe', {tool:'Read'}, ($, e, next) => next(e));
    }`
    const environment = await host().load({...declaration(source), events:['tool.*', '!tool.describe']})
    const registration = environment.registrations[0]!
    expect((registration.matcher as any).tool[1]).toBeInstanceOf(RegExp)
    const hooks = environment.registrations.map(registration => ({
      plugin:'fixture', tier:'user' as const, registration,
      invoke: (input: Record<string, unknown>, continuation: ModNext) => environment.invoke(registration.id, [{}, input], continuation),
    }))
    for (const tool of ['Bash', 'Bash', 'Read', 'Write']) {
      const result = await dispatchModEvent({event:'tool.call', input:{tool, details:{tags:['other','safe']}}, hooks, core:async () => ({result:'core'})})
      expect(result).toEqual(tool === 'Write' ? {result:'core'} : {result:'matched:core', exact:true})
    }
    expect(await dispatchModEvent({event:'tool.describe', input:{tool:'Read'}, hooks, core:async () => ({result:'description'})})).toEqual({result:'description'})
  })
  test('keeps Worker budget snapshots metered after their invocation has settled', async () => {
    const environment=await host().load(declaration(`let previous; export function register(on) {
      on('tool.call',($,e,next)=>{
        if(e.read) return {ms:previous.ms,remaining:previous.remainingMs};
        previous=next.budget;
        return {ms:previous.ms,remaining:previous.remainingMs};
      });
    }`))
    const registration=environment.registrations[0]!
    const run=(input:Record<string,unknown>)=>dispatchModEvent({event:'tool.call',input,budgetMs:200,
      hooks:[{plugin:'fixture',tier:'user',registration,invoke:(e,n)=>environment.invoke(registration.id,[{},e],n)}],core:async()=>({}),
    }) as Promise<{ms:number;remaining:number}>
    const initial=await run({})
    const later=await run({read:true})
    expect(initial.ms).toBe(200)
    expect(later.ms).toBe(200)
    expect(later.remaining).toBeLessThanOrEqual(initial.remaining)
    expect(later.remaining).toBeGreaterThan(0)
  })
  test('streams settled trace entries before a pending next resolves and retains only the latest branch', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        const earlier=next({...e,branch:1});
        await $.enteredFirst();
        const latest=next({...e,branch:2});
        await $.enteredSecond();
        await $.releaseFirst();
        await earlier;
        const partial=next.trace;
        await $.releaseSecond();
        await latest;
        return {partial,complete:next.trace,frozen:Object.isFrozen(partial)&&partial.every(Object.isFrozen)};
      });
    }`))
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const releaseSecond = Promise.withResolvers<void>()
    const registration = environment.registrations[0]!
    const result = await dispatchModEvent({event:'tool.call',input:{},hooks:[{
      plugin:'fixture',tier:'user',registration,
      invoke:(input,continuation)=>environment.invoke(registration.id,[{
        enteredFirst:()=>first.promise,enteredSecond:()=>second.promise,
        releaseFirst:()=>releaseFirst.resolve(),releaseSecond:()=>releaseSecond.resolve(),
      },input],continuation),
    },{
      plugin:'inner',tier:'user',registration:{id:2,event:'tool.call',hasCatch:false},
      invoke:async (input,next)=>{
        const result=await next(input)
        if(input.branch===1){first.resolve();await releaseFirst.promise}
        else {second.resolve();await releaseSecond.promise}
        return result
      },
    }],core:async input=>({result:input.branch})}) as any
    expect(result.partial).toEqual([{index:2,event:'tool.call',ms:expect.any(Number),plugin:'engine',tier:'core',outcome:'returned',received:{branch:2},returned:{result:2}}])
    expect(result.complete.map((entry:any)=>[entry.plugin,entry.received.branch])).toEqual([['inner',2],['engine',2]])
    expect(result.frozen).toBe(true)
  })
  test('continuation rejection identity survives the Worker, but matching error text does not impersonate it', async () => {
    for (const body of ['return next(e)', 'try { await next(e) } catch (error) { throw error }', 'try { await next(e) } catch (error) { throw Error(error.message) }']) {
      const environment = await host().load(declaration(`export function register(on) {
        on('tool.call', async ($, e, next) => { ${body} });
      }`))
      const original = new Error('downstream failure')
      const failure = await environment.invoke(environment.registrations[0]!.id, [{}, {}], next(async () => { throw original })).then(() => null, error => error)
      if (body.includes('throw Error')) {
        expect(failure).not.toBe(original)
        expect(failure.message).toBe(original.message)
      } else expect(failure).toBe(original)
    }
  })
  test('awaits real-time clock sleep before a handler returns', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const waits: unknown[] = []
    const clock = createModClockBridge({
      now: async () => 73,
      wait: async (kind, ms, id) => { waits.push([kind, ms, id]); started.resolve(); await release.promise },
      cancel: () => {},
    })
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($) => { await $.clock.sleep(12); return await $.clock.now(); });
    }`))
    let settled = false
    const result = environment.invoke(environment.registrations[0]!.id, [{ clock }]).finally(() => { settled = true })
    await started.promise
    expect(settled).toBe(false)
    expect(waits).toEqual([['sleep', 12, expect.any(Number)]])
    release.resolve()
    expect(await result).toBe(73)
  })
  test('holds the host callback lease through asynchronous timer continuations', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const records: string[] = []
    const clock = createModClockBridge({
      now: async () => 0,
      wait: async () => {},
      cancel: () => {},
      run: async callback => {
        records.push('enter')
        try { await callback() }
        finally { records.push('leave'); finished.resolve() }
      },
    })
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', ($) => { $.clock.after(0, async () => { await $.hold(); }); return 'scheduled'; });
    }`))
    await environment.invoke(environment.registrations[0]!.id, [{ clock, hold: async () => { entered.resolve(); await release.promise } }])
    await entered.promise
    expect(records).toEqual(['enter'])
    release.resolve()
    await finished.promise
    expect(records).toEqual(['enter', 'leave'])
  })

  test('after returns cancel synchronously and routes callback failures', async () => {
    const errors = Promise.withResolvers<Error>()
    const worker = createModEnvironmentHost({ onError: error => errors.resolve(error) })
    hosts.push(worker)
    const release = Promise.withResolvers<void>()
    const clock = createModClockBridge({ now: async () => 0, wait: () => release.promise, cancel: () => {} })
    const environment = await worker.load(declaration(`export function register(on) {
      on('tool.call', ($) => {
        const timer = $.clock.after(10, () => { throw Error('timer callback failed'); });
        return { cancel: typeof timer.cancel, then: typeof timer.then, frozen: Object.isFrozen($.clock) };
      });
    }`))
    const result = await environment.invoke(environment.registrations[0]!.id, [{ clock }]).then(value => value, error => error)
    expect(result).toEqual({ cancel: 'function', then: 'undefined', frozen: true })
    release.resolve()
    expect((await errors.promise).message).toBe('timer callback failed')
  })

  test('every cancels without a callback and unload cancels outstanding timers', async () => {
    const waits: { id: number; release: () => void }[] = []
    const cancellations: number[] = []
    const clock = createModClockBridge({
      now: async () => 0,
      wait: (_kind, _ms, id) => new Promise<void>(resolve => { waits.push({ id, release: resolve }) }),
      cancel: id => { cancellations.push(id) },
    })
    let callbacks = 0
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', ($) => {
        const timer = $.clock.every(1, () => $.tick());
        timer.cancel(); timer.cancel();
        $.clock.every(1, () => $.tick());
        return 'scheduled';
      });
    }`))
    const result = await environment.invoke(environment.registrations[0]!.id, [{ clock, tick: () => { callbacks++ } }]).then(value => value, error => error)
    expect(result).toBe('scheduled')
    expect(waits).toHaveLength(2)
    expect(cancellations).toEqual([waits[0]!.id])
    await environment.dispose()
    expect(cancellations).toEqual(waits.map(wait => wait.id))
    for (const wait of waits) wait.release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(callbacks).toBe(0)
    expect(waits).toHaveLength(2)
  })

  test('canceled after is silent while wait and callback errors remain observable', async () => {
    const errors = Promise.withResolvers<Error>()
    const reported: Error[] = []
    const worker = createModEnvironmentHost({ onError: error => { reported.push(error); errors.resolve(error) } })
    hosts.push(worker)
    const release = Promise.withResolvers<void>()
    const clock = createModClockBridge({ now: async () => 0, wait: () => release.promise, cancel: () => {} })
    const environment = await worker.load(declaration(`export function register(on) {
      on('tool.call', ($, mode) => {
        const timer = $.clock.after(1, () => { throw Error('unexpected callback'); });
        if (mode === 'cancel') timer.cancel();
      });
    }`))
    await environment.invoke(environment.registrations[0]!.id, [{ clock }, 'cancel'])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(reported).toEqual([])
    await environment.invoke(environment.registrations[0]!.id, [{ clock }, 'error'])
    release.reject(new Error('host wait failed'))
    expect((await errors.promise).message).toBe('host wait failed')
    expect(reported).toHaveLength(1)
  })

  test('every waits for each period and stops rescheduling when canceled inside its callback', async () => {
    const waits: { id: number; release: () => void }[] = []
    const firstTick = Promise.withResolvers<void>()
    const secondTick = Promise.withResolvers<void>()
    const secondWait = Promise.withResolvers<void>()
    const clock = createModClockBridge({
      now: async () => 0,
      wait: (_kind, _ms, id) => new Promise<void>(resolve => { waits.push({ id, release: resolve }); if (waits.length === 2) secondWait.resolve() }),
      cancel: () => {},
    })
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', ($) => {
        let count = 0;
        const timer = $.clock.every(5, async () => { if (++count === 2) timer.cancel(); await $.tick(count); });
      });
    }`))
    await environment.invoke(environment.registrations[0]!.id, [{ clock, tick: (count: number) => { (count === 1 ? firstTick : secondTick).resolve() } }])
    expect(waits).toHaveLength(1)
    waits[0]!.release()
    await firstTick.promise
    await secondWait.promise
    expect(waits).toHaveLength(2)
    expect(waits[1]!.id).toBe(waits[0]!.id)
    waits[1]!.release()
    await secondTick.promise
    await environment.dispose()
    expect(waits).toHaveLength(2)
  })

  test.each([false, true])('detached rejection is isolated to its environment (unloaded=%s)', async unloaded => {
    // bun test intercepts Worker unhandled rejections before process listeners;
    // exercise the production routing in a normal Bun child process.
    const source = `
      import {createModEnvironmentHost} from ${JSON.stringify(new URL('./environment.ts', import.meta.url).pathname)};
      const errors=[], deaths=[];
      const reported=Promise.withResolvers(), entered=Promise.withResolvers(), release=Promise.withResolvers();
      const worker=createModEnvironmentHost({onError:(error,environment)=>{errors.push({message:error.message,environment});reported.resolve()},onDied:error=>{deaths.push(error.message);reported.resolve()}});
      try {
        const environment=await worker.load(${JSON.stringify(declaration(`export function register(on) {
          on('tool.call', ($) => { void (async () => { await $.hold(); throw Error('detached failed'); })(); return 'started'; });
        }`))});
        const sibling=await worker.load(${JSON.stringify(declaration(`export function register(on) {on('tool.call',() => 'sibling alive');}`))});
        const result=await environment.invoke(environment.registrations[0].id,[{hold:async()=>{entered.resolve();await release.promise}}]);
        await entered.promise;
        if (${unloaded}) await environment.dispose();
        release.resolve();
        if (${unloaded}) await new Promise(resolve=>setTimeout(resolve,30));
        else await reported.promise;
        const siblingResult=await sibling.invoke(sibling.registrations[0].id,[]);
        console.log(JSON.stringify({result,errors,deaths,siblingResult,environment:environment.id}));
      } finally {await worker.dispose()}
    `
    const child = Bun.spawn([process.execPath, '-e', source], { stdout:'pipe', stderr:'pipe' })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.deaths).toEqual([])
    expect(result.errors).toEqual(unloaded ? [] : [{message:'detached failed',environment:result.environment}])
    expect(result.result).toBe('started')
    expect(result.siblingResult).toBe('sibling alive')
  })

  test('Client modules execute inside the real Worker VM', async () => {
    const clientPath = '/fixture/surface.js'
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:clientPath,source:`export default function Surface(props,s) {
      if(typeof process!=='undefined' || typeof Bun!=='undefined') throw Error('Client escaped the Worker VM');
      s.setState((s.state??0)+1);
      return s.elements.Text({children:props.label+':'+s.state});
    }`})
    fixture.clients = [{path:clientPath,module:'surface.js'}]
    const environment = await host().load(fixture)
    const mounted = await environment.client({op:'mount',id:1,module:'surface.js',props:{label:'client'},now:0})
    expect(mounted.tree).toMatchObject({type:'Text',children:['client:1']})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
  })

  test('Client timeout stops only the failed instance and keeps the Worker usable', async () => {
    const clientPath = '/fixture/timeout-surface.js'
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:clientPath,source:`export default function Surface(props,s) {
      if(props.spin) while(true) {}
      return s.elements.Text({children:props.label});
    }`})
    fixture.clients = [{path:clientPath,module:'timeout-surface.js'}]
    const environment = await host().load(fixture)

    expect(await environment.client({op:'mount',id:2,module:'timeout-surface.js',props:{label:'healthy'},now:0})).toMatchObject({tree:{type:'Text',children:['healthy']}})
    await expect(environment.client({op:'mount',id:1,module:'timeout-surface.js',props:{label:'failed',spin:true},now:0})).rejects.toThrow('Script execution timed out')
    expect(await environment.client({op:'frame',id:1,now:1})).toEqual({stopped:true})
    expect(await environment.client({op:'frame',id:2,now:1})).toMatchObject({active:false})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
    expect(await environment.client({op:'mount',id:1,module:'timeout-surface.js',props:{label:'remounted'},now:2})).toMatchObject({tree:{type:'Text',children:['remounted']}})
  }, 10_000)

  test('Client calls may use more than 100ms of their one-second budget', async () => {
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/budget.js',source:`export default function Surface(_,s) {
      const started = performance.now();
      while(performance.now() - started < 200) {}
      return s.elements.Text({children:'within budget'});
    }`})
    fixture.clients = [{path:'/fixture/budget.js',module:'budget.js'}]
    const environment = await host().load(fixture)
    expect(await environment.client({op:'mount',id:1,module:'budget.js'})).toMatchObject({tree:{children:['within budget']}})
  })

  test.each(['update', 'resize', 'frame', 'pointer', 'key', 'press'] as const)('Client %s overrun is isolated and recoverable', async op => {
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/callback.js',source:`export default function Surface(props,s) {
      const spin = () => {while(true) {}};
      if (props.spin || s.columns) spin();
      if (s.state === undefined) {
        s.setState(0);
        s.every(10,spin); s.onPointer(spin); s.onKey(spin);
      }
      return s.elements.Button({key:'spin',label:props.label,onPress:spin});
    }`})
    fixture.clients = [{path:'/fixture/callback.js',module:'callback.js'}]
    const environment = await host().load(fixture)
    const mount = (id: number) => environment.client({op:'mount',id,module:'callback.js',props:{label:'healthy'},now:0})
    const first = await mount(1) as {tree:{press:{handle:number}}}
    await mount(2)
    const started = performance.now()
    const failed = environment.client({op,id:1,props:{spin:true},columns:1,rows:1,now:10,event:{key:'a'},handle:first.tree.press.handle})
    // A spinning drawing must not block hook dispatch or a sibling drawing.
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
    expect(await environment.client({op:'update',id:2,props:{label:'sibling'}})).toMatchObject({tree:{props:{label:'sibling'}}})
    await expect(failed).rejects.toThrow('Script execution timed out')
    expect(performance.now() - started).toBeGreaterThanOrEqual(900)
    expect(await environment.client({op:'frame',id:1,now:11})).toEqual({stopped:true})
    expect(await mount(1)).toMatchObject({tree:{props:{label:'healthy'}}})
  }, 10_000)

  test.each(['throw', 'bounds'])('Client %s unmounts only that instance', async failure => {
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/failure.js',source:`export default function Surface(props,s) {
      if (props.failure === 'throw') throw Error('draw failed');
      return s.elements.Text({children:props.failure === 'bounds' ? 'x'.repeat(100001) : props.label});
    }`})
    fixture.clients = [{path:'/fixture/failure.js',module:'failure.js'}]
    const environment = await host().load(fixture)
    const mount = (id: number) => environment.client({op:'mount',id,module:'failure.js',props:{label:'healthy'}})
    await mount(1); await mount(2)
    await expect(environment.client({op:'update',id:1,props:{failure}})).rejects.toThrow(failure === 'throw' ? 'draw failed' : '100000')
    expect(await environment.client({op:'frame',id:1})).toEqual({stopped:true})
    expect(await environment.client({op:'update',id:2,props:{label:'sibling'}})).toMatchObject({tree:{children:['sibling']}})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
    expect(await mount(1)).toMatchObject({tree:{children:['healthy']}})
  })

  test('Client instances load executable imports from the original snapshot without rerunning hook registration', async () => {
    const fixture = declaration(`globalThis.hookLoaded = true; export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push(
      {path:'/fixture/imported.js',source:`import {label} from './label.js';
        export function Surface(props,s) {
          if (globalThis.hookLoaded) throw Error('hook code ran in Client Worker');
          return h(s.elements.Text,{},label()+props.suffix);
        }`},
      {path:'/fixture/label.js',source:`export function label() {return 'snapshot:'}`},
    )
    fixture.links = [{from:'/fixture/imported.js',specifier:'./label.js',to:'/fixture/label.js'}]
    fixture.clients = [{path:'/fixture/imported.js',module:'imported.js'}]
    const environment = await host().load(fixture)
    fixture.modules[0]!.source = `throw Error('hook code must not run in Client Worker')`
    fixture.modules[2]!.source = `export function label() {return 'mutated:'}`
    fixture.links.length = 0
    fixture.clients.length = 0
    const mount = () => environment.client({op:'mount',id:1,module:'imported.js',props:{suffix:'ok'}})
    expect(await mount()).toMatchObject({tree:{children:['snapshot:ok']}})
    await environment.client({op:'dispose',id:1})
    expect(await mount()).toMatchObject({tree:{children:['snapshot:ok']}})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
  })

  test('Client module evaluation failure stays out of the hook environment', async () => {
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/evaluation.js',source:`throw Error('Client import failed'); export default function Surface() {return null}`})
    fixture.clients = [{path:'/fixture/evaluation.js',module:'evaluation.js'}]
    const environment = await host().load(fixture)
    await expect(environment.client({op:'mount',id:1,module:'evaluation.js'})).rejects.toThrow('Client import failed')
    expect(await environment.client({op:'frame',id:1})).toEqual({stopped:true})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
  })

  test.each(['dispose', 'remount', 'unload'] as const)('Client %s cancels active and queued calls without harming other environments', async mode => {
    const worker = host()
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/cancel.js',source:`export default function Surface(props,s) {
      if(props.spin) while(true) {}
      return s.elements.Text({children:'healthy'});
    }`})
    fixture.clients = [{path:'/fixture/cancel.js',module:'cancel.js'}]
    const environment = await worker.load(fixture)
    const sibling = await worker.load(fixture)
    const mount = () => environment.client({op:'mount',id:1,module:'cancel.js',props:{}})
    await mount()
    const active = environment.client({op:'update',id:1,props:{spin:true}}).catch(error => error)
    const queued = environment.client({op:'frame',id:1}).catch(error => error)
    // Let the active call enter the drawing Worker before canceling it.
    await new Promise(resolve => setTimeout(resolve, 30))
    if (mode === 'unload') await environment.dispose()
    else if (mode === 'dispose') await environment.client({op:'dispose',id:1})
    else expect(await mount()).toMatchObject({tree:{children:['healthy']}})
    expect((await active).message).toMatch(/unmounted|unloaded/)
    expect((await queued).message).toMatch(/unmounted|unloaded/)
    expect(await sibling.client({op:'mount',id:1,module:'cancel.js',props:{}})).toMatchObject({tree:{children:['healthy']}})
    expect(await sibling.invoke(sibling.registrations[0]!.id,[])).toBe('alive')
    if (mode !== 'unload') expect(await mount()).toMatchObject({tree:{children:['healthy']}})
  })

  test('Client Worker exit and environment unload terminate only their owned instances', async () => {
    const fixture = declaration(`export function register(on) {on('tool.call', () => 'alive')}`)
    fixture.modules.push({path:'/fixture/exit.js',source:`export default function Surface(_,s) {return s.elements.Text({children:'healthy'})}`})
    fixture.clients = [{path:'/fixture/exit.js',module:'exit.js'}]
    const environment = await host().load(fixture)
    const RealWorker = globalThis.Worker
    const natives: Worker[] = []
    const closed: Promise<void>[] = []
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        natives.push(this)
        closed.push(new Promise(resolve => this.addEventListener('close', () => resolve(), {once:true})))
      }
    } as typeof Worker
    try {
      await environment.client({op:'mount',id:1,module:'exit.js'})
      await environment.client({op:'mount',id:2,module:'exit.js'})
    } finally { globalThis.Worker = RealWorker }
    expect(natives).toHaveLength(2)
    natives[0]!.terminate()
    await closed[0]
    expect(await environment.client({op:'frame',id:1})).toEqual({stopped:true})
    expect(await environment.client({op:'frame',id:2})).toEqual({active:false})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
    await environment.dispose()
    await closed[1]
  })

  test('worker exit rejects pending calls and disposal remains idempotent', async () => {
    const RealWorker = globalThis.Worker
    const natives: Worker[] = []
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); natives.push(this) }
    } as typeof Worker
    const died = Promise.withResolvers<Error>()
    let worker: ReturnType<typeof createModEnvironmentHost>
    try { worker = createModEnvironmentHost({ onDied: error => died.resolve(error) }); hosts.push(worker) }
    finally { globalThis.Worker = RealWorker }
    const started = Promise.withResolvers<void>()
    const environment = await worker.load(declaration(`export function register(on) { on('tool.call', async ($) => { await $.started(); await new Promise(() => {}); }); }`))
    const failure = environment.invoke(environment.registrations[0]!.id, [{ started: () => { started.resolve() } }]).then(() => null, error => error)
    await started.promise
    natives[0]!.terminate()
    expect((await failure).message).toContain('exited')
    expect((await died.promise).message).toContain('exited')
    await Promise.all([worker.dispose(), worker.dispose(), environment.dispose()])
  })

  test('terminates an unresponsive Worker during a callable invocation without next', async () => {
    const worker = host()
    const environment = await worker.load(declaration(`export function register(on) {
      on('tool.call', () => ({ spin: () => { while (true) {} } }));
    }`))
    const value = await environment.invoke(environment.registrations[0]!.id, []) as { spin(): Promise<unknown> }
    const failure = value.spin().then(() => null, error => error)
    let timeout: ReturnType<typeof setTimeout>
    const result = await Promise.race([
      failure,
      new Promise(resolve => { timeout = setTimeout(() => resolve('watchdog did not fire'), 7500) }),
    ]).finally(() => clearTimeout(timeout))
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('unresponsive')
  }, 10000)

  test('next.signal abort actively cancels sleep and exposes read-only signal state', async () => {
    const started = Promise.withResolvers<number>()
    const canceled: number[] = []
    const controller = new AbortController()
    const clock = createModClockBridge({
      now: async () => 0,
      wait: (_kind, _ms, id) => { started.resolve(id); return new Promise(() => {}) },
      cancel: id => { canceled.push(id) },
    })
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        const signal = next.signal;
        let calls = 0;
        const removed = () => { calls += 100; };
        signal.addEventListener('abort', removed); signal.removeEventListener('abort', removed);
        signal.addEventListener('abort', () => { calls++; }, { once: true });
        let readonly = false;
        try { signal.aborted = true; } catch { readonly = true; }
        try { await $.clock.sleep(10000, { signal }); }
        catch (error) {
          let sameReason = false;
          try { signal.throwIfAborted(); } catch (reason) { sameReason = reason === signal.reason; }
          return { calls, readonly, aborted: signal.aborted, sameReason, name: error.name };
        }
      });
    }`))
    const frame = next(async () => ({})); frame.signal = controller.signal
    const result = environment.invoke(environment.registrations[0]!.id, [{ clock }, {}], frame)
    const id = await started.promise
    controller.abort()
    expect(await result).toEqual({ calls: 1, readonly: true, aborted: true, sameReason: true, name: 'AbortError' })
    expect(canceled).toEqual([id])
  })

  test('roundtrips existing host nouns and caches module functions without freezing local state', async () => {
    const environment = await host().load(declaration(`let local = { count: 0 }; const read = () => ++local.count;
      export function register(on) {
        on('engine.create', async ($, e, next) => {
          const beneath = await next(e);
          return { original: beneath.clock.now, a: read, b: read, frozen: [Object.isFrozen($), Object.isFrozen(e), Object.isFrozen(beneath)] };
        });
        on('tool.call', ($, e) => ({ same: e.a === read && e.a === e.b, count: e.a() }));
      }`))
    const now = async () => 12
    const frame = next(async () => ({ clock: { now } }))
    const first = await environment.invoke(environment.registrations[0]!.id, [{}, {}], frame) as any
    const second = await environment.invoke(environment.registrations[0]!.id, [{}, {}], frame) as any
    expect(first.original).toBe(now)
    expect(first.a).toBe(first.b)
    expect(first.a).toBe(second.a)
    expect(first.frozen).toEqual([true, true, true])
    expect(await environment.invoke(environment.registrations[1]!.id, [{}, { a: first.a, b: second.a }])).toEqual({ same: true, count: 1 })
    expect(await first.a()).toBe(2)
    const other = await host().load(declaration(`export function register(on) { on('tool.call', e => e); }`))
    const failure = await other.invoke(other.registrations[0]!.id, [first.a]).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('environment')
  })

  test('trace updates for successive branches and rejected next.to calls', async () => {
    const spec = declaration(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        const before = next.trace.map(item => item.outcome);
        await next(e);
        const first = next.trace;
        try { await next.to(e, 'core'); } catch {}
        return { before, first, last: next.trace };
      });
    }`)
    spec.nextTiers = ['core']
    const environment = await host().load(spec)
    let trace = [{ plugin: 'initial', tier: 'core' as const, outcome: 'initial', received: {} }]
    const frame = next(async () => { trace = [{ plugin: 'first', tier: 'core', outcome: 'returned', received: {} }]; return {} })
    frame.to = async () => { trace = [{ plugin: 'last', tier: 'core', outcome: 'threw', received: {} }]; throw Error('beneath failure') }
    Object.defineProperty(frame, 'trace', { get: () => trace })
    const value = await environment.invoke(environment.registrations[0]!.id, [{}, {}], frame) as any
    expect(value.before).toEqual(['initial'])
    expect(value.first[0].plugin).toBe('first')
    expect(value.last[0].plugin).toBe('last')
    expect(value.last[0].outcome).toBe('threw')
  })

  test('next.trace follows the last host branch and next handles expire independently of capabilities', async () => {
    const trace: ModNext['trace'][number][] = []
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        const before = next.trace.length;
        await next(e);
        return { before, trace: next.trace, exact: next.is('tool.call') && next.is('tool.*') && next.is('!tool.list') && !next.is('!tool.call') && !next.is('invalid'), later: () => next(e), clock: () => $.clock.now() };
      });
    }`))
    const frame = next(async () => {
      trace.push({ index: 0, event: 'tool.call', ms: 0, plugin: 'beneath', tier: 'core', outcome: 'returned', received: {}, returned: { ok: true } })
      return {}
    })
    Object.defineProperty(frame, 'trace', { get: () => trace })
    const value = await environment.invoke(environment.registrations[0]!.id, [{ clock: { now: async () => 9 } }, {}], frame) as any
    expect(value.before).toBe(0)
    expect(value.trace).toEqual(trace)
    expect(value.exact).toBe(true)
    trace.length = 0
    expect(value.trace).toHaveLength(1)
    expect(await value.clock()).toBe(9)
    const failure = await value.later().then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('settled')
  })

  test('dispose is bounded and idempotent with a pending invocation', async () => {
    const started = Promise.withResolvers<void>()
    const worker = host()
    const environment = await worker.load(declaration(`export function register(on) {
      on('tool.call', async ($) => { await $.started(); await new Promise(() => {}); });
    }`))
    const result = environment.invoke(environment.registrations[0]!.id, [{ started: () => { started.resolve() } }]).then(() => null, error => error)
    await started.promise
    await Promise.all([environment.dispose(), environment.dispose(), worker.dispose(), worker.dispose()])
    const failure = await result
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toMatch(/unloaded|disposed/)
    const unloaded = await environment.invoke(environment.registrations[0]!.id, []).then(() => null, error => error)
    expect(unloaded.message).toContain('unloaded')
  })

  test('accepts primitive equality matchers and rejects unsupported actual event syntax', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', { tool: 'Bash', enabled: true, count: -1, optional: null }, () => ({}));
    }`))
    expect(environment.registrations[0]!.matcher).toEqual({ tool: 'Bash', enabled: true, count: -1, optional: null })
    for (const event of ['ui.unknown', 'constructor.call']) {
      const spec = declaration(`export function register(on) { on('${event}', () => ({})); }`)
      spec.events.push(event)
      const error = await host().load(spec).then(() => null, error => error)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toMatch(/event/)
    }
  })

  test('accepts official matchers, rejects matcher accessors, and checks next tiers at the boundary', async () => {
    for (const matcher of ['{ tool: /Bash/ }', '{ tool: { equal: "Bash" } }']) {
      const environment = await host().load(declaration(`export function register(on) { on('tool.call', ${matcher}, () => ({})); }`))
      expect(environment.registrations[0]!.matcher).toBeDefined()
    }
    const matcherError = await host().load(declaration(`export function register(on) { on('tool.call', { get tool() { throw Error("getter ran"); } }, () => ({})); }`)).then(() => null, error => error)
    expect(matcherError).toBeInstanceOf(Error)
    expect(matcherError.message).toContain('matcher')
    expect(matcherError.message).not.toContain('getter ran')
    const environment = await host().load(declaration(`export function register(on) { on('tool.call', ($, e, next) => next.to(e, 'core')); }`))
    let called = false
    const error = await environment.invoke(environment.registrations[0]!.id, [{}, {}], next(async () => { called = true })).then(() => null, error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('tier')
    expect(called).toBe(false)
  })

  test('rejects callable then fields instead of assimilating remote functions as promises', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', () => ({ then() {} }));
    }`))
    const failure = await environment.invoke(environment.registrations[0]!.id, []).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('thenable')
  })

  test('rejects module then accessors before Promise assimilation executes them in the Worker', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', () => ({ get then() { throw Error('then getter ran'); } }));
    }`))
    const failure = await environment.invoke(environment.registrations[0]!.id, []).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('accessors')
    expect(failure.message).not.toContain('getter ran')
  })

  test('rejects proxies and accessors without evaluating boundary getters or hanging RPCs', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', async ($, e) => {
        if (e === 'host') return $.read();
        if (e === 'throw') throw new Proxy({}, { getOwnPropertyDescriptor() { throw Error('trap ran'); } });
        if (e === 'proxy') return new Proxy({}, { ownKeys() { throw Error('trap ran'); } });
        return { get value() { throw Error('getter ran'); } };
      });
    }`))
    let gets = 0
    const hostValue = Object.defineProperty({}, 'value', { enumerable: true, get() { gets++; return 1 } })
    for (const mode of ['host', 'throw', 'proxy', 'getter']) {
      const failure = await environment.invoke(environment.registrations[0]!.id, [{ read: () => hostValue }, mode]).then(() => null, error => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).not.toMatch(/getter ran|trap ran/)
    }
    const failure = await environment.invoke(environment.registrations[0]!.id, [new Proxy({}, { ownKeys() { gets++; return [] } }), 'host']).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(gets).toBe(0)
  })

  test('awaits register, copies options and invokes next through real-time RPC', async () => {
    const environment = await host().load(declaration(`
      export async function register(on, options) {
        await Promise.resolve();
        on('tool.call', async ($, e, next) => {
          const time = await $.clock.now();
          return next({ ...e, command: options.label + time });
        });
      }
    `))
    expect(environment.registrations).toHaveLength(1)
    const inputs: unknown[] = []
    const value = await environment.invoke(environment.registrations[0]!.id,
      [{ clock: { now: async () => 42 } }, { tool: 'Bash', command: 'old' }],
      next(async input => { inputs.push(input); return { result: input.command } }),
    )
    expect(inputs).toEqual([{ tool: 'Bash', command: 'configured42' }])
    expect(value).toEqual({ result: 'configured42' })
  })

  test('keeps module states separate and returns callable noun handles', async () => {
    const worker = host()
    const spec = declaration(`let calls = 0; export function register(on) {
      on('engine.create', () => ({ counter: { read: () => ++calls } }));
    }`)
    const a = await worker.load(spec)
    const b = await worker.load(spec)
    const first = await a.invoke(a.registrations[0]!.id, []) as { counter: { read(): Promise<number> } }
    const second = await b.invoke(b.registrations[0]!.id, []) as typeof first
    expect(await first.counter.read()).toBe(1)
    expect(await first.counter.read()).toBe(2)
    expect(await second.counter.read()).toBe(1)
    await a.dispose()
    await expect(first.counter.read()).rejects.toThrow('unloaded')
    expect(await second.counter.read()).toBe(2)
  })

  test('keeps host functions and globals outside the author realm', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', ($) => {
        let blocked = false;
        try { $.clock.now.constructor('return process')(); } catch { blocked = true; }
        return { result: [blocked, typeof process, typeof Bun, typeof ShadowRealm, typeof WebAssembly] };
      });
    }`))
    expect(await environment.invoke(environment.registrations[0]!.id, [{ clock: { now: async () => 0 } }])).toEqual({
      result: [true, 'undefined', 'undefined', 'undefined', 'undefined'],
    })
  })

  test('executes loader output with exactly the official hooks realm globals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-globals-'))
    roots.push(root)
    const entrypoint = join(root, 'main.js')
    await writeFile(entrypoint, `export function register(on) {
      const globals = {
        AbortSignal, AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
        atob, btoa, structuredClone, crypto, performance,
      };
      on('tool.call', async () => ({
        types: Object.fromEntries(Object.entries(globals).map(([name, value]) => [name, typeof value])),
        console: typeof console,
        encoded: Array.from(new TextEncoder().encode('ok')),
        decoded: new TextDecoder().decode(new Uint8Array([111, 107])),
        url: new URL('/path?q=1', 'https://example.com').href,
        query: new URLSearchParams([['a', 'b']]).toString(),
        base64: btoa(atob('b2s=')),
        cloned: structuredClone({ value: 1 }).value,
        uuid: crypto.randomUUID(),
        random: Array.from(crypto.getRandomValues(new Uint8Array(2))).length,
        digest: (await crypto.subtle.digest('SHA-256', new Uint8Array())).byteLength,
        now: performance.now(),
        aborted: AbortSignal.abort('done').aborted,
        controlled: new AbortController().signal.aborted,
      }));
    }`)
    const spec = await loadModDeclaration({
      name: 'fixture', storageId: 'fixture@local', pluginRoot: root, entrypoints: [entrypoint],
    })
    const environment = await host().load(spec)
    const result = await environment.invoke(environment.registrations[0]!.id, []) as any

    expect(result.types).toEqual({
      AbortSignal: 'function', AbortController: 'function', TextEncoder: 'function', TextDecoder: 'function',
      URL: 'function', URLSearchParams: 'function', atob: 'function', btoa: 'function',
      structuredClone: 'function', crypto: 'object', performance: 'object',
    })
    expect(result.console).toBe('undefined')
    expect(result.encoded).toEqual([111, 107])
    expect(result.decoded).toBe('ok')
    expect(result.url).toBe('https://example.com/path?q=1')
    expect(result.query).toBe('a=b')
    expect(result.base64).toBe('b2s=')
    expect(result.cloned).toBe(1)
    expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.random).toBe(2)
    expect(result.digest).toBe(32)
    expect(result.now).toBeGreaterThanOrEqual(0)
    expect(result.aborted).toBe(true)
    expect(result.controlled).toBe(false)
  })

  test('drops register return, closes registration window, rejects absent scan events', async () => {
    const environment = await host().load(declaration(`export function register(on) {
      on('tool.call', () => { on('tool.call', () => ({})); });
      return () => { throw Error('not a disposer'); };
    }`))
    const failure = await environment.invoke(environment.registrations[0]!.id, []).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('only available during register')
    await environment.dispose()
    const absent = await host().load(declaration(`export function register(on) { on('custom.render', () => ({})); }`)).then(() => null, error => error)
    expect(absent).toBeInstanceOf(Error)
    expect(absent.message).toContain('absent from scan')
  })
})
