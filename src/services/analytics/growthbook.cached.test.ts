import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Features = Record<string, { value?: unknown; defaultValue?: unknown }>
let config: { cachedGrowthBookFeatures: Record<string, unknown>; growthBookOverrides?: Record<string, unknown> }
let payload: { features: Features }
let enabled = true
let internal = false
let unreadable = false
let initializations = 0
const previousOverrides = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
const modulePath = (path: string) => realpathSync(fileURLToPath(new URL(path.replace(/\.js$/, '.ts'), import.meta.url)))
class GrowthBookFixture {
  async init() { initializations++; return { success: true, source: 'network' } }
  getPayload() { return payload }
  async setPayload(value: typeof payload) { payload = value }
  getFeatures() { return payload.features }
  destroy() {}
}
mock.module('@growthbook/growthbook', () => ({ GrowthBook: GrowthBookFixture }))
mock.module(modulePath('../../bootstrap/state.js'), () => ({ getIsNonInteractiveSession: () => true, getSessionTrustAccepted: () => true }))
mock.module(modulePath('../../constants/keys.js'), () => ({ getGrowthBookClientKey: () => 'cache-contract' }))
mock.module(modulePath('../../utils/config.js'), () => ({
  checkHasTrustDialogAccepted: () => true,
  getGlobalConfig: () => { if (unreadable) throw new Error('unreadable configuration'); return config },
  saveGlobalConfig: (update: (value: typeof config) => typeof config) => { config = update(config) },
}))
mock.module(modulePath('../../utils/debug.js'), () => ({ logForDebugging() {} }))
mock.module(modulePath('../../utils/errors.js'), () => ({ toError: (error: unknown) => error }))
mock.module(modulePath('../../utils/http.js'), () => ({ getAuthHeaders: () => ({ headers: { 'x-api-key': 'fixture-only' } }) }))
mock.module(modulePath('../../utils/log.js'), () => ({ logError() {} }))
mock.module(modulePath('../../utils/slowOperations.js'), () => ({ jsonStringify: JSON.stringify }))
mock.module(modulePath('../../utils/user.js'), () => ({ getUserForGrowthBook: () => ({ deviceId: 'fixture', sessionId: 'fixture', platform: 'darwin' }) }))
mock.module(modulePath('../../utils/userType.js'), () => ({ isAnt: () => internal }))
mock.module(modulePath('./firstPartyEventLogger.js'), () => ({ is1PEventLoggingEnabled: () => enabled, logGrowthBookExperimentTo1P() {} }))
const { getFeatureValue_CACHED_MAY_BE_STALE: read, initializeGrowthBook, resetGrowthBook } = await import('./growthbook.js')
beforeEach(() => {
  resetGrowthBook(); enabled = true; internal = false; unreadable = false; initializations = 0
  config = { cachedGrowthBookFeatures: {} }; payload = { features: {} }
  delete process.env.CLAUDE_INTERNAL_FC_OVERRIDES
})
afterEach(() => {
  resetGrowthBook()
  if (previousOverrides === undefined) delete process.env.CLAUDE_INTERNAL_FC_OVERRIDES
  else process.env.CLAUDE_INTERNAL_FC_OVERRIDES = previousOverrides
})
// 官方 2.1.292 getFeatureValueWithSource uses Nu(value, fallback), where Nu replaces only null.
test('a null disk value returns the exact caller default without initializing the SDK', () => {
  config.cachedGrowthBookFeatures.flag = null
  const fallback = { enabled: true }
  expect(read('flag', fallback)).toBe(fallback)
  expect(initializations).toBe(0)
})
test('disk values preserve false, zero, empty strings, arrays and objects', () => {
  for (const value of [false, 0, '', [], { enabled: false }]) {
    config.cachedGrowthBookFeatures.flag = value
    expect(read<unknown>('flag', 'fallback')).toBe(value)
  }
})
test('missing or unreadable disk values use the default and disabled logging keeps the gate disabled', () => {
  expect(read('absent', true)).toBe(true)
  unreadable = true
  expect(read('absent', true)).toBe(true)
  unreadable = false; enabled = false; config.cachedGrowthBookFeatures.flag = true
  expect(read('flag', false)).toBe(false)
  expect(initializations).toBe(0)
})
for (const field of ['value', 'defaultValue'] as const) {
  test('a null remote ' + field + ' uses the default even when disk has an older value', async () => {
    payload.features.flag = { [field]: null }
    await initializeGrowthBook()
    expect(initializations).toBe(1)
    config.cachedGrowthBookFeatures.flag = 'stale'
    const fallback = { enabled: true }
    expect(read('flag', fallback)).toBe(fallback)
  })
}
test('the remote payload preserves false, zero, empty strings, arrays and objects', async () => {
  const values = [false, 0, '', [], { enabled: false }]
  values.forEach((value, index) => { payload.features['flag' + index] = { value } })
  await initializeGrowthBook()
  expect(initializations).toBe(1)
  values.forEach((value, index) => { config.cachedGrowthBookFeatures['flag' + index] = 'stale'; expect(read<unknown>('flag' + index, 'fallback')).toBe(value) })
})
test('a fresh payload missing a feature cannot resurrect a stale disk answer', async () => {
  payload.features.other = { value: true }
  await initializeGrowthBook()
  config.cachedGrowthBookFeatures.removed = true
  expect(read('removed', false)).toBe(false)
})
test('explicit internal overrides retain null rather than treating it as a payload fallback', () => {
  internal = true
  process.env.CLAUDE_INTERNAL_FC_OVERRIDES = JSON.stringify({ environment: null })
  config.growthBookOverrides = { configuration: null }
  expect(read<unknown>('environment', 'fallback')).toBeNull()
  expect(read<unknown>('configuration', 'fallback')).toBeNull()
})
