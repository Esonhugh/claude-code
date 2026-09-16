import * as vm from 'node:vm'
import { isPromise, isProxy } from 'node:util/types'
import type { ModWorkerReply, ModWorkerRequest } from './protocol.js'

// This bootstrap runs in the VM realm. The bridge accepts and returns strings;
// neither a host object nor a host function is returned to plugin code.
const bootstrap = `((bridge, isProxy, isPromise) => {
  const functions = new Map();
  const wires = new WeakMap();
  const hostFunctions = new Map();
  const frames = new Map();
  const pending = new Map();
  const signals = new Map();
  const registrations = [];
  const timers = new Map();
  const report = error => {
    const message = error && (typeof error === 'object' || typeof error === 'function') && !isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
    bridge(JSON.stringify({ type: 'async-error', error: typeof message === 'string' ? message : 'Module asynchronous callback failed' }));
  };
  let nextHandle = 0, nextCall = 0, nextTimer = 0, registering = true, disposed = false;
  const encode = (value, seen = new Set()) => {
    if (value === undefined) return { type: 'undefined' };
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
      if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Non-finite module value');
      return { type: 'value', value };
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) throw Error('Unsupported module value (proxies are not allowed)');
    const cached = wires.get(value);
    if (cached) return cached;
    if (typeof value === 'function') {
      const id = ++nextHandle; functions.set(id, value);
      const wire = { type: 'function', id }; wires.set(value, wire); return wire;
    }
    if (seen.has(value) || seen.size > 100) throw Error('Unsupported module value');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = { type: 'array', values: Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) return { type: 'undefined' };
      if (!('value' in descriptor)) throw Error('Module accessors cannot cross the boundary');
      return encode(descriptor.value, seen);
    }) };
    else {
      const entries = [];
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw Error('Module accessors cannot cross the boundary');
        if (key === 'then' && typeof descriptor.value === 'function') throw Error('Module thenable values are unsupported');
        entries.push([key, encode(descriptor.value, seen)]);
      }
      result = { type: 'object', entries };
    }
    seen.delete(value);
    return result;
  };
  const decode = (wire, invocation) => {
    if (wire.type === 'undefined') return undefined;
    if (wire.type === 'value') return wire.value;
    if (wire.type === 'array') return Object.freeze(wire.values.map(v => decode(v, invocation)));
    if (wire.type === 'object') return Object.freeze(Object.fromEntries(wire.entries.map(([k,v]) => [k, decode(v, invocation)])));
    if (wire.type === 'function') {
      if (!functions.has(wire.id)) throw Error('Unknown module function');
      return functions.get(wire.id);
    }
    if (wire.type === 'clock') {
      const now = decode({ type: 'host-function', id: wire.now }, invocation);
      const wait = decode({ type: 'host-function', id: wire.wait }, invocation);
      const cancel = decode({ type: 'host-function', id: wire.cancel }, invocation);
      const runCallback = decode({ type: 'host-function', id: wire.run }, invocation);
      const validate = ms => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw Error('Invalid clock duration');
        if (disposed) throw Error('Module environment unloaded');
      };
      const abortError = () => Object.assign(Error('Module invocation aborted'), { name: 'AbortError' });
      const sleep = (ms, { signal } = {}) => new Promise((resolve, reject) => {
        validate(ms);
        if (signal?.aborted) { reject(signal.reason ?? abortError()); return; }
        const id = ++nextTimer;
        let active = true;
        const finish = (error, failed = false) => {
          if (!active) return;
          active = false; timers.delete(id);
          signal?.removeEventListener('abort', abort);
          if (failed) reject(error); else resolve();
        };
        const abort = () => {
          if (!active) return;
          cancel(id).catch(report);
          finish(signal?.reason ?? abortError(), true);
        };
        timers.set(id, abort);
        signal?.addEventListener('abort', abort, { once: true });
        wait('sleep', ms, id).then(() => finish(), error => finish(error, true));
      });
      const schedule = (kind, ms, callback) => {
        validate(ms);
        if (typeof callback !== 'function') throw Error('Clock callback must be a function');
        const id = ++nextTimer;
        let active = true;
        const stop = () => {
          if (!active) return;
          active = false; timers.delete(id);
          cancel(id).catch(report);
        };
        const run = () => {
          let callbackStarted = false;
          wait(kind, ms, id).then(async () => {
            if (!active || disposed) return;
            callbackStarted = true;
            if (kind === 'after') { active = false; timers.delete(id); }
            await runCallback(callback);
            if (kind === 'every' && active && !disposed) run();
          }).catch(error => {
            if ((!active && !callbackStarted) || disposed) return;
            active = false; timers.delete(id); report(error);
          });
        };
        timers.set(id, stop); run();
        return Object.freeze({ cancel: stop });
      };
      return Object.freeze({ now, sleep: Object.freeze(sleep), after: Object.freeze((ms, callback) => schedule('after', ms, callback)), every: Object.freeze((ms, callback) => schedule('every', ms, callback)) });
    }
    if (wire.type === 'host-function') {
      const cached = hostFunctions.get(wire.id);
      if (cached) return cached;
      const proxy = (...args) => {
        if (disposed) return Promise.reject(Error('Module environment unloaded'));
        const call = ++nextCall;
        return new Promise((resolve, reject) => {
          pending.set(call, { resolve, reject, invocation });
          try { bridge(JSON.stringify({ call, invocation, handle: wire.id, args: args.map(v => encode(v)) })); }
          catch (error) { pending.delete(call); reject(error); }
        });
      };
      hostFunctions.set(wire.id, proxy); wires.set(proxy, wire);
      return Object.freeze(proxy);
    }
    throw Error('Invalid module wire value');
  };
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const v of Object.values(value)) freeze(v);
      Object.freeze(value);
    }
    return value;
  };
  function on(event, matcher, handler) {
    if (!registering) throw Error('on() is only available during register()');
    if (typeof matcher === 'function') { handler = matcher; matcher = undefined; }
    const reserved = new Set(['__proto__', 'prototype', 'constructor']);
    const core = new Set(['engine', 'plugin', 'session', 'tool', 'clock', 'command', 'agent', 'mcp', 'prompt', 'model', 'turn', 'ui', 'fs', 'http', 'process', 'store', 'settings', 'env']);
    const supported = new Set(['engine.create', 'plugin.register', 'session.start', 'tool.call', 'clock.now', 'clock.sleep', 'clock.after', 'clock.every']);
    if (typeof event !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*[.][A-Za-z_][A-Za-z0-9_]*$/.test(event) || typeof handler !== 'function' || isProxy(handler)) throw Error('Invalid hook registration event or handler');
    const [noun, method] = event.split('.');
    if (reserved.has(noun) || reserved.has(method) || core.has(noun) && !supported.has(event)) throw Error('Unsupported hook event');
    let checkedMatcher;
    if (matcher !== undefined) {
      if (!matcher || typeof matcher !== 'object' || isProxy(matcher) || Object.getPrototypeOf(matcher) !== Object.prototype) throw Error('Invalid registration matcher');
      const entries = [];
      for (const key of Reflect.ownKeys(matcher)) {
        const descriptor = Object.getOwnPropertyDescriptor(matcher, key);
        if (typeof key !== 'string' || reserved.has(key) || !descriptor || !('value' in descriptor)) throw Error('Invalid registration matcher');
        const value = descriptor.value;
        if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw Error('Registration matcher requires primitive equality values');
        entries.push([key, value]);
      }
      checkedMatcher = Object.fromEntries(entries);
    }
    const id = encode(handler).id;
    const registration = { id, event, matcher: checkedMatcher, hasCatch: false };
    registrations.push(registration);
    return Object.freeze({ catch(handler) {
      if (!registering || registration.hasCatch || event === 'engine.create' || typeof handler !== 'function') {
        throw Error('Invalid hook catch registration');
      }
      registration.hasCatch = true;
      registration.catchId = encode(handler).id;
    } });
  }
  // A realm-local cooperative signal subset, not the browser EventTarget API.
  function makeSignal(invocation) {
    const listeners = new Map();
    let aborted = false, reason;
    const signal = Object.freeze({
      get aborted() { return aborted; }, get reason() { return reason; },
      addEventListener(type, listener, options) {
        if (type === 'abort' && listener && !listeners.has(listener)) listeners.set(listener, !!options?.once);
      },
      removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener); },
      throwIfAborted() { if (aborted) throw reason; },
    });
    signals.set(invocation, () => {
      if (aborted) return;
      aborted = true; reason = Object.assign(Error('Module invocation aborted'), { name: 'AbortError' });
      const event = Object.freeze({ type: 'abort', target: signal, currentTarget: signal });
      for (const [listener, once] of listeners) {
        if (once) listeners.delete(listener);
        try {
          if (typeof listener === 'function') listener.call(signal, event);
          else if (typeof listener.handleEvent === 'function') listener.handleEvent(event);
        } catch (error) { report(error); }
      }
      listeners.clear();
    });
    return signal;
  }
  return {
    on,
    async register(fn, options) {
      try { await fn(on, freeze(JSON.parse(options))); }
      finally { registering = false; }
      return JSON.stringify(registrations);
    },
    async invoke(text) {
      const request = JSON.parse(text);
      if (disposed || !functions.has(request.handle)) throw Error('Unknown or unloaded module function');
      const args = request.args.map(v => decode(v, request.id));
      if (request.next) {
        const meta = request.next;
        const frame = { active: true, trace: decode(meta.trace, request.id) };
        frames.set(request.id, frame);
        const call = decode({type:'host-function', id: meta.call}, request.id);
        const to = decode({type:'host-function', id: meta.to}, request.id);
        const next = (...args) => frame.active ? call(...args) : Promise.reject(Error('Module invocation already settled'));
        Object.defineProperties(next, {
          to: { value: Object.freeze((...args) => frame.active ? to(...args) : Promise.reject(Error('Module invocation already settled'))) },
          signal: { value: makeSignal(request.id) },
          event: { value: meta.event }, origin: { value: decode(meta.origin, request.id) },
          trace: { get: () => frame.trace },
          is: { value: Object.freeze((event) => event === meta.event) },
          ...(meta.error ? { error: { value: decode(meta.error, request.id) }, called: { value: meta.called } } : {}),
        });
        args.push(Object.freeze(next));
      }
      try {
        const value = Reflect.apply(functions.get(request.handle), undefined, args);
        return JSON.stringify(encode(isPromise(value) && !isProxy(value) ? await value : value));
      }
      finally {
        signals.delete(request.id);
        const frame = frames.get(request.id);
        if (frame) frame.active = false;
        frames.delete(request.id);
        if (request.next) { hostFunctions.delete(request.next.call); hostFunctions.delete(request.next.to); }
      }
    },
    result(text) {
      const result = JSON.parse(text), item = pending.get(result.call);
      if (!item) return;
      pending.delete(result.call);
      try {
        const frame = frames.get(result.invocation);
        if (frame && result.trace) frame.trace = decode(result.trace, result.invocation);
        if (result.error !== undefined) item.reject(Error(result.error));
        else item.resolve(decode(result.value, item.invocation));
      } catch (error) { item.reject(error); }
    },
    abort(invocation) { signals.get(invocation)?.(); },
    dispose() {
      if (disposed) return;
      for (const stop of timers.values()) stop();
      timers.clear(); disposed = true; registering = false;
      for (const abort of signals.values()) abort();
      for (const item of pending.values()) item.reject(Error('Module environment unloaded'));
      for (const frame of frames.values()) frame.active = false;
      signals.clear(); frames.clear(); pending.clear(); functions.clear(); hostFunctions.clear(); registrations.length = 0;
    },
  };
})`

