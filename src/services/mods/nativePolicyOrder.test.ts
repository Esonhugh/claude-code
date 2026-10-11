import { expect, test } from 'bun:test'
import { SEC_DEFAULT_ID, shouldSeatSecDefault } from './native.js'
import type { PrepareModPluginsSettings } from './plugins.js'

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
