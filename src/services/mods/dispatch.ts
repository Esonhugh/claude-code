import { isDeepStrictEqual } from 'node:util'
import { matchesModEventPattern, matchesModMatcher } from './matcher.js'
import { createAbortController } from '../../utils/abortController.js'
import type {
  ModDispatchHook,
  ModHookStream,
  ModInput,
  ModNext,
  ModOrigin,
  ModTier,
  ModTraceEntry,
} from './types.js'

type TraceNode = { entry?: ModTraceEntry; below: TraceNode[] }
const traces = new WeakMap<ModNext, Set<() => void>>()
export function subscribeModTrace(next: ModNext, changed: () => void): () => void {
  const listeners = traces.get(next)
  listeners?.add(changed)
  return () => { listeners?.delete(changed) }
}

// Host-only metering state; the Worker reads it without exposing shared memory
// or a host object to the plugin realm. Values are microseconds, except ms.
const budgets = new WeakMap<ModNext, { clock: BigInt64Array; pause(): () => void }>()
export function getModBudgetClock(next: ModNext): SharedArrayBuffer | undefined {
  return budgets.get(next)?.clock.buffer as SharedArrayBuffer | undefined
}
export function pauseModBudget(next: ModNext | undefined): (() => void) | undefined {
  return next && budgets.get(next)?.pause()
}

function traceEntries(nodes: readonly TraceNode[]): readonly ModTraceEntry[] {
  return Object.freeze(
    nodes.flatMap((node) => [
      ...(node.entry ? [node.entry] : []),
      ...traceEntries(node.below),
    ]),
  )
}

const tiers: readonly ModTier[] = [
  'prepend',
  'user',
  'append',
  'builtin',
  'core',
]

