type WebHost = {
  URL: typeof URL
  URLSearchParams: typeof URLSearchParams
  TextEncoder: typeof TextEncoder
  TextDecoder: typeof TextDecoder
  structuredClone(value: unknown): unknown
  atob(data: string): string
  btoa(data: string): string
  crypto: Pick<Crypto, 'getRandomValues' | 'randomUUID'> & { subtle: Pick<SubtleCrypto, 'digest'> }
  performance: Pick<Performance, 'now'>
  schedule(callback: () => void, milliseconds: number): void
}

// Executed inside each Mod VM. Host Web implementations stay captured behind
// realm-local constructors and functions, so their Function and prototypes do not escape.
export function createModWebRealm(host: WebHost) {
  const tagOf = Function.prototype.call.bind(Object.prototype.toString)
  const localError = (error: any) => {
    let name = 'Error', message = 'Web operation failed'
    try {
      if (typeof error?.name === 'string') name = error.name
      if (typeof error?.message === 'string') message = error.message
    } catch { /* deliberately ignore untrusted inspection and listener errors */ }
    const Constructor = name === 'TypeError' ? TypeError : name === 'RangeError' ? RangeError : Error
    const result = new Constructor(message)
    if (result.name !== name) Object.defineProperty(result, 'name', { value: name, configurable: true })
    return result
  }
  const attempt = <T>(callback: () => T): T => {
    try { return callback() }
    catch (error) { throw localError(error) }
  }
  const attemptAsync = async <T>(callback: () => Promise<T>): Promise<T> => {
    try { return await callback() }
    catch (error) { throw localError(error) }
  }

  const urlValues = new WeakMap<object, string>()
  const urlParameters = new WeakMap<object, InstanceType<typeof RealmURLSearchParams>>()
  const parameterValues = new WeakMap<object, { owner?: object; value?: string }>()
  const parametersToken = Object.freeze({})
  const requireUrl = (value: object) => {
    const href = urlValues.get(value)
    if (href === undefined) throw new TypeError('Illegal invocation')
    return href
  }
  const unwrapUrl = (value: unknown) => value && typeof value === 'object' && urlValues.has(value)
    ? requireUrl(value)
    : value
  const requireParameters = (value: object) => {
    const state = parameterValues.get(value)
    if (!state) throw new TypeError('Illegal invocation')
    return state
  }
  const readParameters = (value: object) => {
    const state = requireParameters(value)
    return attempt(() => state.owner
      ? new host.URL(requireUrl(state.owner)).searchParams
      : new host.URLSearchParams(state.value))
  }
  const updateParameters = (value: object, update: (parameters: URLSearchParams) => void) => {
    const state = requireParameters(value)
    attempt(() => {
      const parameters = state.owner
        ? new host.URL(requireUrl(state.owner)).searchParams
        : new host.URLSearchParams(state.value)
      update(parameters)
      if (state.owner) {
        const url = new host.URL(requireUrl(state.owner))
        url.search = parameters.toString()
        urlValues.set(state.owner, url.href)
      } else state.value = parameters.toString()
    })
  }
  class RealmURLSearchParams {
    constructor(init?: string | Record<string, string> | string[][] | object, owner?: object) {
      if (init === parametersToken) { parameterValues.set(this, { owner }); return }
      const value = init instanceof RealmURLSearchParams ? init.toString() : init
      parameterValues.set(this, { value: attempt(() => new host.URLSearchParams(value as any).toString()) })
    }
    append(name: string, value: string) { updateParameters(this, item => item.append(String(name), String(value))) }
    delete(name: string) { updateParameters(this, item => item.delete(String(name))) }
    get(name: string) { return attempt(() => readParameters(this).get(String(name))) }
    getAll(name: string) { return attempt(() => Array.from(readParameters(this).getAll(String(name)))) }
    has(name: string) { return attempt(() => readParameters(this).has(String(name))) }
    set(name: string, value: string) { updateParameters(this, item => item.set(String(name), String(value))) }
    sort() { updateParameters(this, item => item.sort()) }
    toString() { return attempt(() => readParameters(this).toString()) }
    forEach(callback: (value: string, key: string, parameters: RealmURLSearchParams) => void) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function')
      for (const [key, value] of this.entries()) callback(value, key, this)
    }
    entries() {
      return attempt(() => Array.from(readParameters(this).entries(), item => Array.from(item) as [string, string]))[Symbol.iterator]()
    }
    keys() { return attempt(() => Array.from(readParameters(this).keys()))[Symbol.iterator]() }
    values() { return attempt(() => Array.from(readParameters(this).values()))[Symbol.iterator]() }
    [Symbol.iterator]() { return this.entries() }
  }
  Object.defineProperty(RealmURLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true })

  class RealmURL {
    constructor(url: string | object, base?: string | object) {
      urlValues.set(this, attempt(() => new host.URL(unwrapUrl(url) as string, base === undefined ? undefined : unwrapUrl(base) as string).href))
    }
    static canParse(url: string, base?: string) {
      return attempt(() => host.URL.canParse(unwrapUrl(url) as string, base === undefined ? undefined : unwrapUrl(base) as string))
    }
    toString() { return requireUrl(this) }
    toJSON() { return requireUrl(this) }
    get searchParams() {
      let parameters = urlParameters.get(this)
      if (!parameters) {
        parameters = new RealmURLSearchParams(parametersToken, this)
        urlParameters.set(this, parameters)
      }
      return parameters
    }
  }
  for (const key of ['hash', 'host', 'hostname', 'href', 'password', 'pathname', 'port', 'protocol', 'search', 'username'] as const) {
    Object.defineProperty(RealmURL.prototype, key, {
      configurable: true,
      enumerable: true,
      get(this: RealmURL) { return attempt(() => new host.URL(requireUrl(this))[key]) },
      set(this: RealmURL, value: string) {
        attempt(() => {
          const url = new host.URL(requireUrl(this))
          url[key] = String(value)
          urlValues.set(this, url.href)
        })
      },
    })
  }
  Object.defineProperty(RealmURL.prototype, 'origin', {
    configurable: true,
    enumerable: true,
    get(this: RealmURL) { return attempt(() => new host.URL(requireUrl(this)).origin) },
  })
  Object.defineProperty(RealmURL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true })

  class RealmTextEncoder {
    get encoding() { return 'utf-8' }
    encode(input = '') { return new Uint8Array(attempt(() => new host.TextEncoder().encode(String(input)))) }
  }
  Object.defineProperty(RealmTextEncoder.prototype, Symbol.toStringTag, { value: 'TextEncoder', configurable: true })
  const decoderValues = new WeakMap<object, TextDecoder>()
  class RealmTextDecoder {
    constructor(label = 'utf-8') { decoderValues.set(this, attempt(() => new host.TextDecoder(String(label)))) }
    get encoding() {
      const decoder = decoderValues.get(this)
      if (!decoder) throw new TypeError('Illegal invocation')
      return attempt(() => decoder.encoding)
    }
    decode(input?: ArrayBufferView | ArrayBuffer) {
      const decoder = decoderValues.get(this)
      if (!decoder) throw new TypeError('Illegal invocation')
      return attempt(() => decoder.decode(input))
    }
  }
  Object.defineProperty(RealmTextDecoder.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true })

  type SignalState = { aborted: boolean; reason: unknown; listeners: Map<any, boolean> }
  const signalValues = new WeakMap<object, SignalState>()
  const signalToken = Object.freeze({})
  const abortError = (name: string, message: string) => Object.assign(new Error(message), { name })
  const requireSignal = (value: object) => {
    const state = signalValues.get(value)
    if (!state) throw new TypeError('Illegal invocation')
    return state
  }
  const fireAbort = (signal: RealmAbortSignal, reason: unknown) => {
    const state = requireSignal(signal)
    if (state.aborted) return
    state.aborted = true
    state.reason = reason
    const event = Object.freeze({ type: 'abort', target: signal, currentTarget: signal })
    for (const [listener, once] of state.listeners) {
      if (once) state.listeners.delete(listener)
      try {
        if (typeof listener === 'function') listener.call(signal, event)
        else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event)
      } catch { /* deliberately ignore untrusted inspection and listener errors */ }
    }
  }
  class RealmAbortSignal {
    constructor(token: object) {
      if (token !== signalToken) throw new TypeError('Illegal constructor')
      signalValues.set(this, { aborted: false, reason: undefined, listeners: new Map() })
    }
    static abort(reason: unknown = abortError('AbortError', 'This operation was aborted')) {
      const signal = new RealmAbortSignal(signalToken)
      fireAbort(signal, reason)
      return signal
    }
    static timeout(milliseconds: number) {
      const delay = Number(milliseconds)
      if (!Number.isFinite(delay) || delay < 0 || delay > 4294967295) throw new RangeError('Invalid timeout')
      const signal = new RealmAbortSignal(signalToken)
      attempt(() => host.schedule(() => fireAbort(signal, abortError('TimeoutError', 'The operation timed out')), delay))
      return signal
    }
    static any(signals: Iterable<{
      aborted: boolean
      reason: unknown
      addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void
      removeEventListener(type: string, listener: () => void): void
    }>) {
      const signal = new RealmAbortSignal(signalToken)
      const listeners: [any, () => void][] = []
      const finish = (source: any) => {
        if (signal.aborted) return
        for (const [item, listener] of listeners) item.removeEventListener('abort', listener)
        fireAbort(signal, source.reason)
      }
      for (const item of signals) {
        if (!item || typeof item.addEventListener !== 'function') throw new TypeError('Invalid AbortSignal')
        if (item.aborted) { finish(item); break }
        const listener = () => finish(item)
        listeners.push([item, listener])
        item.addEventListener('abort', listener, { once: true })
      }
      return signal
    }
    get aborted() { return requireSignal(this).aborted }
    get reason() { return requireSignal(this).reason }
    throwIfAborted() { const state = requireSignal(this); if (state.aborted) throw state.reason }
    addEventListener(type: string, listener: any, options?: { once?: boolean }) {
      const state = requireSignal(this)
      if (type === 'abort' && listener && !state.listeners.has(listener)) state.listeners.set(listener, !!options?.once)
    }
    removeEventListener(type: string, listener: any) { if (type === 'abort') requireSignal(this).listeners.delete(listener) }
  }
  Object.defineProperty(RealmAbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true })
  const controllerValues = new WeakMap<object, RealmAbortSignal>()
  class RealmAbortController {
    constructor() { controllerValues.set(this, new RealmAbortSignal(signalToken)) }
    get signal() {
      const signal = controllerValues.get(this)
      if (!signal) throw new TypeError('Illegal invocation')
      return signal
    }
    abort(reason: unknown = abortError('AbortError', 'This operation was aborted')) { fireAbort(this.signal, reason) }
  }
  Object.defineProperty(RealmAbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true })

  const typedArrays = Object.freeze(Object.fromEntries([
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  ].filter(name => typeof (globalThis as any)[name] === 'function').map(name => [name, (globalThis as any)[name]])))
  const realmStructuredClone = (value: unknown) => {
    const cloned = attempt(() => host.structuredClone(value))
    const seen = new Map<object, object>()
    const localize = (item: any): any => {
      if (item === null || typeof item !== 'object') return item
      if (seen.has(item)) return seen.get(item)
      const tag = tagOf(item)
      let result: any
      if (tag === '[object Array]') {
        result = []
        seen.set(item, result)
        for (const value of item) result.push(localize(value))
      } else if (tag === '[object Object]') {
        result = {}
        seen.set(item, result)
        for (const key of Object.keys(item)) result[key] = localize(item[key])
      } else if (tag === '[object Map]') {
        result = new Map()
        seen.set(item, result)
        for (const [key, value] of item) result.set(localize(key), localize(value))
      } else if (tag === '[object Set]') {
        result = new Set()
        seen.set(item, result)
        for (const value of item) result.add(localize(value))
      } else if (tag === '[object Date]') {
        result = new Date(item.getTime())
        seen.set(item, result)
      } else if (tag === '[object RegExp]') {
        result = new RegExp(item.source, item.flags)
        seen.set(item, result)
      } else if (tag === '[object ArrayBuffer]') {
        result = new ArrayBuffer(item.byteLength)
        seen.set(item, result)
        new Uint8Array(result).set(new Uint8Array(item))
      } else if (tag === '[object DataView]') {
        result = new DataView(localize(item.buffer), item.byteOffset, item.byteLength)
        seen.set(item, result)
      } else if (typedArrays[tag.slice(8, -1)]) {
        const Constructor = typedArrays[tag.slice(8, -1)]
        result = new Constructor(localize(item.buffer), item.byteOffset, item.length)
        seen.set(item, result)
      } else if (tag.endsWith('Error]')) {
        result = localError(item)
        seen.set(item, result)
      } else throw Object.assign(new Error('Value could not be cloned'), { name: 'DataCloneError' })
      return result
    }
    return localize(cloned)
  }

  const realmAtob = (data: string) => attempt(() => host.atob(String(data)))
  const realmBtoa = (data: string) => attempt(() => host.btoa(String(data)))
  const subtle = Object.freeze({
    digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const result = await attemptAsync(() => host.crypto.subtle.digest(algorithm, data))
      const copy = new Uint8Array(result.byteLength)
      copy.set(new Uint8Array(result))
      return copy.buffer
    },
  })
  const crypto = Object.freeze({
    subtle,
    randomUUID: () => attempt(() => host.crypto.randomUUID()),
    getRandomValues: <T extends ArrayBufferView>(array: T) => { attempt(() => host.crypto.getRandomValues(array)); return array },
  })
  const performance = Object.freeze({ now: () => attempt(() => host.performance.now()) })

  Object.defineProperties(globalThis, {
    URL: { value: RealmURL }, URLSearchParams: { value: RealmURLSearchParams },
    TextEncoder: { value: RealmTextEncoder }, TextDecoder: { value: RealmTextDecoder },
    AbortController: { value: RealmAbortController }, AbortSignal: { value: RealmAbortSignal },
    structuredClone: { value: realmStructuredClone }, crypto: { value: crypto },
    atob: { value: realmAtob }, btoa: { value: realmBtoa }, performance: { value: performance },
  })
}
