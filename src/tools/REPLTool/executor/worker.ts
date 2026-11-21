/**
 * Worker side of the Code Mode executor. host.ts starts it from a Blob made
 * of `replWorkerMain.toString()`, so the function must not reference imports
 * or anything outside its own body; modules come from
 * `process.getBuiltinModule`, which bundlers leave alone. This keeps one
 * code path for `bun run` and the compiled binary without a build entry.
 *
 * Only strings and primitives cross between this realm and the vm context:
 * tool inputs are stringified and results parsed by the context's own JSON,
 * so script code never holds an object (or Function constructor) from the
 * worker realm, where code generation is allowed.
 */

export type ReplWorkerToolSpec = { name: string; names: string[] }

export type ReplHostMessage =
  | {
      t: 'run'
      runId: number
      code: string
      /** JSON of ReplWorkerToolSpec[] */
      tools: string
      /** JSON of Record<name, description> */
      descriptions: string
      search: boolean
      /** Script evaluated once per context before its first run (the helper globals). */
      prelude?: string
      /** The script's async-lane eval number, what running() marks as self. */
      evalId?: number
    }
  | { t: 'reply'; id: number; json: string }
  /** Asks for the globals scripts defined (not the built-in, helper or tool ones). */
  | { t: 'globals'; id: number }
  /** JSON of ReplRunningRow[]: the session's evals, for running(). */
  | { t: 'running'; json: string }

/** A session eval as `running()` shows it; the worker adds `ageMs`, `self` and `abort`. */
export type ReplRunningRow = { id: number; snippet: string; startedAt: number | null; state: string; settled: boolean }

export type ReplWorkerMessage =
  | { t: 'call'; runId: number; id: number; kind: 'tool' | 'search'; name: string; input?: string }
  | { t: 'log'; runId: number; stream: 0 | 1; text: string }
  | { t: 'done'; runId: number; value?: string; error?: string; /** Timers still waiting when the script ended, now cancelled. */ timers?: number }
  | { t: 'globals'; id: number; names: string[] }
  /** A script called abort() on a running() row. */
  | { t: 'abort'; id: number }