export function createModHookStream<C, R>(iterator: AsyncGenerator<C, R>, close?: (error: Error) => void, signal?: AbortSignal): ModHookStream<C, R> {
  let resolve!: (value: R) => void, reject!: (error: unknown) => void
  let finished = false
  const result = new Promise<R>((yes, no) => { resolve = yes; reject = no })
  void result.catch(() => {})
  const abort = () => {
    if (finished) return
    finished = true
    const error = signal!.reason
    reject(error)
    signal?.removeEventListener('abort', abort)
    close?.(error)
    void iterator.return(undefined as R).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const pull = async (method: 'next' | 'return' | 'throw', value?: unknown): Promise<IteratorResult<C, R>> => {
    if (method === 'return' && !finished) {
      finished = true
      const error = value instanceof Error ? value : new Error('Module stream closed before completion')
      reject(error)
      signal?.removeEventListener('abort', abort)
      close?.(error)
    }
    try {
      const item = await (method === 'next' ? iterator.next(value) : method === 'return' ? iterator.return(value as R) : iterator.throw(value))
      if (item.done && !finished) { finished = true; signal?.removeEventListener('abort', abort); resolve(item.value) }
      return item
    } catch (error) { finished = true; signal?.removeEventListener('abort', abort); reject(error); throw error }
  }
  return {
    next: value => pull('next', value),
    return: value => pull('return', value),
    throw: error => pull('throw', error),
    [Symbol.asyncIterator]() { return this },
    result,
  } as ModHookStream<C, R>
}

export function dispatchModStream(options: {
  event: 'turn.step'
  input: ModInput
  hooks: readonly ModDispatchHook[]
  core: (input: ModInput, signal?: AbortSignal) => AsyncGenerator<unknown, unknown>
  signal?: AbortSignal
  origin?: ModOrigin
  skip?: { plugin: string; registrationId?: number }
  budgetMs?: number
  catchGraceMs?: number
  validateResult?: (value: unknown, nextResults: readonly unknown[]) => void
  validateChunk?: (value: unknown) => void
  validateInput?: (value: ModInput, received: ModInput) => void
  onFailure?: (plugin: string, error: unknown) => void
}): ModHookStream {
  const hooks = [...options.hooks].sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier))
  const origin = Object.freeze(options.origin ?? { plugin: 'engine', tier: 'core' as const })
  const skip = options.skip ?? (options.origin ? { plugin: options.origin.plugin } : undefined)
  function run(start: number, input: ModInput, parent?: AbortSignal, skipped = new Set<ModTier>(), trace: TraceNode[] = [], changed = () => {}): ModHookStream {
    const lifetime = createAbortController()
    const abort = () => lifetime.abort(parent?.reason)
    parent?.addEventListener('abort', abort, { once: true })
    if (parent?.aborted) abort()
    const body = (async function* () {
      let index = start
      while (index < hooks.length) {
        const hook = hooks[index]!
        if (!skipped.has(hook.tier) && !(skip?.plugin === hook.plugin && (skip.registrationId === undefined || skip.registrationId === hook.registration.id)) &&
          matchesModEventPattern(hook.registration.event, options.event) && matchesModMatcher(hook.registration.matcher ?? {}, input)) break
        index++
      }
      const hook = hooks[index]
      const children = new Set<ModHookStream>()
      let current: AsyncGenerator<unknown, unknown> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let started = 0, remaining = 0, allowance = 0, pauses = 0, working = false
      let controller = createAbortController()
      let expire: ((error: Error) => void) | undefined
      let clock: BigInt64Array | undefined
      let timedOut = false
      let last: ModHookStream | undefined
      let lastResult: unknown
      let lastResolved = false
      let lastRejected = false
      let lastError: unknown
      const results: unknown[] = []
      const nextErrors = new Set<unknown>()
      const node: TraceNode = { below: [] }
      const listeners = new Set<() => void>()
      const belowChanged = () => { for (const listener of listeners) listener(); changed() }
      trace.push(node)
      let chunks = 0
      const record = (outcome: string, returned?: unknown) => {
        node.entry = Object.freeze({ index, plugin: hook?.plugin ?? 'engine', tier: hook?.tier ?? 'core', event: options.event, outcome, ms: Math.max(0, allowance - remaining), chunks, received: input, returned })
        changed()
      }
      const publish = () => {
        if (!clock) return
        Atomics.add(clock, 0, 1n)
        Atomics.store(clock, 1, BigInt(Math.max(0, Math.floor(remaining * 1000))))
        Atomics.store(clock, 2, timer === undefined ? 0n : BigInt(Math.floor((performance.timeOrigin + started) * 1000)))
        Atomics.store(clock, 3, BigInt(allowance))
        Atomics.add(clock, 0, 1n)
      }
      const stop = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; remaining -= performance.now() - started }
        publish()
      }
      const resume = () => {
        if (!working || pauses || timer !== undefined || controller.signal.aborted) return
        started = performance.now()
        timer = setTimeout(() => {
          stop(); timedOut = true
          const error = new Error(`Mod ${hook?.plugin} timed out for turn.step`)
          expire?.(error); controller.abort(error)
        }, Math.max(0, remaining))
        publish()
      }
      const pause = () => {
        const metered = clock
        pauses++; stop()
        let active = true
        return () => { if (active && clock === metered) { active = false; pauses--; resume() } }
      }
      const abandon = new Promise<never>((_resolve, reject) => {
        const fail = () => { controller.abort(lifetime.signal.reason); reject(lifetime.signal.reason) }
        lifetime.signal.addEventListener('abort', fail, { once: true })
        if (lifetime.signal.aborted) fail()
      })
      void abandon.catch(() => {})
      const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, abandon])
      function below(rewritten: ModInput, target?: ModTier): ModHookStream {
        if (!rewritten || typeof rewritten !== 'object' || Array.isArray(rewritten)) throw new Error('turn.step next requires an input object')
        if (rewritten.agentId === undefined && input.agentId !== undefined) rewritten = { ...rewritten, agentId: input.agentId }
        for (const key of ['turnId', 'index', 'messageCount', 'agentId']) {
          if (rewritten[key] !== options.input[key]) throw new Error(`Mod ${hook!.plugin} cannot rewrite ${key} for turn.step`)
        }
        options.validateInput?.(rewritten, input)
        const descent = new Set(skipped)
        if (target !== undefined) {
          if (!(hook!.tier === 'prepend' && ['append', 'builtin', 'core'].includes(target)) && !(hook!.tier === 'append' && target === 'core')) throw new Error(`Mod ${hook!.plugin} cannot continue from ${hook!.tier} to ${target}`)
          for (let tier = tiers.indexOf(hook!.tier) + 1; tier < tiers.indexOf(target); tier++) descent.add(tiers[tier]!)
        }
        const branchTrace: TraceNode[] = []
        node.below = branchTrace
        const branch = run(index + 1, rewritten, lifetime.signal, descent, branchTrace, belowChanged)
        children.add(branch)
        last = branch; lastResolved = false; lastRejected = false
        void branch.result.then(value => {
          results.push(value)
          if (last === branch) { lastResult = value; lastResolved = true }
        }, error => {
          nextErrors.add(error)
          if (last === branch) { lastRejected = true; lastError = error }
        })
        return branch
      }
      function nextFor(catching: boolean, failure?: ModNext['error']): ModNext {
        const own = controller
        const call = (rewritten: ModInput, target?: ModTier) => {
          own.signal.throwIfAborted()
          const branch = catching && last ? last : below(rewritten, target)
          const view = createModHookStream((async function* () {
            let thrown: { error: unknown } | undefined
            for (;;) {
              if (catching && branch === last) {
                if (lastRejected) throw lastError
                if (lastResolved) return lastResult
              }
              const item = await (thrown ? branch.throw(thrown.error) : branch.next())
              thrown = undefined
              if (item.done) return item.value
              try { yield item.value } catch (error) { thrown = { error } }
            }
          })())
          const pull = async (method: 'next' | 'return' | 'throw', value?: unknown) => {
            own.signal.throwIfAborted()
            const unpause = pause()
            try {
              // Closing a hook's view must not destroy the branch needed by failure recovery.
              return await view[method](value as never)
            } finally { unpause() }
          }
          return { next: () => pull('next'), return: (value: unknown) => pull('return', value), throw: (error: unknown) => pull('throw', error), result: view.result, [Symbol.asyncIterator]() { return this } }
        }
        const next = Object.defineProperties((rewritten: ModInput) => call(rewritten), {
          to: { value: (rewritten: ModInput, target: ModTier) => { if (target === undefined) throw new Error('next.to requires a tier'); return call(rewritten, target) } },
          is: { value: (event: string) => matchesModEventPattern(event, options.event) },
          event: { value: options.event }, origin: { value: origin }, signal: { value: own.signal },
          trace: { get: () => traceEntries(node.below) },
          budget: { value: Object.freeze({ ms: allowance, get remainingMs() { return Math.max(0, remaining - (timer === undefined ? 0 : performance.now() - started)) } }) },
          ...(catching ? { error: { value: failure }, called: { value: last !== undefined } } : {}),
        }) as unknown as ModNext
        budgets.set(next, { clock: clock!, pause })
        traces.set(next, listeners)
        return Object.freeze(next)
      }
      async function* invoke(catching: boolean, failure?: ModNext['error']) {
        controller = createAbortController()
        allowance = catching ? options.catchGraceMs ?? 1000 : options.budgetMs ?? 10_000
        remaining = allowance; pauses = 0
        clock = new BigInt64Array(new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT)); publish()
        const next = nextFor(catching, failure)
        const timeout = new Promise<never>((_resolve, reject) => { expire = reject })
        void timeout.catch(() => {})
        try {
          if (!hook!.invokeStream) throw new Error('turn.step requires an async generator hook')
          current = hook!.invokeStream(input, next, catching)
          let thrown: { error: unknown } | undefined
          for (;;) {
            working = true; resume()
            let item: IteratorResult<unknown, unknown>
            try { item = await wait(Promise.race([thrown ? current.throw(thrown.error) : current.next(), timeout])) }
            finally { working = false; stop() }
            thrown = undefined
            if (item.done) {
              const result = item.value === undefined ? lastResolved ? lastResult : { turnId: input.turnId, index: input.index, answer: '', toolUses: [], stopReason: null, usage: null } : item.value
              options.validateResult?.(result, results)
              return result
            }
            options.validateChunk?.(item.value)
            chunks++
            try { yield item.value } catch (error) { thrown = { error } }
          }
        } finally {
          working = false; stop(); expire = undefined
          controller.abort(new Error(`Mod ${hook!.plugin} invocation finished`))
          if (current) void current.return(undefined).catch(() => {})
          current = undefined
        }
      }
      try {
        lifetime.signal.throwIfAborted()
        if (!hook) {
          current = options.core(input, lifetime.signal)
          let thrown: { error: unknown } | undefined
          for (;;) {
            const item = await wait(thrown ? current.throw(thrown.error) : current.next())
            thrown = undefined
            if (item.done) { record('returned', item.value); return item.value }
            chunks++
            try { yield item.value } catch (error) { thrown = { error } }
          }
        }
        try { const result = yield* invoke(false); record('returned', result); return result }
        catch (error) {
          lifetime.signal.throwIfAborted()
          if (!nextErrors.has(error)) options.onFailure?.(hook.plugin, error)
          if (hook.registration.hasCatch) {
            try {
              const result = yield* invoke(true, { kind: timedOut ? 'timeout' : 'throw', ...(timedOut ? {} : { message: error instanceof Error ? error.message : String(error) }), budget: options.catchGraceMs ?? 1000 })
              record('caught', result); return result
            } catch (error) {
              lifetime.signal.throwIfAborted()
              if (!nextErrors.has(error)) options.onFailure?.(hook.plugin, error)
            }
          }
          if (lastRejected) throw lastError
          const result = lastResolved ? lastResult : yield* (last ?? below(input))
          record(timedOut ? 'expired' : 'skipped', result)
          return result
        }
      } finally {
        stop()
        parent?.removeEventListener('abort', abort)
        lifetime.abort(new Error('Module stream finished'))
        controller.abort(lifetime.signal.reason)
        if (current) void current.return(undefined).catch(() => {})
        for (const child of children) void child.return(undefined).catch(() => {})
      }
    })()
    return createModHookStream(body, error => { parent?.removeEventListener('abort', abort); lifetime.abort(error) }, parent)
  }
  return run(0, options.input, options.signal)
}

