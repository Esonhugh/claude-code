import { expect, test } from 'bun:test'
import { getNativeModDeclaration, seatNativeModPlugins, SEC_DEFAULT_ID, shouldSeatSecDefault } from './native.js'
import { prepareModPlugins, type PrepareModPluginsSettings } from './plugins.js'
import type { LoadedPlugin } from '../../types/plugin.js'

const settings = (
  policyPluginOrdering: PrepareModPluginsSettings['policyPluginOrdering'],
  prependPlugins: string[] = [],
): PrepareModPluginsSettings => ({
  userSettings: null,
  flagSettings: null,
  policySettings: { prependPlugins },
  policyPluginOrdering,
  hookPolicy: { managedOnly: false, allDisabled: false },
})

test('an unverified policy snapshot cannot omit the native guard', () => {
  // Official 2.1.292 QV uses the vouched admin tier before the merged snapshot.
  expect(shouldSeatSecDefault(settings(null))).toBe(true)
  expect(shouldSeatSecDefault(settings(null, ['example@marketplace']))).toBe(true)
})

test('a vouched admin tier can omit or explicitly seat the native guard', () => {
  expect(shouldSeatSecDefault(settings({ prependPlugins: [] }))).toBe(false)
  expect(shouldSeatSecDefault(settings({ prependPlugins: ['example@marketplace'] }))).toBe(false)
  expect(shouldSeatSecDefault(settings({ prependPlugins: [SEC_DEFAULT_ID] }))).toBe(true)
})

test('a merged policy snapshot can add the guard after an admin tier omits it', () => {
  expect(shouldSeatSecDefault(settings({ prependPlugins: [] }, [SEC_DEFAULT_ID]))).toBe(true)
})

test('embedding hosts retain the ordering contract when they supply the policy tier', () => {
  expect(shouldSeatSecDefault(settings(undefined))).toBe(false)
})

// Official 2.1.292 QV canonicalizes both spellings; engine.create exposes the
// renamed manifest name, cc-plugin-sec-default, rather than the settings alias.
test.each([
  'cc-plugin-sec-default@builtin',
  'sec-default@builtin',
  'CC-PLUGIN-SEC-DEFAULT@BUILTIN',
  'SEC-DEFAULT@BUILTIN',
])('native guard identity and position resolve %s', id => {
  const order = ['before@marketplace', id, 'after@marketplace']
  const config = settings({ prependPlugins: order }, order)
  const inputs = ['before', 'after'].map(name => ({
    name,
    storageId: `${name}@marketplace`,
    pluginRoot: `/plugins/${name}`,
    entrypoints: [`/plugins/${name}/register.ts`],
    tier: 'prepend' as const,
  }))
  expect(shouldSeatSecDefault(config)).toBe(true)
  const seated = seatNativeModPlugins(inputs, config)
  expect(seated.map(input => input.storageId)).toEqual([
    'before@marketplace', 'cc-plugin-sec-default@builtin', 'after@marketplace',
  ])
  expect(getNativeModDeclaration(seated[1]!)).toMatchObject({
    name: 'cc-plugin-sec-default', storageId: 'cc-plugin-sec-default@builtin',
    isNative: true, tier: 'prepend',
  })
  expect(prepareModPlugins([], config).errors).toEqual([
    expect.objectContaining({ message: expect.stringContaining('before@marketplace') }),
    expect.objectContaining({ message: expect.stringContaining('after@marketplace') }),
  ])
  expect(shouldSeatSecDefault(settings({ prependPlugins: [] }, [id]))).toBe(true)
})

test.each(['sec-default', 'cc-plugin-sec-default'])(
  'a manifest named %s cannot replace the host-owned native guard', name => {
    const plugin: LoadedPlugin = {
      name, manifest: { name }, path: `/plugins/${name}`,
      source: `${name}@inline`, repository: `${name}@inline`, enabled: true,
      hookModules: [{ configPath: `/plugins/${name}/hooks.json`, paths: ['./register.ts'] }],
    }
    const config = settings({ prependPlugins: ['cc-plugin-sec-default@builtin'] })
    const result = prepareModPlugins([plugin], config)
    expect(result.inputs).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ plugin: name, stage: 'native', message: expect.stringContaining('host-owned') }),
    ])
  },
)

test('a similarly named external id does not seat the native guard', () => {
  const order = ['cc-plugin-sec-default@inline']
  expect(shouldSeatSecDefault(settings({ prependPlugins: order }, order))).toBe(false)
})
