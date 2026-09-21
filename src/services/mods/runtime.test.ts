import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import type { ModTier } from './types.js'

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

describe('Mods public turn lifetime', () => {
  test('publishes synchronously without hooks and ends idempotently', () => {
    const { value } = runtime()
    expect(value.activePublicTurnId).toBeUndefined()
    const end = value.beginPublicTurn('public-turn')
    expect(value.activePublicTurnId).toBe('public-turn')
    end()
    expect(value.activePublicTurnId).toBeUndefined()
    end()
    expect(value.activePublicTurnId).toBeUndefined()
  })

  test.each(['newer-turn', 'same-turn'])('older cleanup cannot clear a newer lifetime with id %s', turnId => {
    const { value } = runtime()
    const endOlder = value.beginPublicTurn('same-turn')
    const endNewer = value.beginPublicTurn(turnId)
    endOlder()
    expect(value.activePublicTurnId).toBe(turnId)
    endNewer()
    expect(value.activePublicTurnId).toBeUndefined()
    endOlder()
    expect(value.activePublicTurnId).toBeUndefined()
  })

  test('ending the newest turn does not restore an older turn', () => {
    const { value } = runtime()
    const endOlder = value.beginPublicTurn('older')
    const endNewer = value.beginPublicTurn('newer')
    endNewer()
    expect(value.activePublicTurnId).toBeUndefined()
    endOlder()
    expect(value.activePublicTurnId).toBeUndefined()
  })

  test('disposal clears the public turn before awaiting teardown', async () => {
    const { value } = runtime()
    const end = value.beginPublicTurn('public-turn')
    const disposed = value.dispose()
    expect(value.activePublicTurnId).toBeUndefined()
    end()
    await disposed
    expect(() => value.beginPublicTurn('after-disposal')).toThrow('Mods runtime disposed')
    expect(value.activePublicTurnId).toBeUndefined()
  })
})

