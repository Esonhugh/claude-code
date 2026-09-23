import { afterEach, describe, expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import type { ModDeclaration } from './types.js'

const hosts: ReturnType<typeof createModEnvironmentHost>[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())) })

function declaration(source: string): ModDeclaration {
  return {
    name: 'globals-fixture', storageId: 'globals-fixture@local', pluginRoot: '/globals-fixture',
    entrypoints: ['/globals-fixture/register.js'], modules: [{ path: '/globals-fixture/register.js', source }],
    links: [], events: ['tool.call'], calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: source,
  }
}

describe('Mods Worker hooks globals', () => {
  test('provides realm-local Web globals without console or host code generation', async () => {
    const host = createModEnvironmentHost()
    hosts.push(host)
    const environment = await host.load(declaration(`
      const names = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
        'AbortSignal', 'structuredClone', 'crypto', 'atob', 'btoa', 'performance'];
      const types = Object.fromEntries(names.map(name => [name, typeof globalThis[name]]));
      export function register(on) {
        on('tool.call', async () => {
          if (Object.values(types).some(type => type === 'undefined')) return { types, console: typeof console };

          const url = new URL('/before?x=1', 'https://example.test/root');
          url.pathname = '/after';
          url.searchParams.append('x', '2');
          const params = new URLSearchParams({ first: '1' });
          params.set('second', '2');
          const entries = [];
          params.forEach((value, key) => entries.push([key, value]));

          const bytes = new TextEncoder().encode('mods');
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map(value => value.toString(16).padStart(2, '0')).join('');
          const random = new Uint8Array(16);
          const randomIdentity = crypto.getRandomValues(random) === random;

          const controller = new AbortController();
          let abortCalls = 0;
          controller.signal.addEventListener('abort', () => abortCalls++, { once: true });
          controller.abort('stopped');
          controller.abort('ignored');
          const combined = AbortSignal.any([controller.signal]);
          const timeout = AbortSignal.timeout(0);
          if (!timeout.aborted) await new Promise(resolve => timeout.addEventListener('abort', resolve, { once: true }));

          const original = { nested: { value: 1 }, map: new Map([['key', 2]]) };
          original.self = original;
          const cloned = structuredClone(original);
          let codeGenerationBlocked = false;
          try { URL.constructor('return process')(); }
          catch { codeGenerationBlocked = true; }

          return {
            types,
            own: names.every(name => Object.hasOwn(globalThis, name)),
            hardened: names.every(name => {
              const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
              return descriptor && descriptor.writable === false && descriptor.configurable === false;
            }),
            console: typeof console,
            boundaries: [typeof process, typeof Bun, typeof document, typeof setTimeout, typeof WebAssembly],
            url: {
              href: url.href, origin: url.origin, params: url.searchParams.getAll('x'),
              instance: url instanceof URL, paramsInstance: url.searchParams instanceof URLSearchParams,
              canParse: URL.canParse('/relative', 'https://example.test'), entries,
            },
            text: {
              decoded: new TextDecoder().decode(bytes),
              encoderInstance: new TextEncoder() instanceof TextEncoder,
              decoderInstance: new TextDecoder() instanceof TextDecoder,
            },
            abort: {
              controllerInstance: controller instanceof AbortController,
              signalInstance: controller.signal instanceof AbortSignal,
              aborted: controller.signal.aborted, reason: controller.signal.reason, abortCalls,
              combined: combined.aborted && combined.reason === 'stopped',
              timeout: timeout.aborted && timeout.reason && timeout.reason.name === 'TimeoutError',
            },
            clone: {
              distinct: cloned !== original && cloned.nested !== original.nested,
              cycle: cloned.self === cloned,
              realm: Object.getPrototypeOf(cloned) === Object.prototype && cloned.map instanceof Map,
              frozen: Object.isFrozen(cloned),
            },
            base64: [btoa('mods'), atob('bW9kcw==')],
            crypto: {
              digest, randomIdentity, randomLength: random.length,
              uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()),
              frozen: Object.isFrozen(crypto) && Object.isFrozen(crypto.subtle),
            },
            performance: Number.isFinite(performance.now()) && performance.now() >= 0 && Object.isFrozen(performance),
            localConstructors: [URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
              structuredClone, atob, btoa, crypto.randomUUID, crypto.getRandomValues, crypto.subtle.digest,
              performance.now, TextEncoder.prototype.encode, TextDecoder.prototype.decode]
              .every(value => value instanceof Function),
            codeGenerationBlocked,
          };
        });
      }
    `))

    expect(await environment.invoke(environment.registrations[0]!.id, [])).toEqual({
      types: {
        URL: 'function', URLSearchParams: 'function', TextEncoder: 'function', TextDecoder: 'function',
        AbortController: 'function', AbortSignal: 'function', structuredClone: 'function', crypto: 'object',
        atob: 'function', btoa: 'function', performance: 'object',
      },
      own: true,
      hardened: true,
      console: 'undefined',
      boundaries: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
      url: {
        href: 'https://example.test/after?x=1&x=2', origin: 'https://example.test', params: ['1', '2'],
        instance: true, paramsInstance: true, canParse: true, entries: [['first', '1'], ['second', '2']],
      },
      text: { decoded: 'mods', encoderInstance: true, decoderInstance: true },
      abort: {
        controllerInstance: true, signalInstance: true, aborted: true, reason: 'stopped', abortCalls: 1,
        combined: true, timeout: true,
      },
      clone: { distinct: true, cycle: true, realm: true, frozen: false },
      base64: ['bW9kcw==', 'mods'],
      crypto: {
        digest: '695073cb6649c0a436759ea78c82d167625811577eab63269ccd8a19701e9422',
        randomIdentity: true, randomLength: 16, uuid: true, frozen: true,
      },
      performance: true,
      localConstructors: true,
      codeGenerationBlocked: true,
    })
  })
})
