import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(source: string, name = 'fixture') {
  const root = await mkdtemp(join(tmpdir(), 'mods-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@inline', pluginRoot: root, entrypoints: [entry] }
}
function runtime() {
  const events: { plugin: string; stage: string; message: string }[] = []
  const value = createModsRuntime({ onDiagnostic: event => events.push(event) })
  cleanups.push(() => value.dispose())
  return { value, events }
}
const input = { tool: 'Bash', tool_use_id: 'test-call', command: 'original' }

describe('Mods lifecycle', () => {
  test('starts once per activation, not when conversation binding changes', async () => {
    const plugin = await fixture(`let starts = 0;
      export function register(on, options) {
        on('session.start', ($, e, next) => { starts++; return next(e) });
        on('tool.call', () => ({ result: { starts, label: options.label } }));
      }`)
    const { value } = runtime()
    await value.reconcile([{ ...plugin, options: { label: 'one' } }])
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'a' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: { starts: 1, label: 'one' } })
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'b' })
    await value.reconcile([{ ...plugin, options: { label: 'one' } }])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: { starts: 1, label: 'one' } })
    await value.reconcile([{ ...plugin, options: { label: 'two' } }])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: { starts: 1, label: 'two' } })
  })

  test('awaits real clock.sleep during session start before releasing bind', async () => {
    const plugin = await fixture(`let started = false;
      export function register(on) {
        on('session.start', async ($, e, next) => { await $.clock.sleep(5); started = true; return next(e) });
        on('tool.call', () => ({ result: started }));
      }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'a' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: false }))).toEqual({ result: true })
  })

  test('keeps a previous activation on syntax failure and removes disabled plugins', async () => {
    const plugin = await fixture(`export function register(on) { on('tool.call', () => ({ result: 'old' })); }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    await writeFile(plugin.entrypoints[0]!, 'export function register(')
    await value.reconcile([plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
    expect(events.some(event => event.stage === 'reload' && event.message.includes('previous'))).toBe(true)
    await value.reconcile([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
  })

  test('pins an in-flight activation across reload, then serves new code', async () => {
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($, e, next) => { const result = await next(e); return { result: 'old:' + result.result }; });
    }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const pending = value.dispatch('tool.call', input, async () => { entered.resolve(); await finish.promise; return { result: 'core' } })
    await entered.promise
    await writeFile(plugin.entrypoints[0]!, `export function register(on) { on('tool.call', () => ({ result: 'new' })); }`)
    await value.reconcile([plugin])
    finish.resolve()
    expect(await pending).toEqual({ result: 'old:core' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'new' })
  })

  test('rebuilds the old noun interface when a replacement fold fails', async () => {
    const plugin = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'old' } }; });
      on('tool.call', async ($) => ({ result: await $.greeting.read() }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
    await writeFile(plugin.entrypoints[0]!, `export function register(on) {
      on('engine.create', () => { throw new Error('broken fold') });
      on('tool.call', () => ({ result: 'new' }));
    }`)
    await value.reconcile([plugin])
    expect(events.some(event => event.stage === 'engine.create')).toBe(true)
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
  })

  test('engine.create receives no capabilities and can withhold the core clock', async () => {
    const policy = await fixture(`export function register(on) {
      on('engine.create', () => ({}));
    }`, 'policy')
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($) => ({ result: await $.clock.now() }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([{ ...policy, tier: 'prepend' }, plugin])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.plugin === 'fixture' && event.stage === 'tool.call')).toBe(true)
  })

  test('rejects replacing the core clock and rebuilds without the failed plugin', async () => {
    const policy = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, clock: { now: () => 1 } }; });
      on('tool.call', () => ({ result: 'should not run' }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([policy])
    expect(events.some(event => event.stage === 'engine.create' && event.message.includes('replace noun clock'))).toBe(true)
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
  })

  test('passes a callable noun through other VM folds and invokes its provider', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'hello' } }; });
    }`, 'provider')
    const consumer = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built }; });
      on('tool.call', async ($) => ({ result: await $.greeting.read() }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([consumer, provider])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'hello' })
  })

  test('does not re-run admission hooks for unchanged declarations or twice on reload', async () => {
    const judge = await fixture(`let count = 0; export function register(on) {
      on('plugin.register', ($, e, next) => { count++; return next(e) });
      on('tool.call', () => ({ result: count }));
    }`, 'judge')
    const plugin = await fixture(`export function register(on) { on('session.start', ($,e,next) => next(e)); }`)
    const { value, events } = runtime()
    await value.reconcile([{ ...judge, tier: 'prepend' }, plugin])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    await value.reconcile([{ ...judge, tier: 'prepend' }, plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    await value.reconcile([{ ...judge, tier: 'prepend' }, { ...plugin, options: { change: true } }])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 2 })
  })

  test('keeps core execution single when a runtime is disposed during an in-flight tool', async () => {
    const plugin = await fixture(`export function register(on) { on('tool.call', ($, e, next) => next(e)); }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const pending = value.dispatch('tool.call', input, async () => { calls++; entered.resolve(); await release.promise; return { result: 'done' } }).then(() => null, error => error)
    await entered.promise
    await value.dispose()
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    expect(calls).toBe(1)
    await value.dispose()
  })

  test('does not rebuild unchanged engine.create declarations', async () => {
    const plugin = await fixture(`let builds = 0; export function register(on) {
      on('engine.create', async ($, e, next) => { builds++; const built = await next(e); return { ...built }; });
      on('tool.call', () => ({ result: builds }));
    }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    await value.reconcile([plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 1 })
  })

  test('surviving consumers cannot call a removed provider through captured methods', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'hello' } }; });
    }`, 'provider')
    const consumer = await fixture(`let read; export function register(on) {
      on('tool.call', async ($) => { if (!read) read = () => $.greeting.read(); return { result: await read() }; });
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([consumer, provider])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'hello' })
    await value.reconcile([consumer])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.stage === 'tool.call' && event.message.includes('withdrawn'))).toBe(true)
  })

  test('does not publish a candidate when disposal overlaps async register', async () => {
    const plugin = await fixture(`export async function register(on) {
      await Promise.resolve(); on('tool.call', () => ({ result: 'unexpected' }));
    }`)
    const { value } = runtime()
    const loading = value.reconcile([plugin]).then(() => null, error => error)
    await value.dispose()
    expect(await loading).toBeInstanceOf(Error)
    expect(value.hasHooks('tool.call')).toBe(false)
  })

  test('noun middleware rewrites the actual arguments delivered to its provider', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: value => value.message } }; });
    }`, 'provider')
    const policy = await fixture(`export function register(on) {
      on('greeting.read', ($, e, next) => next({ ...e, message: 'rewritten' }));
    }`, 'policy')
    const consumer = await fixture(`export function register(on) {
      on('tool.call', async ($) => ({ result: await $.greeting.read({ message: 'original' }) }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([policy, consumer, provider])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'rewritten' })
  })

  test('pins queued dispatch generations until the batch releases its snapshot', async () => {
    const plugin = await fixture(`export function register(on) { on('tool.call', () => ({ result: 'old' })); }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    const snapshot = value.capture()
    await writeFile(plugin.entrypoints[0]!, `export function register(on) { on('tool.call', () => ({ result: 'new' })); }`)
    await value.reconcile([plugin])
    expect(await snapshot.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'new' })
    snapshot.release()
    snapshot.release()
    expect(await snapshot.dispatch('tool.call', input, async () => ({ result: 'core' })).then(() => null, error => error)).toBeInstanceOf(Error)
  })

  test('clock.sleep middleware may return void without producing a failure diagnostic', async () => {
    const policy = await fixture(`export function register(on) {
      on('clock.sleep', ($, e, next) => next({ ...e, ms: 0 }));
    }`, 'policy')
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($) => { await $.clock.sleep(5); return { result: 'awake' }; });
    }`)
    const { value, events } = runtime()
    await value.reconcile([policy, plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'awake' })
    expect(events).toEqual([])
  })

  test('supports exact next.is in scanned hooks including engine.create', async () => {
    const plugin = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { if (!next.is('engine.create', e)) throw Error('wrong event'); return next(e); });
      on('tool.call', ($, e, next) => ({ result: next.is('tool.call', e) && !next.is('session.start', e) }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: true })
  })

  test('timer callbacks drain across reload before the retired environment is released', async () => {
    const observer = await fixture(`let started, release, finish;
      const began = new Promise(resolve => { started = resolve });
      const hold = new Promise(resolve => { release = resolve });
      const done = new Promise(resolve => { finish = resolve });
      export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, observer: {
          hold: async () => { started(); await hold; }, finish: () => { finish(); }
        } }; });
        on('tool.call', { command: 'started' }, async () => { await began; return { result: 'started' }; });
        on('tool.call', { command: 'release' }, () => { release(); return { result: 'released' }; });
        on('tool.call', { command: 'done' }, async () => { await done; return { result: 'done' }; });
      }`, 'observer')
    const plugin = await fixture(`export function register(on) {
      on('session.start', ($, e, next) => { $.clock.after(0, async () => { await $.observer.hold(); await $.observer.finish(); }); return next(e); });
    }`)
    const { value } = runtime()
    await value.reconcile([observer, plugin])
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'timer' })
    expect(await value.dispatch('tool.call', { ...input, command: 'started' }, async () => ({ result: 'core' }))).toEqual({ result: 'started' })
    await value.reconcile([observer])
    await value.dispatch('tool.call', { ...input, command: 'release' }, async () => ({ result: 'core' }))
    expect(await value.dispatch('tool.call', { ...input, command: 'done' }, async () => ({ result: 'core' }))).toEqual({ result: 'done' })
  })

  test('retains the old provider for an already-entered consumer hook during provider reload', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'old' } }; });
    }`, 'provider')
    const consumer = await fixture(`export function register(on) {
      on('tool.call', async ($, e, next) => { await next(e); return { result: await $.greeting.read() }; });
    }`, 'consumer')
    const { value } = runtime()
    await value.reconcile([consumer, provider])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending = value.dispatch('tool.call', input, async () => { entered.resolve(); await release.promise; return { result: 'core' } })
    await entered.promise
    await writeFile(provider.entrypoints[0]!, `export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'new' } }; });
    }`)
    await value.reconcile([consumer, provider])
    release.resolve()
    expect(await pending).toEqual({ result: 'old' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'new' })
  })

  test('pins provider generations for a timer callback entered after session start', async () => {
    const gate = await fixture(`let start, release, finish;
      const began = new Promise(resolve => { start = resolve });
      const hold = new Promise(resolve => { release = resolve });
      const done = new Promise(resolve => { finish = resolve });
      export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, gate: {
          hold: async () => { start(); await hold; }, finish: () => { finish(); }
        } }; });
        on('tool.call', { command: 'started' }, async () => { await began; return { result: 'started' }; });
        on('tool.call', { command: 'release' }, () => { release(); return { result: 'released' }; });
        on('tool.call', { command: 'done' }, async ($, e, next) => { await done; return next(e); });
      }`, 'gate')
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'old' } }; });
    }`, 'provider')
    const plugin = await fixture(`let result; export function register(on) {
      on('session.start', ($, e, next) => { $.clock.after(0, async () => { await $.gate.hold(); result = await $.greeting.read(); await $.gate.finish(); }); return next(e); });
      on('tool.call', () => ({ result }));
    }`)
    const { value } = runtime()
    await value.reconcile([gate, plugin, provider])
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'timer' })
    await value.dispatch('tool.call', { ...input, command: 'started' }, async () => ({ result: 'core' }))
    await writeFile(provider.entrypoints[0]!, `export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'new' } }; });
    }`)
    await value.reconcile([gate, plugin, provider])
    await value.dispatch('tool.call', { ...input, command: 'release' }, async () => ({ result: 'core' }))
    expect(await value.dispatch('tool.call', { ...input, command: 'done' }, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
  })

  test('worker failure does not replay an entered core and rebuilds declarations once', async () => {
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($, e, next) => { const result = await next(e); return { result: 'mod:' + result.result }; });
    }`)
    const RealWorker = globalThis.Worker
    const natives: Worker[] = []
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); natives.push(this) }
    } as typeof Worker
    const died = Promise.withResolvers<void>()
    let value: ReturnType<typeof createModsRuntime>
    try { value = createModsRuntime({ onDiagnostic: event => { if (event.stage === 'worker') died.resolve() } }) }
    finally { globalThis.Worker = RealWorker }
    cleanups.push(() => value.dispose())
    await value.reconcile([plugin])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const pending = value.dispatch('tool.call', input, async () => { calls++; entered.resolve(); await release.promise; return { result: 'core' } })
    await entered.promise
    natives[0]!.terminate()
    await died.promise
    release.resolve()
    expect(await pending).toEqual({ result: 'core' })
    expect(calls).toBe(1)
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'recovered' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'new core' }))).toEqual({ result: 'mod:new core' })
  })

  test('allows manual reload after the single automatic Worker recovery fails', async () => {
    const plugin = await fixture(`export function register(on) { on('tool.call', () => ({ result: 'recovered' })); }`)
    const RealWorker = globalThis.Worker
    const workers: Worker[] = []
    globalThis.Worker = class extends RealWorker {
      private readonly fails: boolean
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); workers.push(this); this.fails = workers.length === 2
      }
      postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        if (this.fails && (message as { type?: string }).type === 'load') this.terminate()
        else if (Array.isArray(options)) super.postMessage(message, options)
        else super.postMessage(message, options)
      }
    } as typeof Worker
    const failed = Promise.withResolvers<void>()
    const value = createModsRuntime({ onDiagnostic: event => { if (event.stage === 'recovery') failed.resolve() } })
    cleanups.push(() => value.dispose())
    try {
      await value.reconcile([plugin])
      workers[0]!.terminate()
      await failed.promise
      expect(workers).toHaveLength(2)
      await value.reconcile([plugin])
      expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'recovered' })
      expect(workers).toHaveLength(3)
    } finally { globalThis.Worker = RealWorker }
  })

  test('reports asynchronous timer failures with their plugin owner', async () => {
    const plugin = await fixture(`export function register(on) {
      on('session.start', ($, e, next) => { $.clock.after(0, () => { throw Error('callback failed'); }); return next(e); });
    }`)
    const reported = Promise.withResolvers<{ plugin: string; stage: string; message: string }>()
    const value = createModsRuntime({ onDiagnostic: event => { reported.resolve(event) } })
    cleanups.push(() => value.dispose())
    await value.reconcile([plugin])
    await value.bind({ cwd: plugin.pluginRoot, surface: null, isInteractive: false, sessionId: 'timer' })
    expect(await reported.promise).toEqual({ plugin: 'fixture', stage: 'async', message: 'callback failed' })
  })

  test('applies changed plugin ordering without reactivating unchanged declarations', async () => {
    const first = await fixture(`let starts = 0; export function register(on) {
      on('session.start', ($, e, next) => { starts++; return next(e); });
      on('tool.call', () => ({ result: 'first:' + starts }));
    }`, 'first')
    const second = await fixture(`let starts = 0; export function register(on) {
      on('session.start', ($, e, next) => { starts++; return next(e); });
      on('tool.call', () => ({ result: 'second:' + starts }));
    }`, 'second')
    const { value } = runtime()
    await value.reconcile([first, second])
    await value.bind({ cwd: first.pluginRoot, surface: null, isInteractive: false, sessionId: 'order' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'first:1' })
    await value.reconcile([second, first])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'second:1' })
  })

  test('invalid noun middleware output recovers the provider value', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'hello' } }; });
    }`, 'provider')
    const policy = await fixture(`export function register(on) { on('greeting.read', () => ({})); }`, 'policy')
    const consumer = await fixture(`export function register(on) { on('tool.call', async ($) => ({ result: await $.greeting.read() })); }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([policy, consumer, provider])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'hello' })
    expect(events.some(event => event.stage === 'greeting.read')).toBe(true)
  })

  test('refusal at reload removes the previously admitted activation', async () => {
    const judge = await fixture(`export function register(on) {
      on('plugin.register', ($, e, next) => e.uses.events.includes('session.start') ? { refuse: 'not now' } : next(e));
    }`, 'judge')
    const plugin = await fixture(`export function register(on) { on('tool.call', () => ({ result: 'old' })); }`)
    const { value } = runtime()
    await value.reconcile([{ ...judge, tier: 'prepend' }, plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
    await writeFile(plugin.entrypoints[0]!, `export function register(on) { on('session.start', ($,e,next) => next(e)); on('tool.call', () => ({ result: 'new' })); }`)
    await value.reconcile([{ ...judge, tier: 'prepend' }, plugin])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
  })
})