export async function dispatchModEvent(options: {
  event: string
  input: ModInput
  hooks: readonly ModDispatchHook[]
  core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>
  signal?: AbortSignal
  origin?: ModOrigin
  skip?: { plugin: string; registrationId?: number }
  budgetMs?: number
  catchGraceMs?: number
  validateResult?: (value: unknown, nextResults: readonly unknown[]) => void
  validateInput?: (input: ModInput, received: ModInput) => void
  restoreInput?: (input: ModInput, received: ModInput) => ModInput
  restoreResult?: (result: unknown, previous: unknown, called: boolean) => unknown
  reportDirectCoreFailure?: boolean
  onFailure?: (plugin: string, error: unknown) => void
}): Promise<unknown> {
  const budgetMs = options.budgetMs ?? 10_000
  const catchGraceMs = options.catchGraceMs ?? 1000
  const origin: ModOrigin = Object.freeze({
    ...(options.origin ?? { plugin: 'engine', tier: 'core' }),
  })
  const skip =
    options.skip ??
    (options.event !== 'engine.create' && options.origin
      ? { plugin: options.origin.plugin }
      : undefined)

  const hooks = [...options.hooks].sort(
    (a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier),
  )
  const pinned = (
    options.event === 'tool.call'
      ? ['tool', 'tool_use_id', 'agentId']
      : options.event === 'turn.complete'
        ? ['agentId']
      : options.event === 'plugin.register'
        ? ['name', 'tier', 'root', 'provenance', 'version', 'uses']
        : options.event === 'command.run'
          ? ['command', 'origin', 'presentation']
          : options.event === 'env.get' || options.event === 'env.set'
            ? ['name']
            : options.event === 'session.end'
              ? ['reason', 'sessionId', 'resume']
              : options.event === 'session.attach'
                ? ['surface', 'clientId', 'viewport']
                : options.event === 'session.detach'
                  ? ['surface', 'clientId', 'reason']
              : options.event === 'ui.message'
                ? ['surface', 'component', 'requestId', 'element', 'module']
              : options.event === 'ui.render'
                ? ['surface', 'component', 'requestId', 'viewport', ...(options.input.component === 'Pane' ? ['props'] : [])]
                : []
  ).map(
    (key) => [
      key,
      ['uses', 'origin', 'presentation', 'resume', 'viewport', 'props'].includes(key) ? structuredClone(options.input[key]) : options.input[key],
    ] as const,
  )

  async function run(
    index: number,
    input: ModInput,
    parent?: AbortSignal,
    skipped: ReadonlyMap<ModTier, string> = new Map(),
    trace: TraceNode[] = [],
    traceChanged: () => void = () => {},
    position = 0,
    directPlugin?: string,
  ): Promise<unknown> {
    parent?.throwIfAborted()
    while (index < hooks.length) {
      const { registration, tier, plugin } = hooks[index]!
      const skipRegistration =
        skip?.plugin === plugin &&
        (skip.registrationId === undefined ||
          skip.registrationId === registration.id)
      const matches =
        matchesModEventPattern(registration.event, options.event) &&
        matchesModMatcher(registration.matcher ?? {}, input)
      if (matches && !skipRegistration) {
        if (!skipped.has(tier)) break
        trace.push({
          entry: Object.freeze({
            index: position++,
            plugin,
            tier,
            event: options.event,
            outcome: 'skipped',
            reason: `bypassed by ${skipped.get(tier)}`,
            ms: 0,
            received: input,
            returned: undefined,
          }),
          below: [],
        })
        traceChanged()
      }
      index++
    }
    const hook = hooks[index]
    const node: TraceNode = { below: [] }
    trace.push(node)
    const enteredAt = performance.now()
    let belowStarted = 0
    let belowTime = 0
    let pending = 0
    function record(outcome: string, returned?: unknown) {
      const now = performance.now()
      node.entry = Object.freeze({
        index: position,
        plugin: hook?.plugin ?? 'engine',
        tier: hook?.tier ?? 'core',
        event: options.event,
        outcome,
        ms: Math.max(0, now - enteredAt - belowTime - (pending > 0 ? now - belowStarted : 0)),
        received: input,
        returned,
      })
      traceChanged()
    }
    if (!hook) {
      let abort!: () => void
      const abandoned = new Promise<never>((_resolve, reject) => {
        abort = () => reject(parent!.reason)
        parent?.addEventListener('abort', abort, { once: true })
      })
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            parent?.throwIfAborted()
            return options.core(input, parent)
          }),
          abandoned,
        ])
        record('returned', result)
        return result
      } catch (error) {
        record('rejected')
        if (options.reportDirectCoreFailure && directPlugin)
          options.onFailure?.(directPlugin, error)
        throw error
      } finally {
        parent?.removeEventListener('abort', abort)
      }
    }

    const traceListeners = new Set<() => void>()
    const belowChanged = () => {
      for (const listener of traceListeners) listener()
      traceChanged()
    }
    const lifetime = createAbortController()
    let controller = createAbortController()
    let phase: 'active' | 'recovering' | 'catch' | 'done' = 'active'
    let inFlight: Promise<unknown> | undefined
    const nextResults: unknown[] = []
    const nextErrors = new Set<unknown>()
    let lastResult: unknown
    let lastResolved = false
    let external = 0
    let budgetClock: BigInt64Array | undefined
    let allowance = budgetMs
    let remaining = budgetMs
    let started = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let expire: (() => void) | undefined
    let timedOut = false
    let rejectAbandoned!: (error: unknown) => void
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectAbandoned = reject
    })
    // Cancellation can arrive between awaits; always observe its rejection.
    void abandoned.catch(() => {})
    const abort = () => {
      phase = 'done'
      rejectAbandoned(parent!.reason)
      lifetime.abort(parent!.reason)
      controller.abort(parent!.reason)
    }
    parent?.addEventListener('abort', abort, { once: true })

    function publishBudget() {
      if (!budgetClock) return
      Atomics.add(budgetClock, 0, 1n)
      Atomics.store(budgetClock, 1, BigInt(Math.max(0, Math.floor(remaining * 1000))))
      Atomics.store(budgetClock, 2, timer === undefined ? 0n : BigInt(Math.floor((performance.timeOrigin + started) * 1000)))
      Atomics.store(budgetClock, 3, BigInt(options.event === 'engine.create' ? 0 : allowance))
      Atomics.add(budgetClock, 0, 1n)
    }
    function stopTimer() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        remaining -= performance.now() - started
      }
      publishBudget()
    }
    function startTimer() {
      if (
        options.event === 'engine.create' ||
        !expire ||
        timer !== undefined ||
        phase === 'done' ||
        phase === 'recovering'
      )
        return
      if (pending > 0 || external > 0) return
      started = performance.now()
      timer = setTimeout(expire, Math.max(0, remaining))
      publishBudget()
    }
    function below(rewritten: ModInput, target?: ModTier): Promise<unknown> {
      if (
        rewritten === null ||
        typeof rewritten !== 'object' ||
        Array.isArray(rewritten)
      ) {
        return Promise.reject(
          new Error(`Mod ${hook.plugin} next requires an input object`),
        )
      }
      if (
        options.event === 'plugin.register' &&
        !Object.hasOwn(rewritten, 'version') &&
        Object.hasOwn(options.input, 'version')
      ) {
        rewritten = { ...rewritten, version: options.input.version }
      }
      if (options.event === 'command.run' && !Object.hasOwn(rewritten, 'presentation')) {
        rewritten = { ...rewritten, presentation: options.input.presentation }
      }
      if (['tool.call', 'turn.complete'].includes(options.event) && rewritten.agentId === undefined && input.agentId !== undefined) {
        rewritten = { ...rewritten, agentId: input.agentId }
      }
      rewritten = options.restoreInput?.(rewritten, input) ?? rewritten
      for (const [key, value] of pinned) {
        const unchanged =
          ['uses', 'origin', 'presentation', 'resume', 'viewport', 'props'].includes(key)
            ? isDeepStrictEqual(rewritten[key], value)
            : rewritten[key] === value
        if (!unchanged)
          return Promise.reject(
            new Error(
              `Mod ${hook.plugin} cannot rewrite ${key} for ${options.event}`,
            ),
          )
      }
      try { options.validateInput?.(rewritten, input) }
      catch (error) { return Promise.reject(error) }
      const descent = new Map(skipped)
      if (target !== undefined) {
        if (
          !(
            hook.tier === 'prepend' &&
            ['append', 'builtin', 'core'].includes(target)
          ) &&
          !(hook.tier === 'append' && target === 'core')
        ) {
          return Promise.reject(
            new Error(
              `Mod ${hook.plugin} cannot continue from ${hook.tier} to ${target}`,
            ),
          )
        }
        for (
          let tier = tiers.indexOf(hook.tier) + 1;
          tier < tiers.indexOf(target);
          tier++
        )
          descent.set(tiers[tier]!, hook.plugin)
      }
      if (pending++ === 0) {
        belowStarted = performance.now()
        stopTimer()
      }
      const latest: TraceNode[] = []
      node.below = latest
      belowChanged()
      lastResolved = false
      const branch = run(
        index + 1,
        rewritten,
        lifetime.signal,
        descent,
        latest,
        () => { if (node.below === latest) belowChanged() },
        position + 1,
        hook.plugin,
      )
      inFlight = branch
      void branch.then(
        (result) => {
          if (inFlight === branch) {
            lastResolved = true
            lastResult = result
          }
          settled()
        },
        (error) => {
          nextErrors.add(error)
          settled()
        },
      )
      return branch
    }
    function settled() {
      pending--
      if (pending === 0) {
        belowTime += performance.now() - belowStarted
        startTimer()
      }
    }
    const replay = (rewritten: ModInput, target?: ModTier) =>
      inFlight ?? below(rewritten, target)

    async function invoke(
      catching: boolean,
      failure?: unknown,
    ): Promise<unknown> {
      phase = catching ? 'catch' : 'active'
      controller = createAbortController()
      const ownController = controller
      let settledRemaining: number | undefined
      allowance = catching ? catchGraceMs : budgetMs
      remaining = allowance
      external = 0
      budgetClock = new BigInt64Array(new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT))
      publishBudget()
      const continueBelow = (rewritten: ModInput, target?: ModTier) => {
        if (
          phase !== (catching ? 'catch' : 'active') ||
          ownController.signal.aborted
        ) {
          return Promise.reject(
            ownController.signal.reason ??
              new Error(`Mod ${hook.plugin} next is no longer active`),
          )
        }
        const result = catching
          ? replay(rewritten, target)
          : below(rewritten, target)
        void result.then(
          (value) => { nextResults.push(value) },
          () => {},
        )
        return result
      }
      const next = ((rewritten: ModInput) =>
        continueBelow(rewritten)) as ModNext
      Object.defineProperties(next, {
        to: {
          value: (rewritten: ModInput, target: ModTier) => {
            if (target === undefined && !(catching && inFlight)) {
              return Promise.reject(
                new Error(`Mod ${hook.plugin} next.to requires a tier`),
              )
            }
            return continueBelow(rewritten, target)
          },
        },
        is: { value: (event: string) => matchesModEventPattern(event, options.event) },
        signal: { value: ownController.signal },
        event: { get: () => options.event },
        origin: { get: () => origin },
        trace: { get: () => traceEntries(node.below) },
        budget: { value: Object.freeze({
          ms: options.event === 'engine.create' ? 0 : allowance,
          get remainingMs() {
            return options.event === 'engine.create' ? Infinity
              : settledRemaining ?? Math.max(0, remaining - (timer === undefined ? 0 : performance.now() - started))
          },
        }) },
        ...(catching
          ? {
              error: { value: failure },
              called: { value: inFlight !== undefined },
            }
          : {}),
      })
      traces.set(next, traceListeners)
      budgets.set(next, { clock: budgetClock, pause: () => {
        if (ownController.signal.aborted) return () => {}
        external++
        stopTimer()
        let resumed = false
        return () => {
          if (resumed || ownController.signal.aborted) return
          resumed = true
          external--
          startTimer()
        }
      } })
      Object.freeze(next)
      const timeout = new Promise<never>((_resolve, reject) => {
        expire = () => {
          const error = new Error(
            `Mod ${hook.plugin} timed out for ${options.event}`,
          )
          timedOut = true
          phase = 'recovering'
          reject(error)
          ownController.abort(error)
        }
      })
      startTimer()
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            parent?.throwIfAborted()
            return hook.invoke(input, next, catching)
          }),
          timeout,
          abandoned,
        ])
      } finally {
        stopTimer()
        settledRemaining = Math.max(0, remaining)
        expire = undefined
        phase = parent?.aborted ? 'done' : 'recovering'
        ownController.abort(new Error(`Mod ${hook.plugin} invocation finished`))
      }
    }

    let returnedWithoutNext = false
    try {
      try {
        let result = await invoke(false)
        returnedWithoutNext = inFlight === undefined
        if (result === undefined)
          throw new Error(
            `Mod ${hook.plugin} returned undefined for ${options.event}`,
          )
        const passed = lastResolved && result === lastResult
        result = options.restoreResult?.(result, lastResolved ? lastResult : input, inFlight !== undefined) ?? result
        options.validateResult?.(result, nextResults)
        record(
          passed ? 'passed' : 'returned',
          result,
        )
        return result
      } catch (error) {
        parent?.throwIfAborted()
        if (!nextErrors.has(error)) options.onFailure?.(hook.plugin, error)
        if (options.event === 'engine.create') throw error
        // A receipt is not permission to enqueue. Even an invalid no-next
        // receipt must not fall through to the dispatcher's normal replay.
        if (options.event === 'session.receive' && returnedWithoutNext) {
          const result = { consumed: `Mod ${hook.plugin} returned without next` }
          record('returned', result)
          return result
        }
        let rejected = false
        let belowError: unknown
        if (inFlight) {
          await Promise.race([
            inFlight.then(
              () => {},
              (error) => {
                rejected = true
                belowError = error
              },
            ),
            abandoned,
          ])
        }
        if (hook.registration.hasCatch) {
          const message = timedOut
            ? rejected
              ? belowError instanceof Error
                ? belowError.message
                : String(belowError)
              : undefined
            : error instanceof Error
              ? error.message
              : String(error)
          const failure = Object.freeze({
            kind: timedOut ? 'timeout' : 'throw',
            ...(message === undefined ? {} : { message }),
            budget: catchGraceMs,
          })
          try {
            let result = await invoke(true, failure)
            returnedWithoutNext = inFlight === undefined
            if (result !== undefined) {
              result = options.restoreResult?.(result, lastResolved ? lastResult : input, inFlight !== undefined) ?? result
              options.validateResult?.(result, nextResults)
              record('caught', result)
              return result
            }
          } catch (catchError) {
            parent?.throwIfAborted()
            if (!nextErrors.has(catchError)) options.onFailure?.(hook.plugin, catchError)
          }
        }
        if (options.event === 'session.receive' && returnedWithoutNext) {
          const result = { consumed: `Mod ${hook.plugin} returned without next` }
          record('caught', result)
          return result
        }
        const outcome = timedOut ? 'expired' : inFlight ? 'kept' : 'skipped'
        const result = await Promise.race([replay(input), abandoned])
        record(outcome, result)
        return result
      }
    } catch (error) {
      record('rejected')
      throw error
    } finally {
      phase = 'done'
      stopTimer()
      parent?.removeEventListener('abort', abort)
      lifetime.abort(new Error(`Mod ${hook.plugin} frame finished`))
      controller.abort(lifetime.signal.reason)
    }
  }
  return run(0, options.input, options.signal)
}
