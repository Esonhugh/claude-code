import { expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import type { ModDeclaration } from './types.js'

const source = `export function register(on) {
  on('tool.call', async ($, input) => {
    if (input.propagate) return await $.fail();
    try { await $.fail(); } catch (error) { return {message:error.message}; }
  });
}`
const declaration: ModDeclaration = {
  name: 'native-error',
  storageId: 'native-error@fixture',
  pluginRoot: '/fixture',
  entrypoints: ['/fixture/register.js'],
  modules: [{ path: '/fixture/register.js', source }],
  links: [],
  events: ['tool.call'],
  calls: [],
  nextTiers: [],
  options: {},
  tier: 'user',
  fingerprint: source,
}

test('native DOMException message survives the real Worker boundary and original identity propagates', async () => {
  const host = createModEnvironmentHost()
  const original = new DOMException('The operation was aborted.', 'AbortError')
  try {
    const environment = await host.load(declaration)
    const engine = {
      fail: () => {
        throw original
      },
    }
    expect(
      await environment.invoke(environment.registrations[0]!.id, [engine, {}]),
    ).toEqual({ message: original.message })
    const propagated = await environment
      .invoke(environment.registrations[0]!.id, [engine, { propagate: true }])
      .catch((error) => error)
    expect(propagated).toBe(original)
  } finally {
    await host.dispose()
  }
})

test('native DOMException reading bypasses an overridden message getter', async () => {
  const host = createModEnvironmentHost()
  const original = new DOMException('Native failure', 'InvalidStateError')
  let accesses = 0
  Object.defineProperty(original, 'message', {
    get() {
      accesses++
      throw new Error('must not execute')
    },
  })
  try {
    const environment = await host.load(declaration)
    expect(
      await environment.invoke(environment.registrations[0]!.id, [
        {
          fail: () => {
            throw original
          },
        },
        {},
      ]),
    ).toEqual({ message: 'Native failure' })
    expect(accesses).toBe(0)
  } finally {
    await host.dispose()
  }
})

test('ordinary errors retain their message while accessors, proxies and forged native errors remain inert', async () => {
  const host = createModEnvironmentHost()
  let accesses = 0
  const accessor = {
    get message() {
      accesses++
      throw new Error('must not execute')
    },
  }
  const proxy = new Proxy(
    {},
    {
      get() {
        accesses++
        throw new Error('must not execute')
      },
      getOwnPropertyDescriptor() {
        accesses++
        throw new Error('must not execute')
      },
      getPrototypeOf() {
        accesses++
        throw new Error('must not execute')
      },
    },
  )
  try {
    const environment = await host.load(declaration)
    for (const [index, error] of [
      new Error('Ordinary failure'),
      accessor,
      proxy,
      Object.create(DOMException.prototype),
      'primitive failure',
    ].entries()) {
      const expected =
        index === 0 ? 'Ordinary failure' : 'Module capability failed'
      expect(
        await environment.invoke(environment.registrations[0]!.id, [
          {
            fail: () => {
              throw error
            },
          },
          {},
        ]),
      ).toEqual({ message: expected })
    }
    expect(accesses).toBe(0)
  } finally {
    await host.dispose()
  }
})
