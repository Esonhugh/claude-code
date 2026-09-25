import type { ModDeclaration, ModHookStream, ModRegistration } from './types.js'

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
  const abort = () => {
    if (closed) return
    const error = signal?.reason ?? new Error('Module invocation aborted')
    result.reject(error)
    finish()
    canceled.reject(error)
    void pull('return', undefined).catch(() => {})
  }
  const run = (method: 'next' | 'return' | 'throw', value: unknown) => {
    const pending = queue.then(async () => {
      if (closed) {
        if (method === 'throw') throw value
        return { done: true as const, value: method === 'return' ? value : undefined }
      }
      if (method === 'return') result.reject(new Error('Module stream closed before its result'))
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
  | { type: 'array'; values: ModWireValue[] }
  | { type: 'regexp'; source: string; flags: string }
  | { type: 'object'; entries: [string, ModWireValue][] }
  | { type: 'engine'; id: number; value: ModWireValue }
  | { type: 'function'; id: number }
  | { type: 'host-function'; id: number; storeMethod?: 'get' | 'set' | 'delete'; stream?: boolean }
  | { type: 'host-stream'; id: number }
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
  | { type: 'ping' }
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
  | { type: 'abort'; environment: number; invocation: number }
  | { type: 'trace'; environment: number; invocation: number; trace: ModWireValue }
  | {
      type: 'host-result'
      environment: number
      call: number
      invocation?: number
      trace?: ModWireValue
      value?: ModWireValue
      error?: string
      errorRef?: number
    }

export type ModWorkerReply =
  | { type: 'pong' }
  | { type: 'async-error'; environment: number; error: string }
  | {
      type: 'result'
      id: number
      invocation?: number
      value?: ModWireValue
      registrations?: (Omit<ModRegistration, 'matcher'> & { matcher?: ModWireValue; catchId?: number })[]
      error?: string
      errorRef?: number
    }
  | {
      type: 'host-call'
      environment: number
      invocation: number
      call: number
      handle: number
      args: ModWireValue[]
    }
  | {
      type: 'ui-call'
      environment: number
      call: number
      wire: ModWireValue
      props: ModWireValue
    }