describe('Mods lifecycle', () => {
  test('live and captured hook discovery use the same event patterns as dispatch', async () => {
    const plugin = await fixture(`export function register(on) {
      on('classic.*', ($, e, next) => next(e));
      on('!ui.*', ($, e, next) => next(e));
    }`)
    const {value, events} = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([])
    const snapshot = value.capture()
    try {
      for (const subject of [value, snapshot]) {
        expect(subject.hasHooks('classic.PreToolUse')).toBe(true)
        expect(subject.hasHooks('prompt.submit')).toBe(true)
        expect(subject.hasHooks('ui.render')).toBe(false)
      }
      await value.reconcile([])
      expect(value.hasHooks('classic.PreToolUse')).toBe(false)
      expect(snapshot.hasHooks('classic.PreToolUse')).toBe(true)
    } finally { snapshot.release() }
  })

  test('engine.create is lazy and preserves registration order within each plugin', async () => {
    const outer = await fixture(`let order = []; export function register(on) {
      on('engine.create', async ($, e, next) => { order.push('first'); const built = await next(e); return { ...built }; });
      on('engine.create', () => { order.push('second'); return {}; });
      on('tool.call', { tool: 'Outer' }, () => ({ result: order }));
    }`, 'outer')
    const inner = await fixture(`let calls = 0; export function register(on) {
      on('engine.create', async ($, e, next) => { calls++; return next(e); });
      on('tool.call', { tool: 'Inner' }, () => ({ result: calls }));
    }`, 'inner')
    const { value, events } = runtime()
    await value.reconcile([outer, inner])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', { ...input, tool: 'Outer' }, async () => ({}))).toEqual({ result: ['first', 'second'] })
    expect(await value.dispatch('tool.call', { ...input, tool: 'Inner' }, async () => ({}))).toEqual({ result: 0 })
  })

  test('retains withheld noun ownership and rejects resurrection by an outer fold', async () => {
    const revive = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'resurrected' } }; });
    }`, 'revive')
    const hide = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return {}; });
    }`, 'hide')
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => 'original' } }; });
    }`, 'provider')
    const consumer = await fixture(`export function register(on) {
      on('tool.call', async ($) => ({ result: await $.greeting.read() }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([revive, hide, consumer, provider])
    expect(events.filter(event => event.stage === 'engine.create').map(event => event.plugin)).toEqual(['revive'])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.plugin === 'consumer' && event.message.includes('withheld'))).toBe(true)
  })

  test('beneath clock bootstraps through the real bridge and captured calls respect final withholding', async () => {
    const policy = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return {}; });
    }`, 'policy')
    const plugin = await fixture(`let before, now; export function register(on) {
      on('engine.create', async ($, e, next) => {
        const built = await next(e); before = await built.clock.now(); await built.clock.sleep(1);
        now = () => built.clock.now(); return { ...built };
      });
      on('tool.call', { tool: 'Before' }, () => ({ result: before }));
      on('tool.call', { tool: 'Now' }, async () => ({ result: await now() }));
    }`)
    const { value, events } = runtime()
    const start = Date.now()
    await value.reconcile([policy, plugin])
    expect(events).toEqual([])
    const before = await value.dispatch('tool.call', { ...input, tool: 'Before' }, async () => ({ result: 0 })) as { result: number }
    expect(before.result).toBeGreaterThanOrEqual(start)
    expect(await value.dispatch('tool.call', { ...input, tool: 'Now' }, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.message.includes('withheld'))).toBe(true)
  })

  test.each((['prepend', 'user', 'append', 'builtin'] as ModTier[]).flatMap(tier =>
    [false, true].map(isNative => ({ tier, isNative }))))('admission judges before/after for $tier native=$isNative without changing dispatch order', async ({ tier, isNative }) => {
    const tiers: ModTier[] = ['prepend', 'user', 'append', 'builtin']
    const specs = tiers.flatMap(tier => [false, true].flatMap(isNative => ['before', 'after'].map(position => ({ tier, isNative, position }))))
    const judges = await Promise.all(specs.map((spec, index) => fixture(`let seen = []; export function register(on) {
      on('plugin.register', ($, e, next) => { seen.push(e.name); return next(e); });
      on('tool.call', { tool: 'Judge${index}' }, () => ({ result: seen }));
    }`, `judge${index}`)))
    const candidate = await fixture(`export function register(on) { on('tool.call', { tool: 'Candidate' }, () => ({ result: 'candidate' })); }`, 'candidate')
    const inputs = judges.map((judge, index) => ({ ...judge, tier: specs[index]!.tier, isNative: specs[index]!.isNative }))
    const ordered = [...inputs.filter((_, index) => specs[index]!.position === 'before'), { ...candidate, tier, isNative }, ...inputs.filter((_, index) => specs[index]!.position === 'after')]
    const sorted = [...ordered].sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier))
    const position = sorted.findIndex(item => item.name === 'candidate')
    const { value, events } = runtime()
    await value.reconcile(ordered)
    expect(events).toEqual([])
    for (let i = 0; i < inputs.length; i++) {
      const judge = inputs[i]!
      const before = sorted.indexOf(judge) < position
      const expected = isNative ? before && judge.isNative && (tier === 'user' || judge.tier !== 'user') : tier === 'user' ? (before || judge.tier !== 'user') : (before ? judge.tier !== 'user' : judge.isNative)
      const result = await value.dispatch('tool.call', { ...input, tool: `Judge${i}` }, async () => ({})) as { result: string[] }
      expect(result.result.includes('candidate')).toBe(expected)
    }
    await value.reconcile(ordered.map(item => item.name === 'candidate' ? { ...item, version: '2' } : item))
    for (let i = 0; i < inputs.length; i++) {
      const judge = inputs[i]!
      const before = sorted.indexOf(judge) < position
      const expected = isNative ? before && judge.isNative && (tier === 'user' || judge.tier !== 'user') : tier === 'user' ? (before || judge.tier !== 'user') : (before ? judge.tier !== 'user' : judge.isNative)
      const result = await value.dispatch('tool.call', { ...input, tool: `Judge${i}` }, async () => ({})) as { result: string[] }
      expect(result.result.filter(name => name === 'candidate')).toHaveLength(expected ? 2 : 0)
    }
    expect(events).toEqual([])
  })

  test('admission clears candidates one seat at a time so admitted providers can serve later judges', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, gate: { read: () => 'ready' } }; });
    }`, 'provider')
    const judge = await fixture(`let answer; export function register(on) {
      on('plugin.register', async ($, e, next) => { answer = await $.gate.read(); return next(e); });
      on('tool.call', () => ({ result: answer }));
    }`, 'judge')
    const candidate = await fixture(`export function register(on) { on('session.start', ($, e, next) => next(e)); }`, 'candidate')
    const { value, events } = runtime()
    await value.reconcile([{ ...provider, tier: 'prepend' }, { ...judge, tier: 'prepend' }, candidate])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'ready' })
  })

  test('version, name and root changes re-admit even with unchanged source fingerprint', async () => {
    const judge = await fixture(`let seen = []; export function register(on) {
      on('plugin.register', ($, e, next) => { seen.push({ name: e.name, version: e.version, root: e.root, uses: e.uses }); return next(e); });
      on('tool.call', () => ({ result: seen }));
    }`, 'judge')
    const source = `export function register(on) {
      on('tool.call', async ($, e, next) => { await $.clock.sleep(0); await $.clock.now(); return next(e); });
      on('session.start', ($, e, next) => next(e));
      on('tool.call', ($, e, next) => next(e));
    }`
    const plugin = await fixture(source)
    const moved = await fixture(source)
    const { value, events } = runtime()
    for (const candidate of [{ ...plugin, version: '1' }, { ...plugin, version: '2' }, { ...plugin, version: '2', name: 'renamed' }, { ...moved, version: '2', name: 'renamed' }]) {
      await value.reconcile([{ ...judge, tier: 'prepend' }, candidate])
    }
    expect(events).toEqual([])
    const result = await value.dispatch('tool.call', input, async () => ({})) as { result: unknown[] }
    expect(result.result).toEqual([
      { name: 'fixture', version: '1', root: plugin.pluginRoot, uses: { events: ['tool.call', 'session.start'], calls: ['clock.now', 'clock.sleep'] } },
      { name: 'fixture', version: '2', root: plugin.pluginRoot, uses: { events: ['tool.call', 'session.start'], calls: ['clock.now', 'clock.sleep'] } },
      { name: 'renamed', version: '2', root: plugin.pluginRoot, uses: { events: ['tool.call', 'session.start'], calls: ['clock.now', 'clock.sleep'] } },
      { name: 'renamed', version: '2', root: moved.pluginRoot, uses: { events: ['tool.call', 'session.start'], calls: ['clock.now', 'clock.sleep'] } },
    ])
  })

  test('reload bootstrap inherits withholding until the declaring policy is removed', async () => {
    const policy = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return {}; });
    }`, 'policy')
    const consumer = await fixture(`let allowed = false; export function register(on) {
      on('engine.create', async ($, e, next) => {
        const built = await next(e);
        try { await built.clock.now(); allowed = true; } catch { allowed = false; }
        return { ...built };
      });
      on('tool.call', () => ({ result: allowed }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([policy, consumer])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: true })
    await value.reconcile([policy, { ...consumer, options: { changed: true } }])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: false })
    await value.reconcile([consumer])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: true })
    expect(events).toEqual([])
  })

  test('cold bootstrap refuses unadmitted providers but reload admits before evaluating its fold', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, gate: { read: () => 'ready' } }; });
    }`, 'provider')
    const consumer = await fixture(`let result; export function register(on) {
      on('engine.create', async ($, e, next) => {
        const built = await next(e);
        try { result = await built.gate.read(); } catch { result = 'unadmitted'; }
        return { ...built };
      });
      on('tool.call', () => ({ result }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([consumer, provider])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'unadmitted' })
    await value.reconcile([{ ...consumer, options: { changed: true } }, provider])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'ready' })
    expect(events).toEqual([])
  })

  test('captured beneath calls inside an entered provider keep their generation across reload', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, source: { read: () => 'old' } }; });
    }`, 'provider')
    const wrapper = await fixture(`let begin, release; const started = new Promise(resolve => { begin = resolve }); const hold = new Promise(resolve => { release = resolve });
      export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, wrapper: { read: async () => { begin(); await hold; return built.source.read(); } } }; });
        on('tool.call', { tool: 'Started' }, async () => { await started; return { result: true }; });
        on('tool.call', { tool: 'Release' }, () => { release(); return { result: true }; });
      }`, 'wrapper')
    const consumer = await fixture(`export function register(on) { on('tool.call', { tool: 'Read' }, async ($) => ({ result: await $.wrapper.read() })); }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([consumer, wrapper, provider])
    const pending = value.dispatch('tool.call', { ...input, tool: 'Read' }, async () => ({ result: 'core' }))
    await value.dispatch('tool.call', { ...input, tool: 'Started' }, async () => ({}))
    try {
      await writeFile(provider.entrypoints[0]!, `export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, source: { read: () => 'new' } }; });
      }`)
      await value.reconcile([consumer, wrapper, provider])
    } finally { await value.dispatch('tool.call', { ...input, tool: 'Release' }, async () => ({})) }
    expect(await pending).toEqual({ result: 'old' })
    expect(events).toEqual([])
  })

  test('warm addition is judged before evaluating a refused module', async () => {
    const judge = await fixture(`export function register(on) {
      on('plugin.register', ($, e, next) => e.name === 'refused' ? { refuse: 'not allowed' } : next(e));
    }`, 'judge')
    const refused = await fixture(`throw Error('must not evaluate'); export function register(on) { on('tool.call', () => ({ result: 'bad' })); }`, 'refused')
    const { value, events } = runtime()
    await value.reconcile([{ ...judge, tier: 'prepend' }])
    await value.reconcile([{ ...judge, tier: 'prepend' }, refused])
    expect(events).toEqual([{ plugin: 'refused', stage: 'admission', message: 'not allowed' }])
  })

  test('a failed inner create is diagnosed once and rebuilding retains its healthy outer caller', async () => {
    const outer = await fixture(`let builds = 0; export function register(on) {
      on('engine.create', async ($, e, next) => { builds++; return next(e); });
      on('tool.call', () => ({ result: builds }));
    }`, 'outer')
    const inner = await fixture(`export function register(on) { on('engine.create', () => { throw Error('inner failed'); }); }`, 'inner')
    const { value, events } = runtime()
    await value.reconcile([outer, inner])
    expect(events).toEqual([{ plugin: 'inner', stage: 'engine.create', message: 'inner failed' }])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 2 })
  })

  test('Worker recovery carries withholding into the recovered bootstrap', async () => {
    const policy = await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {}; }); }`, 'policy')
    const consumer = await fixture(`let result; export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); try { await built.clock.now(); result = 'allowed'; } catch { result = 'withheld'; } return { ...built }; });
      on('tool.call', () => ({ result }));
    }`, 'consumer')
    const RealWorker = globalThis.Worker
    const workers: Worker[] = []
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.push(this) }
    } as typeof Worker
    const died = Promise.withResolvers<void>()
    let value: ReturnType<typeof createModsRuntime>
    try { value = createModsRuntime({ onDiagnostic: event => { if (event.stage === 'worker') died.resolve() } }) }
    finally { globalThis.Worker = RealWorker }
    cleanups.push(() => value.dispose())
    await value.reconcile([policy, consumer])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'allowed' })
    workers[0]!.terminate()
    await died.promise
    await value.bind({ cwd: consumer.pluginRoot, surface: null, isInteractive: false, sessionId: 'recovery' })
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'withheld' })
  })

  test('bootstrap clock timers execute while candidates remain barred from provider calls', async () => {
    const plugin = await fixture(`let result; export function register(on) {
      on('engine.create', async ($, e, next) => {
        const built = await next(e);
        result = await new Promise(resolve => { built.clock.after(0, async () => { resolve(typeof await built.clock.now()); }); });
        return { ...built };
      });
      on('tool.call', () => ({ result }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'number' })
  }, 1000)

  test('a crashed withholder that cannot reload stays effective while declared, then unload releases it', async () => {
    const policy = await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {}; }); }`, 'policy')
    const consumer = await fixture(`export function register(on) { on('tool.call', async ($) => ({ result: await $.clock.now() })); }`, 'consumer')
    const RealWorker = globalThis.Worker
    const workers: Worker[] = []
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.push(this) }
    } as typeof Worker
    const died = Promise.withResolvers<void>()
    let value: ReturnType<typeof createModsRuntime>
    try { value = createModsRuntime({ onDiagnostic: event => { if (event.stage === 'worker') died.resolve() } }) }
    finally { globalThis.Worker = RealWorker }
    cleanups.push(() => value.dispose())
    await value.reconcile([policy, consumer])
    await writeFile(policy.entrypoints[0]!, 'export function register(')
    workers[0]!.terminate()
    await died.promise
    await value.bind({ cwd: consumer.pluginRoot, surface: null, isInteractive: false, sessionId: 'recovery' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    await value.reconcile([consumer])
    const result = await value.dispatch('tool.call', input, async () => ({ result: 'core' })) as { result: unknown }
    expect(typeof result.result).toBe('number')
  })

  test('a cached provider cannot revive captured beneath after a later fold withholds it', async () => {
    const wrapper = await fixture(`let read; export function register(on) {
      on('engine.create', async ($, e, next) => {
        const built = await next(e); if (!read) read = () => built.clock.now();
        return { ...built, wrapper: { read } };
      });
      on('tool.call', async ($) => ({ result: await $.wrapper.read() }));
    }`, 'wrapper')
    const policy = await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {}; }); }`, 'policy')
    const { value, events } = runtime()
    await value.reconcile([wrapper])
    expect(typeof (await value.dispatch('tool.call', input, async () => ({})) as { result: unknown }).result).toBe('number')
    await value.reconcile([wrapper, policy])
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.message.includes('withheld'))).toBe(true)
  })

  test('forwards each link next results to the generic result validator without replaying core', async () => {
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($, e, next) => { await next(e); await next(e); return { result: 'replacement' }; });
    }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    let calls = 0
    const seen: unknown[] = []
    const result = await value.dispatch('tool.call', input, async () => ({ result: ++calls }), {
      validateResult: (_result, nextResults) => {
        seen.push([...nextResults])
        if (nextResults.length) throw Error('generic validation rejected replacement')
      },
    })
    expect(seen).toEqual([[{ result: 1 }, { result: 2 }]])
    expect(result).toEqual({ result: 2 })
    expect(calls).toBe(2)
    expect(events).toHaveLength(1)
  })

  test('final withholding prevents a bootstrap timer from entering its callback', async () => {
    const policy = await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {}; }); }`, 'policy')
    const plugin = await fixture(`let called = false; export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); built.clock.after(30, () => { called = true; }); return { ...built }; });
      on('tool.call', () => ({ result: called }));
    }`)
    const { value, events } = runtime()
    await value.reconcile([policy, plugin])
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: false })
    expect(events.some(event => event.stage === 'async' && event.message.includes('withheld'))).toBe(true)
  })

  test('a withholder can use its own captured beneath while other modules are refused', async () => {
    const policy = await fixture(`let now; export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); now = () => built.clock.now(); return {}; });
      on('tool.call', { tool: 'Policy' }, async () => ({ result: await now() }));
    }`, 'policy')
    const consumer = await fixture(`export function register(on) { on('tool.call', async ($) => ({ result: await $.clock.now() })); }`, 'consumer')
    const { value } = runtime()
    await value.reconcile([policy, consumer])
    expect(typeof (await value.dispatch('tool.call', { ...input, tool: 'Policy' }, async () => ({})) as { result: unknown }).result).toBe('number')
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
  })

  test('an admitted judge can use beneath captured during the cold fold before publication', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, gate: { read: () => 'ready' } }; });
    }`, 'provider')
    const judge = await fixture(`let read, result; export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); read = () => built.gate.read(); return { ...built }; });
      on('plugin.register', async ($, e, next) => { result = await read(); return next(e); });
      on('tool.call', () => ({ result }));
    }`, 'judge')
    const candidate = await fixture(`export function register(on) { on('session.start', ($, e, next) => next(e)); }`, 'candidate')
    const { value, events } = runtime()
    await value.reconcile([{ ...judge, tier: 'prepend' }, { ...provider, tier: 'builtin', isNative: true }, candidate])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({}))).toEqual({ result: 'ready' })
  })

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

  test('canceling an entered generation during reload does not replay core or cancel the replacement', async () => {
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($, e, next) => { const result = await next(e); return { result: 'old:' + result.result }; })
        .catch(() => ({ result: 'must-not-recover-parent-abort' }));
    }`)
    const { value } = runtime()
    await value.reconcile([plugin])
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let effects = 0
    const pending = value.dispatch('tool.call', input, async () => {
      effects++
      entered.resolve()
      await finish.promise
      return { result: 'core' }
    }, { signal: controller.signal }).then(() => null, error => error)
    try {
      await entered.promise
      await writeFile(plugin.entrypoints[0]!, `export function register(on) { on('tool.call', () => ({ result: 'new' })); }`)
      await value.reconcile([plugin])
      controller.abort(new Error('fixture cancelled'))
      expect(await pending).toBeInstanceOf(Error)
      expect(effects).toBe(1)
      expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'new' })
    } finally {
      finish.resolve()
    }
  })

  test('changing one activation options does not restart a surviving activation', async () => {
    const observed = await fixture(`let starts = 0; export function register(on, options) {
      on('session.start', ($, e, next) => { starts++; return next(e) });
      on('tool.call', { tool: 'Observed' }, () => ({ result: { starts, label: options.label } }));
    }`, 'observed')
    const changed = await fixture(`let starts = 0; export function register(on, options) {
      on('session.start', ($, e, next) => { starts++; return next(e) });
      on('tool.call', { tool: 'Changed' }, () => ({ result: { starts, label: options.label } }));
    }`, 'changed')
    const { value } = runtime()
    const stable = { ...observed, options: { label: 'stable' } }
    await value.reconcile([stable, { ...changed, options: { label: 'one' } }])
    await value.bind({ cwd: observed.pluginRoot, surface: null, isInteractive: false, sessionId: 'a' })
    expect(await value.dispatch('tool.call', { ...input, tool: 'Changed' }, async () => ({}))).toEqual({ result: { starts: 1, label: 'one' } })
    await value.reconcile([stable, { ...changed, options: { label: 'two' } }])
    expect(await value.dispatch('tool.call', { ...input, tool: 'Observed' }, async () => ({}))).toEqual({ result: { starts: 1, label: 'stable' } })
    expect(await value.dispatch('tool.call', { ...input, tool: 'Changed' }, async () => ({}))).toEqual({ result: { starts: 1, label: 'two' } })
  })

  test('noun deny and unsupported scalar arguments never enter the provider', async () => {
    const provider = await fixture(`let calls = 0; export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, greeting: { read: () => ++calls } }; });
      on('tool.call', { tool: 'Count' }, () => ({ result: calls }));
    }`, 'provider')
    const policy = await fixture(`export function register(on) { on('greeting.read', () => ({ deny: 'fixture noun denied' })); }`, 'policy')
    const consumer = await fixture(`export function register(on) {
      on('tool.call', { tool: 'Object' }, async ($) => ({ result: await $.greeting.read({}) }));
      on('tool.call', { tool: 'Scalar' }, async ($) => ({ result: await $.greeting.read(42) }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([policy, consumer, provider])
    expect(events).toEqual([])
    for (const tool of ['Object', 'Scalar']) {
      expect(await value.dispatch('tool.call', { ...input, tool }, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    }
    expect(events.some(event => event.message.includes('fixture noun denied'))).toBe(true)
    expect(events.some(event => event.message.includes('one object argument'))).toBe(true)
    expect(await value.dispatch('tool.call', { ...input, tool: 'Count' }, async () => ({ result: 'core' }))).toEqual({ result: 0 })
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

  test('clock op envelopes are rewritten and unwrapped across real Workers', async () => {
    const policy = await fixture(`export function register(on) {
      on('clock.now', async ($, e, next) => { const result=await next(e); return {value:result.value+1}; });
      on('clock.now', () => ({value:123}));
      on('clock.sleep', () => ({deny:'sleep denied'}));
      on('clock.after', () => ({deny:'after denied'}));
      on('clock.every', () => ({deny:'every denied'}));
    }`, 'clock-policy')
    const plugin = await fixture(`let callbacks=0; export function register(on) {
      on('tool.call', async ($) => {
        let sleep;
        try { await $.clock.sleep(0); sleep='resolved'; } catch(error) { sleep=error.message; }
        $.clock.after(0, () => { callbacks++; });
        const repeating=$.clock.every(1, () => { callbacks++; repeating.cancel(); });
        return {result:{now:await $.clock.now(),sleep}};
      });
      on('command.run', () => ({text:String(callbacks)}));
    }`)
    const {value, events} = runtime()
    await value.reconcile([policy, plugin])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{now:124,sleep:'sleep denied'}})
    const deadline=Date.now()+2000
    while (events.length<2 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5))
    expect(await value.dispatch('command.run', {command:'probe'}, async()=>({}))).toEqual({text:'0'})
    expect(events.map(event=>event.message).sort()).toEqual(['after denied','every denied'])
  })

  test('clock hooks reject bare values and recover through the core envelope', async () => {
    const policy = await fixture(`export function register(on) {
      on('clock.now', () => 123);
      on('clock.sleep', () => undefined);
    }`, 'invalid-clock-policy')
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($) => { await $.clock.sleep(0); return {result:await $.clock.now()}; });
    }`)
    const {value, events}=runtime()
    await value.reconcile([policy,plugin])
    const result=await value.dispatch('tool.call',input,async()=>({result:'core'})) as {result:number}
    expect(result.result).toBeGreaterThan(123)
    expect(events.map(event=>event.stage).sort()).toEqual(['clock.now','clock.sleep'])
  })

  test('clock.sleep middleware returns the void value envelope without a diagnostic', async () => {
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

  test('real Worker tool and turn chains restore agentId before downstream hooks', async () => {
    const rewrite=await fixture(`export function register(on) {
      on('tool.call',($,e,next)=>{const {agentId,...rest}=e;return next(rest);});
      on('turn.complete',($,e,next)=>next({...e,agentId:undefined}));
    }`,'identity-rewrite')
    const observe=await fixture(`export function register(on) {
      on('tool.call',($,e)=>({result:e.agentId??'main'}));
      on('turn.complete',($,e)=>({text:e.agentId??'main'}));
    }`,'identity-observe')
    const {value,events}=runtime()
    await value.reconcile([rewrite,observe])
    for(const agentId of [undefined,'child']) {
      expect(await value.dispatch('tool.call',{...input,agentId},async()=>({result:'core'}))).toEqual({result:agentId??'main'})
      expect(await value.dispatch('turn.complete',{answer:'',turnId:'turn',agentId},async()=>({text:'core'}))).toEqual({text:agentId??'main'})
    }
    expect(events).toEqual([])
  })

  test('supports exact, glob and negated next.is in scanned hooks including engine.create', async () => {
    const plugin = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { if (!next.is('engine.create', e)) throw Error('wrong event'); return next(e); });
      on('tool.call', ($, e, next) => ({ result: next.is('tool.call', e) && next.is('tool.*', e) && next.is('!session.*', e) && !next.is('session.start', e) }));
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

  test('initial admission refusal removes candidate nouns without retaining rejected hooks', async () => {
    const judge = await fixture(`export function register(on) {
      on('plugin.register', ($, e, next) => e.name === 'rejected' ? { refuse: 'fixture rejected' } : next(e));
    }`, 'judge')
    const rejected = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built, rejected: { read: () => 'must-not-survive' } }; });
      on('tool.call', { tool: 'Rejected' }, () => ({ result: 'must-not-run' }));
    }`, 'rejected')
    const consumer = await fixture(`export function register(on) {
      on('tool.call', async ($) => ({ result: await $.rejected.read() }));
    }`, 'consumer')
    const { value, events } = runtime()
    await value.reconcile([{ ...judge, tier: 'prepend' }, rejected, consumer])
    expect(events).toContainEqual({ plugin: 'rejected', stage: 'admission', message: 'fixture rejected' })
    expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
    expect(events.some(event => event.plugin === 'consumer' && event.stage === 'tool.call')).toBe(true)
    await value.reconcile([{ ...judge, tier: 'prepend' }])
    expect(value.hasHooks('tool.call')).toBe(false)
  })

  test('real runtime clock now and after cancellation stay usable after reload', async () => {
    const plugin = await fixture(`export function register(on) {
      on('tool.call', async ($) => {
        const before = await $.clock.now();
        const timer = $.clock.after(1000, () => { throw Error('canceled callback ran') });
        timer.cancel();
        await $.clock.sleep(1);
        return { result: (await $.clock.now()) >= before };
      });
    }`)
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([])
    const first = await value.dispatch('tool.call', input, async () => ({ result: false }))
    expect(events).toEqual([])
    expect(first).toEqual({ result: true })
    await value.reconcile([{ ...plugin, options: { generation: 2 } }])
    expect(await value.dispatch('tool.call', input, async () => ({ result: false }))).toEqual({ result: true })
    expect(events).toEqual([])
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
