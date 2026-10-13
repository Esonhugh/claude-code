import type { ModDeclaration, ModHookStream, ModRegistration } from './types.js'

export type ModWorkerFault = {
  cause: 'heartbeat' | 'abort-overrun' | 'unload' | 'error' | 'exit'
  workerAgeMs: number
  pendingRequests: number
  pingAgeMs?: number
  culprit?: {
    environment: number
    plugin: string
    storageId: string
    evidence: 'stack' | 'resumed'
    stage: ModWorkerRequest['type'] | 'callback' | 'unknown'
    requestId?: number
    settledRequestId?: number
    handle?: number
  }
}

// Public process streams use the native generator lifecycle: closing before
// entry leaves result pending, while closing a pending read finishes that read.
export function createModProcessStream(
  pull: (method: 'next' | 'return' | 'throw', value: unknown) => Promise<IteratorResult<unknown, unknown>>,
): ModHookStream {
  const result = Promise.withResolvers<unknown>()
  void result.promise.catch(() => {})
  const interrupted = Promise.withResolvers<IteratorResult<unknown, unknown>>()
  let settled = false
  let closing: Promise<IteratorResult<unknown, unknown>> | undefined
  const iterator = (async function* () {
    let thrown: {error: unknown} | undefined
    try {
      for (;;) {
        const item = closing ? {done:true as const, value:undefined} : await Promise.race([
          pull(thrown ? 'throw' : 'next', thrown?.error), interrupted.promise,
        ])
        thrown = undefined
        if (item.done) {settled = true; result.resolve(item.value); return item.value}
        try {yield item.value} catch (error) {thrown = {error}}
      }
    } catch (error) {settled = true; result.reject(error); throw error}
    finally {
      if (!settled) result.reject(Object.assign(new Error('the stream was closed before its result'), {name:'HooksError'}))
    }
  })()
  const finish = iterator.return.bind(iterator)
  return Object.defineProperties(iterator, {
    result: {value:result.promise, enumerable:true},
    return: {value:(value: unknown) => {
      if (!settled && !closing) {
        try {closing = Promise.resolve(pull('return', value))}
        catch (error) {closing = Promise.reject(error)}
        void closing.catch(() => {})
        interrupted.resolve({done:true, value:undefined})
      }
      const returned = finish(value)
      return closing ? Promise.all([returned, closing]).then(([item]) => item) : returned
    }},
  }) as ModHookStream
}

// Shared with the VM bootstrap so both boundaries have identical pull/result semantics.
export function createModHookStream(
  pull: (method: 'next' | 'return' | 'throw', value: unknown) => Promise<IteratorResult<unknown, unknown>>,
  signal?: AbortSignal,
): ModHookStream {
  const result = Promise.withResolvers<unknown>()
  const canceled = Promise.withResolvers<never>()
  void result.promise.catch(() => {})
  void canceled.promise.catch(() => {})
  let closed = false
  let queue = Promise.resolve()
  const finish = () => {
    closed = true
    signal?.removeEventListener('abort', abort)
  }
  let closing: Promise<IteratorResult<unknown, unknown>> | undefined
  const cancel = (error: unknown, value: unknown) => {
    if (closing) return closing
    if (closed) return Promise.resolve({ done: true as const, value })
    result.reject(error)
    finish()
    canceled.reject(error)
    // Publish teardown before calling pull: cancellation may synchronously reenter.
    const completion = Promise.withResolvers<IteratorResult<unknown, unknown>>()
    closing = completion.promise
    void closing.catch(() => {})
    try { completion.resolve(pull('return', value)) }
    catch (error) { completion.reject(error) }
    return closing
  }
  const abort = () => {
    if (!closed) cancel(signal?.reason ?? new Error('Module invocation aborted'), undefined)
  }
  const run = (method: 'next' | 'return' | 'throw', value: unknown) => {
    if (method === 'return') return cancel(signal?.aborted ? signal.reason : value instanceof Error ? value : new Error('Module stream closed before completion'), value)
    const pending = queue.then(async () => {
      if (closed) {
        if (method === 'throw') throw value
        return { done: true as const, value: undefined }
      }
      try {
        const item = await Promise.race([pull(method, value), canceled.promise])
        if (item.done) { result.resolve(item.value); finish() }
        return item
      } catch (error) { result.reject(error); finish(); throw error }
    })
    queue = pending.then(() => {}, () => {})
    return pending
  }
  const stream = {
    next: (value?: unknown) => run('next', value),
    return: (value: unknown) => run('return', value),
    throw: (error: unknown) => run('throw', error),
    result: result.promise,
    [Symbol.asyncIterator]() { return this },
  } as ModHookStream
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return stream
}

