import { isPromise, isProxy } from 'node:util/types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createModHookStream, type ModWireValue, type ModWorkerReply, type ModWorkerRequest } from './protocol.js'
import type { ModDeclaration, ModHookStream, ModInput, ModNext, ModRegistration } from './types.js'
import { matchesModEventPattern, normalizeModMatcher } from './matcher.js'
import { getModBudgetClock, subscribeModTrace } from './dispatch.js'
import type { ModClientFrame, ModClientRequest } from './client.js'

type ClockCallbacks = {
  now(): Promise<number>
  wait(kind: 'sleep' | 'after' | 'every', ms: number, id: number): Promise<void>
  cancel(id: number): void
  run?(callback: () => Promise<unknown>, kind: 'after' | 'every'): Promise<unknown>
}
const uiBridges = new WeakMap<object, Record<string, (...args: unknown[]) => unknown>>()
const uiCoreTables = new WeakMap<object, { surface: string; component: string }>()
export function createModUiCoreTable(surface: string, component: string): object {
  const table = Object.freeze(Object.create(null)) as object
  uiCoreTables.set(table, { surface, component })
  return table
}
export function createModUiBridge(methods: Record<string, (...args: unknown[]) => unknown>): object {
  const ui = Object.freeze(Object.create(null)) as object
  uiBridges.set(ui, methods)
  return ui
}

const clocks = new WeakMap<object, ClockCallbacks>()
const remoteFunctions = new WeakMap<object, { owner: object; id: number }>()

export function createModClockBridge(callbacks: ClockCallbacks): object {
  const clock = Object.freeze(Object.create(null)) as object
  clocks.set(clock, callbacks)
  return clock
}

type RemoteRegistration = (ModRegistration & { catchId?: number })[]
type HostFunction = (...args: unknown[]) => unknown
const storeMethods = new WeakMap<HostFunction, 'get' | 'set' | 'delete'>()
export function createModStoreBridge(method: 'get' | 'set' | 'delete', call: HostFunction): HostFunction {
  storeMethods.set(call, method)
  return call
}
const streamBridges = new WeakSet<HostFunction>()
export function createModStreamBridge<T extends HostFunction>(call: T): T {
  streamBridges.add(call)
  return call
}
type HostHandle = { environment: number; call: HostFunction; invocation?: number }
type Result = Extract<ModWorkerReply, { type: 'result' }>
type WithRequestId = Extract<ModWorkerRequest, { id: number }>
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type PendingRequest = { environment: number; resolve(value: Result): void; reject(error: Error): void }
type ClientInstance = {
  run(input: ModClientRequest): Promise<Result>
  stop(error: Error): void
}
type EnvironmentState = {
  declaration: ModDeclaration
  clients: Map<number, ClientInstance>
  handles: WeakMap<object, number>
  remote: Map<number, HostFunction>
  clocks: WeakMap<object, ModWireValue>
  clockValues: Map<number, object>
  engines: WeakMap<object, ModWireValue>
  cleanups: Set<() => void>
}

export type ModEnvironment = {
  id: number
  registrations: NonNullable<RemoteRegistration>
  invoke(handle: number, args: unknown[], next?: ModNext, drawing?: number): Promise<unknown>
  invokeStream(handle: number, args: unknown[], next: ModNext): ModHookStream
  invokeDrawing(drawing: number, handle: number, args: unknown[]): Promise<unknown>
  releaseDrawing(drawing: number): Promise<void>
  setUiAccess(allowed: boolean): Promise<void>
  client(input: import('./client.js').ModClientRequest): Promise<import('./client.js').ModClientFrame>
  dispose(): Promise<void>
}

function errorMessage(error: unknown, fallback: string): string {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || isProxy(error)) return fallback
  const message = Object.getOwnPropertyDescriptor(error, 'message')?.value
  return typeof message === 'string' ? message : fallback
}

