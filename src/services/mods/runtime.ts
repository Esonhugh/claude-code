import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createModClockBridge, createModEnvironmentHost, type ModEnvironment } from './environment.js'
import { loadModDeclaration } from './loader.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModDeclaration, ModDispatchHook, ModInput, ModOrigin, ModTier } from './types.js'

export type ModPluginInput = {
  name: string
  storageId: string
  pluginRoot: string
  entrypoints: string[]
  options?: ModInput
  tier?: ModTier
}
export type ModBinding = {
  cwd: string
  surface: 'terminal' | null
  isInteractive: boolean
  sessionId: string
}
export type ModDiagnostic = { plugin: string; stage: string; message: string }
export type ModDispatchOptions = { signal?: AbortSignal; validateResult?: (value: unknown) => void }
export type ModSnapshot = {
  dispatch(event: string, input: ModInput, core: (input: ModInput) => Promise<unknown>, options?: ModDispatchOptions): Promise<unknown>
  hasHooks(event: string): boolean
  release(): void
}
type Nouns = Record<string, Record<string, (...args: unknown[]) => unknown>>
type Activation = {
  declaration: ModDeclaration
  environment: ModEnvironment
  state: 'candidate' | 'active' | 'retiring' | 'disposed'
  references: number
  started: boolean
  waits: Map<number, { kind: string; timer: ReturnType<typeof setTimeout>; reject(error: Error): void }>
  methods: WeakMap<object, (...args: unknown[]) => Promise<unknown>>
  dispose?: Promise<void>
}
const tierOrder: ModTier[] = ['prepend', 'user', 'append', 'builtin', 'core']
const unavailableDuringCreate = () => { throw new Error('Capabilities cannot be called during engine.create') }
const coreClock = Object.freeze({
  now: unavailableDuringCreate, sleep: unavailableDuringCreate,
  after: unavailableDuringCreate, every: unavailableDuringCreate,
})