export type ModWireValue =
  | { type: 'undefined' }
  | { type: 'value'; value: null | boolean | number | string }
  | { type: 'non-finite'; value: 'NaN' | 'Infinity' | '-Infinity' }
  | { type: 'array'; values: ModWireValue[] }
  | { type: 'regexp'; source: string; flags: string }
  | { type: 'object'; entries: [string, ModWireValue][] }
  | { type: 'engine'; id: number; value: ModWireValue }
  | { type: 'function'; id: number }
  | { type: 'host-function'; id: number; mutableResult?: true; storeMethod?: 'get' | 'set' | 'delete'; stateMethod?: 'get' | 'set'; stream?: boolean; streamLifetime?: 'environment'; modelMethod?: 'complete' | 'fork' | 'classify' }
  | { type: 'host-stream'; id: number; streamLifetime?: 'environment' }
  | { type: 'stream'; invocation: number }
  | { type: 'clock'; now: number; wait: number; cancel: number; run: number }
  | { type: 'ui'; methods: [string, ModWireValue][] }
  | { type: 'ui-core'; surface: string; component: string }
  | {
      type: 'ui-function'
      publication: number
      consumer: number
      provider: number
      id: number
    }
  | {
      type: 'ui-consumer-function'
      publication: number
      consumer: number
      provider: number
      id: number
    }

export type ModWorkerRequest =
  | { id: number; type: 'client'; environment: number; request: import('./client.js').ModClientRequest }
  | { type: 'ping'; n: number }
  | { type: 'settle'; barrier: number }
  | { id: number; type: 'load'; environment: number; declaration: ModDeclaration }
  | { id: number; type: 'load-client'; environment: number; declaration: ModDeclaration; module: string }
  | {
      id: number
      type: 'invoke'
      environment: number
      handle: number
      args: ModWireValue[]
      drawing?: number
      callbackDrawing?: number
      stream?: boolean
      callers?: number[]
      next?: {
        call: number
        to: number
        event: string
        origin: ModWireValue
        trace: ModWireValue
        budget?: SharedArrayBuffer
        error?: ModWireValue
        called?: boolean
      }
    }
  | { id: number; type: 'stream-pull'; environment: number; invocation: number; method: 'next' | 'return' | 'throw'; value: ModWireValue }
  | { id: number; type: 'unload'; environment: number }
  | { id: number; type: 'release-drawing'; environment: number; drawing: number }
  | { id: number; type: 'ui-access'; environment: number; allowed: boolean }
  | {
      id: number
      type: 'ui-tables'
      environment: number
      publication: number
      publish: boolean
      staged: number[]
      consumers: {
        environment: number
        tables: [string, ModWireValue][]
      }[]
    }
  | { type: 'abort'; environment: number; invocation: number; reason?: {name:string;message:string}; cooperative?: true }
  | { type: 'trace'; environment: number; invocation: number; trace: ModWireValue }
  | {
      type: 'host-result'
      environment: number
      call: number
      invocation?: number
      callback?: true
      trace?: ModWireValue
      value?: ModWireValue
      error?: string
      errorName?: 'HooksError'
      errorRef?: number
    }

export type ModWorkerReply =
  | { type: 'pong'; n: number }
  | { type: 'client-turn-complete'; environment: number; id: number }
  | { type: 'client-fault'; environment: number; instance: number; error: string; unmounted: boolean }
  | { type: 'client-phase'; id: number; phase: import('./client.js').ModClientFaultPhase }
  | { type: 'settled'; id: number }
  | { type: 'async-error'; environment: number; error: string }
  | {
      type: 'result'
      id: number
      invocation?: number
      value?: ModWireValue
      registrations?: (Omit<ModRegistration, 'matcher'> & { matcher?: ModWireValue; catchId?: number })[]
      error?: string
      clientFaultPhase?: import('./client.js').ModClientFaultPhase
      errorName?: string
      errorRef?: number
      aborted?: true
    }
  | {
      type: 'host-call'
      callback?: true
      serving?: number
      environment: number
      invocation: number
      call: number
      handle: number
      args: ModWireValue[]
      modelAborted?: boolean
      modelAbortReason?: {name:string;message:string}
    }
  | { type: 'model-abort'; environment: number; call: number; reason: {name:string;message:string} }
  | {
      type: 'ui-call'
      environment: number
      call: number
      wire: ModWireValue
      props: ModWireValue
    }