export function replWorkerMain(): void {
  type Builtins = {
    getBuiltinModule(id: 'node:vm'): typeof import('node:vm')
    getBuiltinModule(id: 'node:util'): typeof import('node:util')
    getBuiltinModule(id: 'node:async_hooks'): typeof import('node:async_hooks')
  }
  const proc = (globalThis as unknown as { process: Builtins & { on(event: string, fn: (reason: unknown) => void): void } }).process
  const vm = proc.getBuiltinModule('node:vm')
  const util = proc.getBuiltinModule('node:util')
  const { AsyncLocalStorage } = proc.getBuiltinModule('node:async_hooks')
  const scope = globalThis as unknown as {
    postMessage(message: ReplWorkerMessage): void
    onmessage: ((event: { data: ReplHostMessage }) => void) | null
  }
  const post = (message: ReplWorkerMessage) => scope.postMessage(message)

  // Same intrinsic hardening as the official hardenVMIntrinsics.
  const HARDEN = `(() => {
    Object.defineProperty(Error, 'prepareStackTrace', {
      value: (err) => { const s = err.stack; return typeof s === 'string' ? s : '' },
      writable: false, configurable: false,
    });
    for (const g of ['ShadowRealm', 'WebAssembly', 'FinalizationRegistry', 'WeakRef', 'Atomics',
                     'SharedArrayBuffer', 'queueMicrotask', '$vm', 'gc', 'edenGC', 'fullGC',
                     'print', 'readFile', 'Loader', 'console']) {
      delete globalThis[g];
    }
    function enableOverride(proto, key) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || 'get' in d) return;
      const v = d.value;
      Object.defineProperty(proto, key, {
        get() { return v },
        set(nv) {
          if (this === proto) return;
          Object.defineProperty(this, key, { value: nv, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable, configurable: true,
      });
    }
    const errorCtors = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
                        AggregateError, globalThis.SuppressedError].filter(Boolean);
    const errorProtos = errorCtors.map(C => C.prototype);
    // 'constructor' stays a data property: util.inspect reads it from the descriptor
    // to name objects, and an accessor makes every object print as a null-prototype one.
    for (const [proto, keys] of [
      [Object.prototype, Object.getOwnPropertyNames(Object.prototype)],
      [Function.prototype, ['toString', 'constructor', 'name', 'length']],
      [Array.prototype, ['toString', 'constructor']],
      [Date.prototype, ['toString', 'toLocaleString', 'valueOf', 'constructor']],
      ...errorProtos.map(p => [p, ['name', 'message', 'toString', 'constructor']]),
    ]) for (const k of keys) if (k !== 'constructor') enableOverride(proto, k);
    for (const C of [Promise, Object, Array, Function, globalThis.Iterator, Map, Set, WeakMap, WeakSet,
                     String, Number, Boolean, Symbol, BigInt, Date, RegExp, ArrayBuffer, DataView,
                     ...errorCtors, typeof URL !== 'undefined' ? URL : undefined].filter(Boolean)) {
      Object.freeze(C);
      Object.freeze(C.prototype);
    }
    for (const C of [Object.getPrototypeOf(Int8Array), Int8Array, Uint8Array, Uint8ClampedArray,
                     Int16Array, Uint16Array, Int32Array, Uint32Array, globalThis.Float16Array,
                     Float32Array, Float64Array, BigInt64Array, BigUint64Array].filter(Boolean)) {
      Object.freeze(C);
      Object.freeze(C.prototype);
    }
    for (const f of [async()=>{}, function*(){}, async function*(){}]) {
      Object.freeze(f.constructor);
      Object.freeze(f.constructor.prototype);
    }
    for (const C of [globalThis.DisposableStack, globalThis.AsyncDisposableStack, globalThis.Intl].filter(Boolean)) {
      Object.freeze(C);
      if (C.prototype) Object.freeze(C.prototype);
    }
    for (const ns of [JSON, Math, Reflect, Proxy]) Object.freeze(ns);
    Object.defineProperty(globalThis, 'then', { value: undefined, writable: false, configurable: false });
    Object.defineProperty(globalThis, 'Error', { value: Error, writable: false, enumerable: false, configurable: false });
    if (typeof Intl !== 'undefined') {
      for (const k of Object.getOwnPropertyNames(Intl)) {
        const C = Intl[k];
        if (typeof C === 'function') {
          Object.freeze(C);
          if (C.prototype) Object.freeze(C.prototype);
        }
      }
    }
    for (const it of [
      [][Symbol.iterator](), ''[Symbol.iterator](), new Map()[Symbol.iterator](), new Set()[Symbol.iterator](),
      'a'.matchAll(/a/g),
      ...(typeof Iterator !== 'undefined' && Iterator.from
        ? [[].values().map(x => x), Iterator.from({ next: () => ({ done: true }) })] : []),
      (function*(){})(), (async function*(){})(),
      ...(typeof Intl !== 'undefined' && Intl.Segmenter
        ? (s => [s, s[Symbol.iterator]()])(new Intl.Segmenter().segment('a')) : []),
    ]) {
      for (let p = Object.getPrototypeOf(it); p; p = Object.getPrototypeOf(p)) Object.freeze(p);
    }
  })()`

  // Context-side kernel: built from the context's own intrinsics before any
  // script runs. Its arguments are worker functions that take and return
  // primitives only.
  const KERNEL = `((bridge, schedule, cancel, sink, b64, fmt, ledger, abortEval) => {
    'use strict';
    const parse = JSON.parse, stringify = JSON.stringify, define = Object.defineProperty;
    const freeze = Object.freeze, keys = Object.keys, ErrorCtor = Error, TypeErrorCtor = TypeError;
    const timers = new Map();
    let nextTimer = 1;
    let installed = [];
    async function call(kind, name, input) {
      let payload;
      if (input !== undefined) {
        try { payload = stringify(input) } catch (e) {
          throw new TypeErrorCtor(name + ': the input could not be serialized as JSON (' + (e && e.message) + ')');
        }
      }
      const reply = parse(await bridge(kind, name, payload));
      if (reply.ok) return reply.value;
      const error = new ErrorCtor(reply.message);
      if (typeof reply.name === 'string') error.name = reply.name;
      if ('detail' in reply) error.detail = reply.detail;
      throw error;
    }
    // console.* goes to a bounded ring, not the output; console.tail(n) reads it back.
    const ring = [];
    let dropped = 0;
    const record = (...args) => { ring.push(fmt(args)); if (ring.length > 1000) { ring.shift(); dropped++ } };
    const console = freeze({
      log: record, info: record, debug: record, warn: record, error: record,
      tail: (n = 20) => ring.slice(-Math.max(0, Number(n) || 0)).join('\\n'),
      buffer: () => ring.join('\\n'),
      dropped: () => dropped,
    });
    const log = (...args) => sink(0, args);
    function addTimer(fn, ms, args, repeat) {
      if (typeof fn !== 'function') throw new TypeErrorCtor('The callback must be a function');
      const id = nextTimer++;
      timers.set(id, { fn, args, repeat });
      schedule(id, Number(ms) || 0, repeat);
      return id;
    }
    function clearTimer(id) { if (timers.delete(id)) cancel(id) }
    const forget = id => { timers.delete(id) };
    function describeError(e) {
      let name = 'Error', message = '';
      try { const v = e?.name; if (typeof v === 'string') name = v } catch {}
      try {
        const v = e?.message;
        if (typeof v === 'string') message = v;
        else if (e === null || (typeof e !== 'object' && typeof e !== 'function')) { name = 'Uncaught'; message = String(e) }
      } catch {}
      return name + ': ' + message;
    }
    // Official running(): the session's evals; abort() stops one.
    const running = () => parse(ledger()).map(row => freeze({ ...row, abort: () => (abortEval(row.id), true) }));
    const globals = {
      console, log, self: globalThis, running,
      setTimeout: (fn, ms, ...args) => addTimer(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => addTimer(fn, ms, args, true),
      clearTimeout: clearTimer, clearInterval: clearTimer,
      atob: s => { const r = b64(0, String(s)); if (r === null) throw new TypeErrorCtor('atob: the string is not valid base64'); return r },
      btoa: s => { const r = b64(1, String(s)); if (r === null) throw new TypeErrorCtor('btoa: the string has characters outside Latin-1'); return r },
    };
    for (const k of keys(globals)) define(globalThis, k, { value: globals[k], writable: true, configurable: true });
    return freeze({
      install(toolsJson, descriptionsJson, search) {
        for (const n of installed) try { delete globalThis[n] } catch {}
        installed = [];
        const specs = parse(toolsJson), descriptions = parse(descriptionsJson);
        const tools = { __proto__: null };
        const byName = { __proto__: null };
        for (const spec of specs) {
          const fn = input => call('tool', spec.name, input);
          define(fn, 'name', { value: spec.names[0] ?? spec.name });
          for (const n of spec.names) {
            tools[n] = fn;
            byName[n] = spec.name;
            try {
              define(globalThis, n, { value: fn, writable: true, configurable: true });
              installed.push(n);
            } catch {}
          }
        }
        tools.list = () => specs.map(s => s.name);
        const extra = {
          tools: freeze(tools),
          describeTool: async name => {
            const real = byName[String(name)];
            if (real === undefined || descriptions[real] === undefined) return { error: 'No tool is named ' + String(name) + ': tools.list() gives the names' };
            return { name: real, description: descriptions[real].description, inputSchema: descriptions[real].inputSchema };
          },
          searchTools: (query, max) => {
            if (!search) return Promise.reject(new ErrorCtor('searchTools is not available in this REPL call'));
            return call('search', '', { query: String(query ?? ''), ...(max === undefined ? {} : { max: Number(max) }) });
          },
        };
        for (const k of keys(extra)) {
          define(globalThis, k, { value: extra[k], writable: true, configurable: true });
          installed.push(k);
        }
      },
      fire(id) {
        const timer = timers.get(id);
        if (!timer) return;
        if (!timer.repeat) timers.delete(id);
        try { timer.fn(...timer.args) } catch (e) { sink(1, ['Uncaught ' + describeError(e)]) }
      },
      forget,
      // Promises (and thenables such as $ results) inside a returned object or array are awaited.
      async settle(value) {
        const isThen = v => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
        if (isThen(value)) value = await value;
        if (value === null || typeof value !== 'object') return value;
        const proto = Object.getPrototypeOf(value);
        if (Array.isArray(value)) {
          if (!value.some(isThen)) return value;
          return Promise.all(value);
        }
        if (proto !== Object.prototype && proto !== null) return value;
        const entries = Object.entries(value);
        if (!entries.some(([, v]) => isThen(v))) return value;
        const settled = await Promise.all(entries.map(([, v]) => v));
        return Object.fromEntries(entries.map(([k], i) => [k, settled[i]]));
      },
      describeError,
    });
  })`

  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(HARDEN, context)

  const inspect = (value: unknown) =>
    typeof value === 'string'
      ? value
      : util.inspect(value, { colors: false, depth: 4, customInspect: false, showProxy: true, getters: false, maxStringLength: 30000, maxArrayLength: 200 })

  // Scripts can overlap (a detached one runs beside the next), so the run a
  // call, log or timer belongs to follows the async context it came from.
  const owner = new AsyncLocalStorage<number>()
  let lastRunId = 0
  const runIdNow = () => owner.getStore() ?? lastRunId
  let nextCall = 1
  const pending = new Map<number, (json: string) => void>()
  // What running() reads: the host's latest snapshot, and each run's eval number.
  let runningJson = '[]'
  const evalIds = new Map<number, number>()
  const handles = new Map<number, { handle: ReturnType<typeof setTimeout>; runId: number }>()
  const clearHandle = (id: number) => {
    const entry = handles.get(id)
    if (entry === undefined) return
    clearTimeout(entry.handle)
    clearInterval(entry.handle)
    handles.delete(id)
  }

  type Kernel = {
    install(tools: string, descriptions: string, search: boolean): void
    fire(id: number): void
    forget(id: number): void
    settle(value: unknown): Promise<unknown>
    describeError(error: unknown): string
  }
  const kernel = (vm.runInContext(KERNEL, context) as (...args: unknown[]) => Kernel)(
    (kind: 'tool' | 'search', name: string, input: string | undefined) =>
      new Promise<string>(resolve => {
        const id = nextCall++
        pending.set(id, resolve)
        post({ t: 'call', runId: runIdNow(), id, kind, name, ...(input === undefined ? {} : { input }) })
      }),
    (id: number, ms: number, repeat: boolean) => {
      const fire = () => kernel.fire(id)
      const handle = repeat ? setInterval(fire, ms) : setTimeout(() => { handles.delete(id); fire() }, ms)
      handles.set(id, { handle, runId: runIdNow() })
    },
    clearHandle,
    (stream: 0 | 1, args: unknown[]) => {
      let text: string
      try { text = Array.from(args, inspect).join(' ') } catch { text = '[unprintable]' }
      post({ t: 'log', runId: runIdNow(), stream, text })
    },
    (direction: 0 | 1, text: string) => {
      try { return direction === 0 ? atob(text) : btoa(text) } catch { return null }
    },
    (args: unknown[]) => {
      try { return Array.from(args, inspect).join(' ') } catch { return '[unprintable]' }
    },
    () => {
      const self = evalIds.get(runIdNow())
      const now = Date.now()
      return JSON.stringify(
        (JSON.parse(runningJson) as ReplRunningRow[]).map(({ startedAt, ...row }) => ({
          ...row,
          ageMs: startedAt === null ? 0 : now - startedAt,
          self: row.id === self,
        })),
      )
    },
    (id: number) => post({ t: 'abort', id: Number(id) }),
  )
  let preludeRan = false
  // Taken before any script can redefine it; only strings come back.
  const ownNames = vm.runInContext('(o => () => o(globalThis))(Object.getOwnPropertyNames)', context) as () => string[]
  const builtinNames = new Set(Array.from(ownNames(), String))
  let toolNames = new Set<string>()
  let baselined = false

  // A rejection nobody handled must not take the worker (and the context) down.
  proc.on('unhandledRejection', reason => {
    post({ t: 'log', runId: runIdNow(), stream: 1, text: `Unhandled rejection: ${kernel.describeError(reason)}` })
  })

  // The error must come from the context realm, or the script would hold a worker-realm object.
  const throwInContext = vm.runInContext('(m => { throw new Error(m) })', context) as (message: string) => never
  const rejectImport = () => throwInContext('Module loading (import) is not available in REPL \u2014 the vm context is sealed.')

  // A script's timers end with it; another script's keep running.
  const clearRunTimers = (runId: number): number => {
    let cleared = 0
    for (const [id, entry] of handles)
      if (entry.runId === runId) {
        clearHandle(id)
        kernel.forget(id)
        cleared++
      }
    return cleared
  }

  async function run(message: Extract<ReplHostMessage, { t: 'run' }>) {
    lastRunId = message.runId
    if (message.evalId !== undefined) evalIds.set(message.runId, message.evalId)
    try {
      kernel.install(message.tools, message.descriptions, message.search)
      toolNames = new Set((JSON.parse(message.tools) as ReplWorkerToolSpec[]).flatMap(spec => [spec.name, ...spec.names]))
      // The kernel's globals on the first run, and what the helper prelude adds, aren't the scripts'.
      if (!baselined) {
        baselined = true
        for (const name of ownNames()) if (!toolNames.has(name)) builtinNames.add(String(name))
      }
      if (message.prelude !== undefined && !preludeRan) {
        preludeRan = true
        const before = new Set(Array.from(ownNames(), String))
        vm.runInContext(message.prelude, context, { filename: 'repl-helpers.js' })
        for (const name of ownNames()) if (!before.has(String(name))) builtinNames.add(String(name))
      }
      const script = new vm.Script(message.code, {
        filename: 'repl-tool-code.js',
        importModuleDynamically: rejectImport as never,
      })
      const completion = (await script.runInContext(context)) as { value?: unknown } | undefined
      const value = await kernel.settle(completion?.value)
      const timers = clearRunTimers(message.runId)
      post({ t: 'done', runId: message.runId, ...(value === undefined ? {} : { value: inspect(value) }), ...(timers > 0 && { timers }) })
    } catch (error) {
      post({ t: 'done', runId: message.runId, error: kernel.describeError(error) })
    } finally {
      clearRunTimers(message.runId)
      evalIds.delete(message.runId)
    }
  }

  scope.onmessage = ({ data }) => {
    if (data.t === 'run') void owner.run(data.runId, () => run(data))
    else if (data.t === 'globals') {
      const names = Array.from(ownNames(), String).filter(name => !builtinNames.has(name) && !toolNames.has(name))
      post({ t: 'globals', id: data.id, names })
    }
    else if (data.t === 'running') runningJson = data.json
    else if (data.t === 'reply') {
      const resolve = pending.get(data.id)
      pending.delete(data.id)
      resolve?.(data.json)
    }
  }
}