export function createModsRuntime({ onDiagnostic }: { onDiagnostic?: (event: ModDiagnostic) => void } = {}) {
  let active: Activation[] = []
  let nouns: Nouns = {}
  let binding: ModBinding | undefined
  let stopped = false
  let queue = Promise.resolve()
  let declarations: ModPluginInput[] = []
  let recovering = false
  let hostEpoch = 0
  let hostDead = false
  const activations = new Set<Activation>()
  const retired = new Set<Activation>()
  const ownedMethods = new WeakSet<object>()
  const controller = new AbortController()
  const diagnostic = (plugin: string, stage: string, error: unknown) => onDiagnostic?.({
    plugin, stage, message: error instanceof Error ? error.message : String(error),
  })
  let host = createModEnvironmentHost({ onDied: workerDied, onError: asynchronousError })

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = queue.then(() => {
      if (stopped) throw new Error('Mods runtime disposed')
      return work()
    })
    queue = pending.then(() => {}, () => {})
    return pending
  }

  function cancelWait(owner: Activation, id: number) {
    const wait = owner.waits.get(id)
    if (!wait) return
    owner.waits.delete(id)
    clearTimeout(wait.timer)
    wait.reject(new Error('Module timer cancelled'))
  }

  function disposeActivation(owner: Activation): Promise<void> {
    if (owner.dispose) return owner.dispose
    owner.state = 'disposed'
    for (const id of owner.waits.keys()) cancelWait(owner, id)
    owner.dispose = owner.environment.dispose().finally(() => { retired.delete(owner); activations.delete(owner) })
    return owner.dispose
  }

  function retire(owner: Activation) {
    if (owner.state === 'disposed' || owner.state === 'retiring') return
    owner.state = 'retiring'
    retired.add(owner)
    // A pending sleep may belong to an in-flight hook; stop future timer ticks,
    // but do not turn a normal reload into cancellation of that continuation.
    for (const [id, wait] of owner.waits) if (wait.kind !== 'sleep') cancelWait(owner, id)
    if (owner.references === 0) void disposeActivation(owner).catch(error => diagnostic(owner.declaration.name, 'dispose', error))
  }

  async function withReference<T>(owner: Activation, fn: () => Promise<T>): Promise<T> {
    if (owner.state === 'disposed') throw new Error('Module environment unloaded')
    owner.references++
    try { return await fn() }
    finally {
      owner.references--
      if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
    }
  }

  function checkCall(owner: Activation, op: string, table: Nouns, entered = false) {
    if (stopped || owner.state === 'disposed') throw new Error('Module environment unloaded')
    if (!owner.declaration.calls.includes(op)) throw new Error(`Module capability ${op} is absent from scan`)
    if (owner.state === 'candidate' && !op.startsWith('clock.')) throw new Error('Module has not been admitted')
    const [noun, method] = op.split('.') as [string, string]
    if (!table[noun]?.[method] || (!entered && nouns[noun]?.[method] !== table[noun]?.[method])) {
      throw new Error(`Module capability ${op} was withdrawn`)
    }
  }

  function engineFor(owner: Activation, snapshot: readonly Activation[], table: Nouns, lease: { entries: number }): Record<string, unknown> {
    const clock = createModClockBridge({
      now: async () => {
        checkCall(owner, 'clock.now', table, lease.entries > 0)
        return await dispatch('clock.now', {}, async () => Date.now(), snapshot, table, {
          origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
        }) as number
      },
      wait: async (kind, ms, id) => {
        checkCall(owner, `clock.${kind}`, table, lease.entries > 0)
        if (!Number.isFinite(ms) || ms < 0 || (kind === 'every' && ms < 1)) throw new Error('Invalid clock duration')
        if (owner.state === 'retiring' && kind !== 'sleep') throw new Error('Module timer belongs to a retired activation')
        await withReference(owner, () => dispatch(`clock.${kind}`, { ms }, async input => {
          if (typeof input.ms !== 'number' || !Number.isFinite(input.ms) || input.ms < 0 || (kind === 'every' && input.ms < 1)) throw new Error('Invalid clock duration')
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { owner.waits.delete(id); resolve() }, input.ms as number)
            timer.unref?.()
            owner.waits.set(id, { kind, timer, reject })
          })
          return undefined
        }, snapshot, table, { origin: { plugin: owner.declaration.name, tier: owner.declaration.tier } }))
      },
      cancel: id => cancelWait(owner, id),
      run: async callback => {
        if (owner.state !== 'active') throw new Error('Module timer belongs to a retired activation')
        // A callback enters the generation captured when its clock was injected.
        for (const item of snapshot) item.references++
        lease.entries++
        try { return await withReference(owner, callback) }
        finally {
          lease.entries--
          for (const item of snapshot) {
            item.references--
            if (item.state === 'retiring' && item.references === 0) await disposeActivation(item)
          }
        }
      },
    })
    const result: Record<string, unknown> = table.clock ? { clock } : {}
    for (const [noun, methods] of Object.entries(table)) {
      if (noun === 'clock') continue
      const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
      for (const [method, fn] of Object.entries(methods)) wrapped[method] = async (...args) => {
        const op = `${noun}.${method}`
        checkCall(owner, op, table, lease.entries > 0)
        const input = args[0] ?? {}
        if (args.length > 1 || typeof input !== 'object' || input === null || Array.isArray(input)) {
          throw new Error('This Mods slice supports noun methods with one object argument or no arguments')
        }
        const result = await dispatch(op, input as ModInput, async rewritten => ({ value: await fn(rewritten) }), snapshot, table, {
          origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
        }) as { value?: unknown; deny?: string }
        if (typeof result.deny === 'string') throw new Error(result.deny)
        return result.value
      }
      result[noun] = Object.freeze(wrapped)
    }
    return Object.freeze(result)
  }

  function hooksFor(snapshot: readonly Activation[], table: Nouns, only?: Activation): ModDispatchHook[] {
    return snapshot.filter(owner => !only || owner === only).flatMap(owner => owner.environment.registrations.map(registration => ({
      plugin: owner.declaration.name,
      tier: owner.declaration.tier,
      registration,
      invoke: (input, next, catching) => withReference(owner, async () => {
        const lease = { entries: 1 }
        try {
          return await owner.environment.invoke(
            catching ? registration.catchId! : registration.id,
            [registration.event === 'engine.create' ? Object.freeze({}) : engineFor(owner, snapshot, table, lease), input], next,
          )
        } finally { lease.entries-- }
      }),
    } satisfies ModDispatchHook)))
  }

  function validateResult(event: string, result: unknown) {
    if (event === 'clock.now') {
      if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('clock.now must return a finite number')
      return
    }
    if (event.startsWith('clock.')) return
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return an object`)
    const value = result as Record<string, unknown>
    if (event === 'tool.call' && !('result' in value) && typeof value.deny !== 'string') throw new Error('tool.call must return result or deny')
    if (event === 'plugin.register' && value.allow !== true && typeof value.refuse !== 'string') throw new Error('plugin.register must allow or refuse')
    if (event === 'session.start' && typeof value.cwd !== 'string') throw new Error('session.start must return cwd')
    if (!['tool.call', 'plugin.register', 'session.start', 'engine.create'].includes(event) && !('value' in value) && typeof value.deny !== 'string') {
      throw new Error(`${event} must return value or deny`)
    }
  }

  async function dispatch(
    event: string,
    input: ModInput,
    core: (input: ModInput) => Promise<unknown>,
    snapshot: readonly Activation[] = active,
    table: Nouns = nouns,
    options: ModDispatchOptions & { origin?: ModOrigin; only?: Activation } = {},
  ) {
    if (stopped) throw new Error('Mods runtime disposed')
    const combined = createCombinedAbortSignal(options.signal, { signalB: controller.signal })
    for (const owner of snapshot) owner.references++
    try {
      return await dispatchModEvent({
        event, input, hooks: hooksFor(snapshot, table, options.only), core,
        signal: combined.signal, origin: options.origin,
        // Runtime-raised noun calls skip the originating plugin to avoid an
        // accidental timer/capability recursion. Tool model events have none.
        ...(options.origin ? { skip: { plugin: options.origin.plugin } } : {}),
        validateResult: result => { validateResult(event, result); options.validateResult?.(result) },
        onFailure: (plugin, error) => diagnostic(plugin, event, error),
      })
    } finally {
      combined.cleanup()
      for (const owner of snapshot) {
        owner.references--
        if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
      }
    }
  }

  async function build(snapshot: Activation[], replacements = new Map<Activation, Activation>()): Promise<{ modules: Activation[]; table: Nouns }> {
    let modules = [...snapshot]
    for (;;) {
      let table: Nouns = { clock: coreClock }
      let failed: Activation | undefined
      for (const owner of [...modules].reverse()) {
        const steps = owner.environment.registrations.filter(registration => registration.event === 'engine.create')
        for (const registration of [...steps].reverse()) {
          const before = table
          try {
            const result = await dispatchModEvent({
              event: 'engine.create', input: { plugins: modules.map(item => item.declaration.name) },
              hooks: hooksFor([owner], before).filter(hook => hook.registration.id === registration.id),
              core: async () => before, signal: controller.signal,
            }) as Nouns
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('engine.create must return an interface')
            for (const [noun, methods] of Object.entries(result)) {
              if (!methods || typeof methods !== 'object' || Array.isArray(methods)) throw new Error(`Invalid noun ${noun}`)
              const entries = Object.entries(methods)
              if (!entries.every(([, fn]) => typeof fn === 'function')) throw new Error(`Noun ${noun} must contain callable methods`)
              if (before[noun] && (entries.length !== Object.keys(before[noun]).length || entries.some(([key, fn]) => before[noun]![key] !== fn))) {
                throw new Error(`engine.create may not replace noun ${noun}`)
              }
            }
            table = Object.fromEntries(Object.entries(result).map(([noun, methods]) => [
              noun,
              Object.fromEntries(Object.entries(methods).map(([method, fn]) => {
                if (before[noun] || ownedMethods.has(fn)) return [method, fn]
                let wrapped = owner.methods.get(fn)
                if (!wrapped) {
                  wrapped = (...args) => withReference(owner, async () => {
                    if (owner.state === 'candidate') throw new Error('Module has not been admitted')
                    return fn(...args)
                  })
                  owner.methods.set(fn, wrapped)
                  ownedMethods.add(wrapped)
                }
                return [method, wrapped]
              })),
            ]))
          } catch (error) {
            diagnostic(owner.declaration.name, 'engine.create', error)
            failed = owner
            break
          }
        }
        if (failed) break
      }
      if (!failed) return { modules, table }
      const previous = replacements.get(failed)
      modules = previous
        ? modules.map(owner => owner === failed ? previous : owner)
        : modules.filter(owner => owner !== failed)
      if (failed.state === 'candidate') await disposeActivation(failed)
    }
  }

  async function admit(candidate: ModDeclaration, judges: readonly Activation[], table: Nouns) {
    const result = await dispatch('plugin.register', {
      name: candidate.name, tier: candidate.tier, root: candidate.pluginRoot, provenance: candidate.storageId,
      uses: { events: candidate.events, calls: candidate.calls },
    }, async () => ({ allow: true }), judges, table) as { allow?: true; refuse?: string }
    return result.refuse
  }

  async function start(owners: readonly Activation[]) {
    if (!binding) return
    for (const owner of owners) {
      if (owner.started || owner.state !== 'active') continue
      owner.started = true
      const input = { cwd: binding.cwd, surface: binding.surface, isInteractive: binding.isInteractive }
      await dispatch('session.start', input, async () => ({ cwd: input.cwd }), active, nouns, { only: owner })
    }
  }

  async function reconcile(inputs: ModPluginInput[]) {
    if (hostDead) {
      host = createModEnvironmentHost({ onDied: workerDied, onError: asynchronousError })
      hostDead = false
    }
    declarations = inputs
    const previous = active
    const epoch = hostEpoch
    const ensureLive = () => {
      if (stopped) throw new Error('Mods runtime disposed')
      if (hostEpoch !== epoch) throw new Error('Mods Worker generation changed during reload')
    }
    const wanted = new Set(inputs.map(input => input.storageId))
    const removed = previous.filter(owner => !wanted.has(owner.declaration.storageId))
    active = previous.filter(owner => wanted.has(owner.declaration.storageId))
    for (const owner of removed) retire(owner)
    const candidates = [...active]
    const replacements = new Map<Activation, Activation>()
    for (const input of inputs) {
      const old = candidates.find(owner => owner.declaration.storageId === input.storageId)
      try {
        const declaration = await loadModDeclaration(input)
        ensureLive()
        if (old?.declaration.fingerprint === declaration.fingerprint) continue
        if (old) {
          const refusal = await admit(declaration, active.filter(owner => owner !== old), nouns)
          if (refusal !== undefined) {
            candidates.splice(candidates.indexOf(old), 1)
            active = active.filter(owner => owner !== old)
            retire(old)
            diagnostic(declaration.name, 'admission', refusal)
            continue
          }
        }
        const environment = await host.load(declaration)
        const candidate: Activation = { declaration, environment, state: 'candidate', references: 0, started: false, waits: new Map(), methods: new WeakMap() }
        activations.add(candidate)
        if (stopped || epoch !== hostEpoch) {
          await disposeActivation(candidate)
          ensureLive()
        }
        if (old) candidates.splice(candidates.indexOf(old), 1, candidate)
        else candidates.push(candidate)
        if (old) replacements.set(candidate, old)
      } catch (error) {
        ensureLive()
        diagnostic(input.name, old ? 'reload' : 'load', old ? `The previous version stays loaded: ${error instanceof Error ? error.message : error}` : error)
      }
    }
    const order = new Map(inputs.map((input, index) => [input.storageId, index]))
    candidates.sort((a, b) => tierOrder.indexOf(a.declaration.tier) - tierOrder.indexOf(b.declaration.tier)
      || order.get(a.declaration.storageId)! - order.get(b.declaration.storageId)!)
    if (candidates.length === previous.length && candidates.every((owner, index) => owner === previous[index])) return
    let built = await build(candidates, replacements)
    ensureLive()
    const admitted: Activation[] = []
    for (const owner of built.modules) {
      if (owner.state === 'active' || replacements.has(owner)) { admitted.push(owner); continue }
      const refusal = await admit(owner.declaration, admitted, built.table)
      if (refusal !== undefined) {
        diagnostic(owner.declaration.name, 'admission', refusal)
        await disposeActivation(owner)
        const old = active.find(item => item.declaration.storageId === owner.declaration.storageId)
        if (old) { active = active.filter(item => item !== old); retire(old) }
      } else admitted.push(owner)
    }
    if (admitted.length !== built.modules.length) built = await build(admitted)
    else built.modules = admitted
    ensureLive()
    for (const owner of built.modules) owner.state = 'active'
    const replaced = active.filter(owner => !built.modules.includes(owner))
    active = built.modules
    nouns = built.table
    for (const owner of replaced) retire(owner)
    await start(active)
  }

  function asynchronousError(error: Error, environment: number) {
    const owner = [...activations].find(owner => owner.environment.id === environment)
    diagnostic(owner?.declaration.name ?? 'engine', 'async', error)
  }

  function workerDied(error: Error) {
    diagnostic('engine', 'worker', error)
    hostEpoch++
    hostDead = true
    for (const owner of activations) {
      owner.state = 'disposed'
      for (const id of owner.waits.keys()) cancelWait(owner, id)
    }
    active = []
    nouns = {}
    retired.clear()
    activations.clear()
    if (stopped || recovering) return
    recovering = true
    void enqueue(async () => {
      try { await reconcile(declarations) }
      finally { recovering = false }
    }).catch(error => diagnostic('engine', 'recovery', error))
  }

  function capture(): ModSnapshot {
    if (stopped) throw new Error('Mods runtime disposed')
    const snapshot = active
    const table = nouns
    let released = false
    for (const owner of snapshot) owner.references++
    return {
      dispatch: async (event, input, core, options) => {
        if (released) throw new Error('Mods snapshot released')
        return dispatch(event, input, core, snapshot, table, options)
      },
      hasHooks: event => snapshot.some(owner => owner.environment.registrations.some(registration => registration.event === event)),
      release() {
        if (released) return
        released = true
        for (const owner of snapshot) {
          owner.references--
          if (owner.state === 'retiring' && owner.references === 0) void disposeActivation(owner).catch(error => diagnostic(owner.declaration.name, 'dispose', error))
        }
      },
    }
  }

  let disposal: Promise<void> | undefined
  return {
    capture,
    reconcile: (inputs: ModPluginInput[]) => enqueue(() => reconcile(inputs)),
    bind: (next: ModBinding) => enqueue(async () => { binding = next; await start(active) }),
    dispatch: (event: string, input: ModInput, core: (input: ModInput) => Promise<unknown>, options?: ModDispatchOptions) => dispatch(event, input, core, active, nouns, options),
    hasHooks: (event: string) => active.some(owner => owner.environment.registrations.some(registration => registration.event === event)),
    dispose(): Promise<void> {
      if (disposal) return disposal
      stopped = true
      controller.abort()
      disposal = (async () => {
        await Promise.all([...activations].map(disposeActivation))
        active = []
        nouns = {}
        await host.dispose()
        await queue
      })()
      return disposal
    },
  }
}

export type ModsRuntime = ReturnType<typeof createModsRuntime>