export function createModEnvironmentHost({
  onDied,
  onError = error => console.error(error),
}: {
  onDied?: (error: Error) => void
  onError?: (error: Error, environment: number) => void
} = {}) {
  // Compiled builds must include worker.ts as an explicit worker.js entrypoint.
  const sourceWorker = import.meta.url.endsWith('.ts') && !import.meta.url.includes('/$bunfs/')
  const workerUrl = new URL(sourceWorker ? './worker.ts' : './worker.js', import.meta.url).href
  const worker = new Worker(workerUrl)
  const requests = new Map<number, PendingRequest>()
  const functions = new Map<number, HostHandle>()
  const environments = new Map<number, EnvironmentState>()
  const frames = new Map<number, { environment: number; next: ModNext }>()
  // Host leases must follow a provider's current call, not the invocation in
  // which its captured capability proxy was first encoded.
  const contexts = new Map<number, ReturnType<typeof AsyncLocalStorage.snapshot>>()
  const hostStreams = new Map<number, { environment: number; invocation: number; iterator: AsyncGenerator<unknown, unknown>; continuation: boolean }>()
  const invocationErrors = new Map<number, Map<number, unknown>>()
  const unloading = new Map<number, Promise<void>>()
  let nextRequest = 0, nextFunction = 0, nextEnvironment = 0, nextEngine = 0
  let dead: Error | undefined
  let disposal: Promise<void> | undefined
  let pingSent: number | undefined
  // Probe the event loop, not Promise duration: long asynchronous work is allowed.
  const heartbeat = setInterval(() => {
    if (pingSent !== undefined) {
      if (performance.now() - pingSent >= 5000) fail(new Error('Mods Worker is unresponsive'))
      return
    }
    if (requests.size === 0) return
    pingSent = performance.now()
    try { worker.postMessage({ type: 'ping' } satisfies ModWorkerRequest) }
    catch (error) { fail(new Error(errorMessage(error, 'Mods Worker heartbeat failed'))) }
  }, 250)
  heartbeat.unref?.()

  function report(error: unknown, environment: number) {
    try { onError(new Error(errorMessage(error, 'Module asynchronous callback failed')), environment) }
    catch (failure) { console.error(new Error(errorMessage(failure, 'Module error observer failed'))) }
  }

  function releaseHostStreams(environment: number, invocation?: number) {
    for (const [id, stream] of hostStreams) {
      if (stream.environment !== environment || invocation !== undefined && stream.invocation !== invocation) continue
      hostStreams.delete(id)
      functions.delete(id)
      // A failed streaming hook leaves its continuation for dispatch to resume.
      if (invocation !== undefined && stream.continuation) continue
      try { void stream.iterator.return(undefined).catch(error => report(error, environment)) }
      catch (error) { report(error, environment) }
    }
  }

  function revoke(environment: number) {
    releaseHostStreams(environment)
    const state = environments.get(environment)
    environments.delete(environment)
    for (const client of state?.clients.values() ?? []) client.stop(new Error('Module environment unloaded'))
    for (const cleanup of state?.cleanups ?? []) {
      try { cleanup() } catch (error) { report(error, environment) }
    }
    state?.cleanups.clear()
    state?.remote.clear()
    for (const [id, fn] of functions) if (fn.environment === environment) functions.delete(id)
    for (const [id, frame] of frames) if (frame.environment === environment) frames.delete(id)
    for (const [id, pending] of requests) if (pending.environment === environment) {
      requests.delete(id)
      pending.reject(new Error('Module environment unloaded'))
    }
  }

  function fail(error: Error, notify = true) {
    if (dead) return
    dead = error
    clearInterval(heartbeat)
    for (const request of requests.values()) request.reject(error)
    requests.clear()
    for (const environment of environments.keys()) revoke(environment)
    worker.terminate()
    if (notify) { try { onDied?.(error) } catch (failure) { report(failure, 0) } }
  }

  function stateFor(environment: number) {
    const state = environments.get(environment)
    if (!state) throw new Error('Module environment unloaded')
    return state
  }

  function hostHandle(environment: number, call: HostFunction, invocation?: number): number {
    const state = stateFor(environment)
    const cached = invocation === undefined ? state.handles.get(call) : undefined
    if (cached !== undefined) return cached
    const id = ++nextFunction
    functions.set(id, { environment, call, invocation })
    if (invocation === undefined) state.handles.set(call, id)
    return id
  }

  function encode(environment: number, value: unknown, seen = new Set<object>()): ModWireValue {
    if (value === undefined) return { type: 'undefined' }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite module value')
      return { type: 'value', value: value as null | string | boolean | number }
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) throw new Error('Unsupported module value (proxies are not allowed)')
    const state = stateFor(environment)
    if (typeof value === 'function') {
      const remote = remoteFunctions.get(value)
      if (remote) {
        if (remote.owner === state) return { type: 'function', id: remote.id }
        throw new Error('Function belongs to another module environment')
      }
      const storeMethod = storeMethods.get(value as HostFunction)
      return { type: 'host-function', id: hostHandle(environment, value as HostFunction), ...(storeMethod === undefined ? {} : { storeMethod }), ...(streamBridges.has(value as HostFunction) ? { stream: true } : {}) }
    }
    if (seen.has(value) || seen.size > 100) throw new Error('Unsupported module value')
    const ui = uiBridges.get(value)
    if (ui) return { type: 'ui', methods: Object.entries(ui).map(([key, fn]) => [key, encode(environment, fn, seen)]) }
    const uiCore = uiCoreTables.get(value)
    if (uiCore) return { type: 'ui-core', ...uiCore }
    const clock = clocks.get(value)
    if (clock) {
      const cached = state.clocks.get(value)
      if (cached) return cached
      const active = new Map<number, () => void>()
      const cancel = (id: number) => {
        const release = active.get(id)
        if (!release) return
        active.delete(id)
        release()
        clock.cancel(id)
      }
      state.cleanups.add(() => {
        for (const id of active.keys()) {
          try { cancel(id) } catch (error) { report(error, environment) }
        }
      })
      const wire: ModWireValue = {
        type: 'clock', now: hostHandle(environment, () => clock.now()),
        wait: hostHandle(environment, async (kind, ms, id) => {
          if (!['sleep', 'after', 'every'].includes(kind as string) || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || active.has(id)) throw new Error('Invalid clock wait')
          const canceled = new Promise<void>((_resolve, reject) => { active.set(id, () => reject(new Error('Clock wait canceled'))) })
          try { await Promise.race([clock.wait(kind as Parameters<ClockCallbacks['wait']>[0], ms, id), canceled]) }
          finally { active.delete(id) }
        }),
        cancel: hostHandle(environment, id => cancel(id as number)),
        run: hostHandle(environment, (callback, kind) => {
          if (typeof callback !== 'function') throw new Error('Clock callback must be callable')
          if (kind !== 'after' && kind !== 'every') throw new Error('Invalid clock callback kind')
          const run = callback as () => Promise<unknown>
          return clock.run ? clock.run(run, kind) : run()
        }),
      }
      state.clocks.set(value, wire)
      state.clockValues.set(wire.now, value)
      return wire
    }
    seen.add(value)
    const read = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('Host accessors cannot cross the module boundary')
      if (key === 'then' && typeof descriptor.value === 'function') throw new Error('Host thenable values are unsupported')
      return encode(environment, descriptor.value, seen)
    }
    const result: ModWireValue = Array.isArray(value)
      ? { type: 'array', values: Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) ? read(String(index)) : { type: 'undefined' }) }
      : { type: 'object', entries: Object.keys(value).map(key => [key, read(key)]) }
    seen.delete(value)
    return result
  }

  function decode(environment: number, value: ModWireValue): unknown {
    const state = stateFor(environment)
    switch (value.type) {
      case 'undefined': return undefined
      case 'value': return value.value
      case 'regexp': return new RegExp(value.source, value.flags)
      case 'array': return value.values.map(item => decode(environment, item))
      case 'object': return Object.fromEntries(value.entries.map(([key, item]) => [key, decode(environment, item)]))
      case 'function': {
        let fn = state.remote.get(value.id)
        if (!fn) {
          fn = (...args: unknown[]) => invoke(environment, value.id, args)
          state.remote.set(value.id, fn)
          remoteFunctions.set(fn, { owner: state, id: value.id })
        }
        return fn
      }
      case 'ui-function':
      case 'ui-consumer-function':
        throw new Error('UI table functions cannot cross the generic module boundary')
      case 'host-function': {
        const fn = functions.get(value.id)
        if (fn?.environment !== environment) throw new Error('Unknown module host function')
        return fn.call
      }
      case 'stream': throw new Error('Stream invocation tokens cannot cross back as data')
      case 'host-stream': throw new Error('Host stream tokens cannot cross back as data')
      case 'engine': throw new Error('Engine identity tokens cannot cross back as data')
      case 'ui': throw new Error('UI capability cannot cross back as data')
      case 'ui-core': throw new Error('UI core table cannot cross back as data')
      case 'clock': {
        const clock = state.clockValues.get(value.now)
        if (!clock || JSON.stringify(state.clocks.get(clock)) !== JSON.stringify(value)) throw new Error('Unknown module clock bridge')
        return clock
      }
    }
  }

  function mountClient(environment: number, input: ModClientRequest): ClientInstance {
    const state = stateFor(environment)
    if (!state.declaration.clients?.some(client => client.module === input.module)) throw new Error('Client module is not in the loaded snapshot')
    // Reuse the packaged Worker entrypoint, but never run Client code in the
    // shared hook Worker: terminating a drawing must not revoke its siblings.
    const drawing = new Worker(workerUrl)
    let stopped: Error | undefined
    let pending: { id: number; resolve(value: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
    const stop = (error: Error) => {
      if (stopped) return
      stopped = error
      if (state.clients.get(input.id) === instance) state.clients.delete(input.id)
      if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
      drawing.terminate()
    }
    const send = (message: WithoutId<Extract<ModWorkerRequest, { type: 'client' | 'load-client' }>>): Promise<Result> => {
      if (stopped) return Promise.reject(stopped)
      return new Promise((resolve, reject) => {
        const id = ++nextRequest
        const ms = message.type === 'load-client' ? 10000 : 1000
        const timer = setTimeout(() => stop(new Error(`Script execution timed out after ${ms}ms`)), ms)
        pending = { id, resolve, reject, timer }
        try { drawing.postMessage({ ...message, id }) }
        catch (error) { stop(new Error(errorMessage(error, 'Client Worker request failed'))) }
      })
    }
    drawing.onmessage = (event: MessageEvent<ModWorkerReply>) => {
      if (stopped) return
      const message = event.data
      if (message.type === 'async-error') {
        stop(new Error(message.error))
        report(new Error(message.error), environment)
      } else if (message.type === 'result' && pending?.id === message.id) {
        if (message.error !== undefined) { stop(new Error(message.error)); return }
        const current = pending
        pending = undefined
        clearTimeout(current.timer)
        current.resolve(message)
      }
    }
    drawing.onerror = event => stop(new Error(event.message || 'Client Worker failed'))
    drawing.onmessageerror = () => stop(new Error('Client Worker message could not be decoded'))
    drawing.addEventListener('close', () => stop(new Error('Client Worker exited')))
    let queue: Promise<void>
    const instance: ClientInstance = {
      stop,
      run(request) {
        const operation = queue.then(() => send({ type: 'client', environment, request }))
        queue = operation.then(() => {}, () => {})
        return operation
      },
    }
    state.clients.set(input.id, instance)
    queue = send({ type: 'load-client', environment, declaration: state.declaration, module: input.module! }).then(() => {})
    void queue.catch(() => {})
    return instance
  }

  async function client(environment: number, input: ModClientRequest): Promise<ModClientFrame> {
    const state = stateFor(environment)
    let instance = state.clients.get(input.id)
    if (input.op === 'dispose' || input.op === 'mount') {
      instance?.stop(new Error('Client instance unmounted'))
      if (input.op === 'dispose') return {}
      instance = mountClient(environment, input)
    }
    if (!instance) return { stopped: true }
    const result = await instance.run(input)
    return decode(environment, result.value!) as ModClientFrame
  }

  function request(message: WithoutId<WithRequestId>, id = ++nextRequest): Promise<Result> {
    if (dead) return Promise.reject(dead)
    return new Promise((resolve, reject) => {
      requests.set(id, { environment: message.environment, resolve, reject })
      try { worker.postMessage({ ...message, id }) }
      catch (error) { requests.delete(id); reject(new Error(errorMessage(error, 'Mods Worker request failed'))) }
    })
  }

  worker.onmessage = async (event: MessageEvent<ModWorkerReply>) => {
    const message = event.data
    if (message.type === 'pong') { pingSent = undefined; return }
    if (message.type === 'async-error') {
      if (environments.has(message.environment)) report(new Error(message.error), message.environment)
      return
    }
    if (message.type === 'result') {
      const pending = requests.get(message.id)
      if (!pending) return
      requests.delete(message.id)
      if (message.error !== undefined) {
        const errors = invocationErrors.get(message.invocation ?? message.id)
        if (message.errorRef !== undefined && errors?.has(message.errorRef)) pending.reject(errors.get(message.errorRef) as Error)
        else pending.reject(new Error(message.error))
      }
      else pending.resolve(message)
      return
    }
    if (message.type === 'ui-call') {
      const response: Extract<ModWorkerRequest, { type: 'host-result' }> = { type: 'host-result', environment: message.environment, call: message.call }
      try {
        stateFor(message.environment)
        if (message.wire.type !== 'ui-consumer-function' || message.wire.provider !== message.environment)
          throw new Error('UI table callback was withdrawn')
        stateFor(message.wire.consumer)
        const value = message.props
        if (value.type !== 'object') throw new Error('Invalid UI callback input')
        const entries = new Map(value.entries)
        const drawing = entries.get('drawing')
        const input = entries.get('input')
        if (drawing?.type !== 'value' || !Number.isSafeInteger(drawing.value) || (drawing.value as number) <= 0 || !input)
          throw new Error('Invalid UI callback input')
        const result = await invoke(message.wire.consumer, message.wire.id, [decode(message.wire.consumer, input)], undefined, undefined, drawing.value as number)
        response.value = encode(message.environment, result)
      } catch (error) { response.error = errorMessage(error, 'UI callback failed') }
      if (!dead && environments.has(message.environment)) worker.postMessage(response)
      return
    }
    const fn = functions.get(message.handle)
    const response: Extract<ModWorkerRequest, { type: 'host-result' }> = { type: 'host-result', environment: message.environment, call: message.call }
    try {
      stateFor(message.environment)
      if (fn?.environment !== message.environment || typeof fn.call !== 'function') throw new Error('Unknown or unloaded module capability')
      if (fn.invocation !== undefined && (fn.invocation !== message.invocation || !contexts.has(fn.invocation))) throw new Error('Module invocation already settled')
      const args = message.args.map(value => decode(message.environment, value))
      const context = contexts.get(message.invocation)
      if (streamBridges.has(fn.call) && !context) throw new Error('Module invocation already settled')
      const value = context ? context(fn.call, ...args) : fn.call(...args)
      if (streamBridges.has(fn.call)) {
        const iterator = value as AsyncGenerator<unknown, unknown>
        if (!iterator || isProxy(iterator) || typeof iterator.next !== 'function' || typeof iterator.return !== 'function' || typeof iterator.throw !== 'function') throw new Error('Streaming capability must return an async iterator')
        const id = hostHandle(message.environment, async (method, input) => {
          const stream = hostStreams.get(id)
          if (!stream) throw new Error('Module stream already settled')
          if (method !== 'next' && method !== 'return' && method !== 'throw') throw new Error('Invalid stream pull')
          try {
            const value = method === 'throw' && input && typeof input === 'object' && typeof (input as {message?: unknown}).message === 'string'
              ? Object.assign(new Error((input as {message:string}).message), {name:(input as {name?:string}).name ?? 'Error'}) : input
            const item = await iterator[method](value)
            if (item.done) { hostStreams.delete(id); functions.delete(id) }
            return item
          } catch (error) { hostStreams.delete(id); functions.delete(id); throw error }
        }, message.invocation)
        hostStreams.set(id, {environment:message.environment, invocation:message.invocation, iterator, continuation:fn.invocation !== undefined})
        response.value = {type:'host-stream', id}
      } else response.value = encode(message.environment, isPromise(value) && !isProxy(value) ? await value : value)
    } catch (error) {
      response.error = errorMessage(error, 'Module capability failed')
      const errors = invocationErrors.get(message.invocation)
      if (errors && fn?.environment === message.environment) {
        response.errorRef = message.call
        errors.set(message.call, error)
      }
    }
    try {
      if (fn?.invocation !== undefined) {
        const frame = frames.get(fn.invocation)
        if (frame) { response.invocation = fn.invocation; response.trace = encode(message.environment, frame.next.trace) }
      }
    } catch (error) { response.error = errorMessage(error, 'Module trace snapshot failed') }
    if (!dead && environments.has(message.environment)) {
      try { worker.postMessage(response) } catch (error) { fail(new Error(errorMessage(error, 'Mods Worker response failed'))) }
    }
  }
  worker.onerror = event => fail(new Error(event.message || 'Mods Worker failed'))
  worker.onmessageerror = () => fail(new Error('Mods Worker message could not be decoded'))
  // Bun's Web Worker exit event is named close (node:worker_threads calls it exit).
  worker.addEventListener('close', () => fail(new Error('Mods Worker exited')))

  async function invoke(environment: number, handle: number, args: unknown[], next?: ModNext, drawing?: number, callbackDrawing?: number, streaming = false) {
    const state = stateFor(environment)
    const id = ++nextRequest
    contexts.set(id, AsyncLocalStorage.snapshot())
    invocationErrors.set(id, new Map())
    let call: number | undefined, to: number | undefined
    let unsubscribeTrace: (() => void) | undefined
    let overrun: ReturnType<typeof setTimeout> | undefined
    let retained = false
    const streamAbort = new AbortController()
    const unloaded = () => streamAbort.abort(new Error('Module environment unloaded'))
    const cleanup = () => {
      retained = false
      unsubscribeTrace?.()
      frames.delete(id)
      contexts.delete(id)
      invocationErrors.delete(id)
      state.cleanups.delete(unloaded)
      next?.signal.removeEventListener('abort', cancel)
      if (overrun) clearTimeout(overrun)
      releaseHostStreams(environment, id)
      if (call !== undefined) functions.delete(call)
      if (to !== undefined) functions.delete(to)
    }
    const cancel = () => {
      if (dead || !environments.has(environment)) return
      worker.postMessage({ type: 'abort', environment, invocation: id } satisfies ModWorkerRequest)
      overrun ??= setTimeout(() => fail(new Error('Mods Worker did not settle an aborted invocation')), 5000)
      overrun.unref?.()
      if (streaming) streamAbort.abort(next?.signal.reason ?? new Error('Module invocation aborted'))
    }
    try {
      const argsWire = args.map((value, index) => {
        if (!next || index !== 0 || !value || typeof value !== 'object') return encode(environment, value)
        let wire = state.engines.get(value)
        if (!wire) {
          wire = { type: 'engine', id: ++nextEngine, value: encode(environment, value) }
          state.engines.set(value, wire)
        }
        return wire
      })
      if (next) {
        if (!state.declaration.events.some(pattern => matchesModEventPattern(pattern, next.event))) throw new Error('Invocation event is absent from scan')
        frames.set(id, { environment, next })
        const live = () => { if (!frames.has(id)) throw new Error('Module invocation already settled') }
        call = hostHandle(environment, (input: unknown) => { live(); return next(input as ModInput) }, id)
        to = hostHandle(environment, (input: unknown, tier: unknown) => {
          live()
          if (!['prepend', 'user', 'append', 'builtin', 'core'].includes(tier as string) || !state.declaration.nextTiers.includes(tier as Parameters<ModNext['to']>[1])) throw new Error('Module next tier is absent from scan')
          return next.to(input as ModInput, tier as Parameters<ModNext['to']>[1])
        }, id)
        if (next.event === 'turn.step') {
          createModStreamBridge(functions.get(call)!.call)
          createModStreamBridge(functions.get(to)!.call)
        }
      }
      const message: WithoutId<Extract<ModWorkerRequest, { type: 'invoke' }>> = {
        type: 'invoke', environment, handle, args: argsWire, drawing, callbackDrawing, stream: streaming,
        ...(next && call !== undefined && to !== undefined ? {
          next: { call, to, event: next.event, origin: encode(environment, next.origin), trace: encode(environment, next.trace), budget: getModBudgetClock(next), ...(next.error ? { error: encode(environment, next.error), called: next.called } : {}) },
        } : {}),
      }
      next?.signal.addEventListener('abort', cancel, { once: true })
      const pending = request(message, id)
      if (next) unsubscribeTrace = subscribeModTrace(next, () => {
        if (dead || !environments.has(environment) || !frames.has(id)) return
        try {
          worker.postMessage({ type: 'trace', environment, invocation: id, trace: encode(environment, next.trace) } satisfies ModWorkerRequest)
        } catch (error) { report(error, environment) }
      })
      if (next?.signal.aborted) cancel()
      const result = await pending
      if (streaming) {
        if (result.value?.type !== 'stream' || result.value.invocation !== id) throw new Error('Module did not return a stream')
        retained = true
        state.cleanups.add(unloaded)
        return createModHookStream(async (method, value) => {
          try {
            stateFor(environment)
            const response = await request({ type:'stream-pull', environment, invocation:id, method,
              value:encode(environment, value instanceof Error ? {message:value.message, name:value.name} : value) })
            const item = decode(environment, response.value!) as IteratorResult<unknown, unknown>
            if (item.done) cleanup()
            return item
          } catch (error) { cleanup(); throw error }
        }, streamAbort.signal)
      }
      return result.value ? decode(environment, result.value) : undefined
    } finally { if (!retained) cleanup() }
  }

  function invokeStream(environment: number, handle: number, args: unknown[], next: ModNext): ModHookStream {
    const opened = invoke(environment, handle, args, next, undefined, undefined, true) as Promise<ModHookStream>
    const result = opened.then(stream => stream.result)
    void result.catch(() => {})
    return {
      next: value => opened.then(stream => stream.next(value)),
      return: value => opened.then(stream => stream.return(value)),
      throw: error => opened.then(stream => stream.throw(error)),
      result,
      [Symbol.asyncIterator]() { return this },
    } as ModHookStream
  }

  function unload(environment: number): Promise<void> {
    const existing = unloading.get(environment)
    if (existing) return existing
    if (!environments.has(environment)) return Promise.resolve()
    revoke(environment)
    const pending = (async () => {
      const timeout = setTimeout(() => fail(new Error('Mods Worker unload timed out')), 1000)
      timeout.unref?.()
      try { if (!dead) await request({ type: 'unload', environment }) }
      finally { clearTimeout(timeout); unloading.delete(environment) }
    })()
    unloading.set(environment, pending)
    return pending
  }

  let uiPublication = 0

  function encodeUiTable(
    consumer: number,
    publication: number,
    value: unknown,
    seen = new Set<object>(),
  ): ModWireValue {
    if (value === undefined) return { type: 'undefined' }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite module value')
      return { type: 'value', value: value as null | string | boolean | number }
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) throw new Error('Unsupported module value (proxies are not allowed)')
    if (typeof value === 'function') {
      const remote = remoteFunctions.get(value)
      if (!remote) throw new Error('UI tables may only contain module constructors')
      const provider = [...environments].find(([, owner]) => owner === remote.owner)?.[0]
      if (provider === undefined) throw new Error('Function belongs to an unloaded module environment')
      return { type: 'ui-function', publication, consumer, provider, id: remote.id }
    }
    if (seen.has(value) || seen.size > 100) throw new Error('Unsupported module value')
    const uiCore = uiCoreTables.get(value)
    if (uiCore) return { type: 'ui-core', ...uiCore }
    seen.add(value)
    const read = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('Host accessors cannot cross the module boundary')
      if (key === 'then' && typeof descriptor.value === 'function') throw new Error('Host thenable values are unsupported')
      return encodeUiTable(consumer, publication, descriptor.value, seen)
    }
    const result: ModWireValue = Array.isArray(value)
      ? { type: 'array', values: Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) ? read(String(index)) : { type: 'undefined' }) }
      : { type: 'object', entries: Object.keys(value).map(key => [key, read(key)]) }
    seen.delete(value)
    return result
  }

  return {
    async prepareUiTables(
      tables: ReadonlyMap<ModEnvironment, ReadonlyMap<string, object>>,
      stagedEnvironments: readonly ModEnvironment[],
    ): Promise<() => Promise<void>> {
      const publication = ++uiPublication
      const consumers = [...tables].map(([environment, values]) => {
        stateFor(environment.id)
        return {
          environment: environment.id,
          tables: [...values].map(([key, table]) => [key, encodeUiTable(environment.id, publication, table)] as [string, ModWireValue]),
        }
      })
      const staged = stagedEnvironments.map(environment => {
        stateFor(environment.id)
        return environment.id
      })
      await request({ type: 'ui-tables', environment: 0, publication, publish: false, staged, consumers })
      return async () => {
        await request({ type: 'ui-tables', environment: 0, publication, publish: true, staged, consumers: [] })
      }
    },
    async load(declaration: ModDeclaration): Promise<ModEnvironment> {
      if (dead || disposal) throw dead ?? new Error('Mods Worker disposed')
      const id = ++nextEnvironment
      environments.set(id, { declaration: structuredClone(declaration), clients: new Map(), handles: new WeakMap(), remote: new Map(), clocks: new WeakMap(), clockValues: new Map(), engines: new WeakMap(), cleanups: new Set() })
      const timeout = setTimeout(() => fail(new Error('Mods Worker module registration timed out')), 10000)
      timeout.unref?.()
      try {
        const result = await request({ type: 'load', environment: id, declaration })
        const registrations = (result.registrations ?? []).map(registration => ({
          ...registration,
          matcher: registration.matcher === undefined ? undefined : normalizeModMatcher(decode(id, registration.matcher)) as ModRegistration['matcher'],
        }))
        for (const registration of registrations) {
          if (!declaration.events.includes(registration.event)) throw new Error('Actual module registration is absent from scan')
        }
        return {
          id, registrations,
          client: input => client(id, input),
          invoke: (handle, args, next, drawing) => invoke(id, handle, args, next, drawing),
          invokeStream: (handle, args, next) => invokeStream(id, handle, args, next),
          invokeDrawing: (drawing, handle, args) => invoke(id, handle, args, undefined, undefined, drawing),
          releaseDrawing: async drawing => { if (environments.has(id)) await request({ type: 'release-drawing', environment: id, drawing }) },
          setUiAccess: async allowed => { await request({ type: 'ui-access', environment: id, allowed }) },
          dispose: () => unload(id),
        }
      } catch (error) {
        try { await unload(id) } catch (failure) { report(failure, id) }
        throw error
      } finally { clearTimeout(timeout) }
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        try { await Promise.all([...environments.keys()].map(unload).concat([...unloading.values()])) }
        finally { fail(new Error('Mods Worker disposed'), false) }
      })()
      return disposal
    },
  }
}
