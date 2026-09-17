import { afterEach, describe, expect, test } from 'bun:test'
import { createModClockBridge, createModEnvironmentHost } from './environment.js'
import type { ModDeclaration, ModNext } from './types.js'
import { dispatchModEvent } from './dispatch.js'

const hosts: ReturnType<typeof createModEnvironmentHost>[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())) })

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
    origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
  })
}

describe('Mods Worker environment', () => {
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
        return { before, trace: next.trace, exact: next.is('tool.call') && !next.is('tool.*'), later: () => next(e), clock: () => $.clock.now() };
      });
    }`))
    const frame = next(async () => {
      trace.push({ plugin: 'beneath', tier: 'core', outcome: 'returned', received: {}, returned: { ok: true } })
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