type Environment = {
  context: vm.Context
  api: {
    register(fn: unknown, options: string): Promise<string>
    invoke(text: string): Promise<string>
    result(text: string): void
    abort(invocation: number): void
    dispose(): void
  }
}

const environments = new Map<number, Environment>()
const reply = (message: ModWorkerReply) => postMessage(message)

function createEnvironment(id: number): Environment {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  vm.runInContext(`
    for (const name of ['ShadowRealm', 'WebAssembly', 'FinalizationRegistry',
      'WeakRef', 'Atomics', 'SharedArrayBuffer', 'queueMicrotask',
      '$vm', 'gc', 'edenGC', 'fullGC', 'print', 'readFile', 'Loader']) {
      delete globalThis[name];
    }
  `, context)
  const api = vm.runInContext(bootstrap, context)((text: string) => {
    const data = JSON.parse(text)
    reply({ type: 'host-call', ...data, environment: id })
  }, isProxy, isPromise) as Environment['api']
  return { context, api }
}

self.onmessage = async (event: MessageEvent<ModWorkerRequest>) => {
  const request = event.data
  if (request.type === 'ping') { reply({ type: 'pong' }); return }
  if (request.type === 'host-result') {
    environments.get(request.environment)?.api.result(JSON.stringify(request))
    return
  }
  if (request.type === 'abort') {
    environments.get(request.environment)?.api.abort(request.invocation)
    return
  }
  try {
    if (request.type === 'unload') {
      environments.get(request.environment)?.api.dispose()
      environments.delete(request.environment)
      reply({ type: 'result', id: request.id })
      return
    }
    if (request.type === 'invoke') {
      const environment = environments.get(request.environment)
      if (!environment) throw new Error('Module environment unloaded')
      const value = JSON.parse(await environment.api.invoke(JSON.stringify(request)))
      reply({ type: 'result', id: request.id, value })
      return
    }
    if (environments.has(request.environment)) throw new Error('Duplicate module environment')
    const environment = createEnvironment(request.environment)
    environments.set(request.environment, environment)
    const declaration = request.declaration
    const modules = new Map<string, vm.SourceTextModule>()
    const source = new Map(declaration.modules.map(module => [module.path, module.source]))
    const empty = new vm.SyntheticModule([], () => {}, { context: environment.context })
    const getModule = (path: string): vm.SourceTextModule => {
      const cached = modules.get(path)
      if (cached) return cached
      const text = source.get(path)
      if (text === undefined) throw new Error('Module missing from scanned snapshot')
      const module = new vm.SourceTextModule(text, {
        context: environment.context,
        identifier: path,
        importModuleDynamically: () => { throw new Error('Dynamic module imports are not supported') },
      })
      modules.set(path, module)
      return module
    }
    // Multiple files declared by one plugin share a registration window.
    const entrypoints = declaration.entrypoints.map(getModule)
    for (const module of entrypoints) {
      if (module.status === 'unlinked') await module.link((specifier, parent) => {
        if (specifier === 'claude-code') return empty
        const link = declaration.links.find(link => link.from === parent.identifier && link.specifier === specifier)
        if (!link) throw new Error('Import missing from scanned snapshot')
        return getModule(link.to)
      })
      if (module.status === 'linked') await module.evaluate()
    }
    const exports = entrypoints.map(module => (module.namespace as { register?: unknown }).register)
    if (exports.some(register => typeof register !== 'function')) throw new Error('Hooks module must export register(on, options)')
    const registrations = JSON.parse(await environment.api.register(
      async (on: unknown, options: unknown) => {
        for (const register of exports) await (register as (on: unknown, options: unknown) => unknown)(on, options)
      },
      JSON.stringify(declaration.options),
    ))
    reply({ type: 'result', id: request.id, registrations })
  } catch (error) {
    if (request.type === 'load') {
      environments.get(request.environment)?.api.dispose()
      environments.delete(request.environment)
    }
    const message = error && (typeof error === 'object' || typeof error === 'function') && !isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value
      : undefined
    reply({ type: 'result', id: request.id, error: typeof message === 'string' ? message : 'Module invocation failed' })
  }
}
