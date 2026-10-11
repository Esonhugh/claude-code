import { afterEach, expect, test } from 'bun:test'
import {
  isRemoteManagedSettingsVerified,
  resetSyncCache,
  setSessionCache,
} from './syncCacheState.js'

afterEach(resetSyncCache)

test('cached settings do not become verified by being read or assigned', () => {
  setSessionCache({ prependPlugins: [] })
  expect(isRemoteManagedSettingsVerified()).toBe(false)
})

test('successful server validation vouches only for that settings object', () => {
  const verified = { prependPlugins: [] }
  setSessionCache(verified, true)
  expect(isRemoteManagedSettingsVerified()).toBe(true)
  setSessionCache(verified)
  expect(isRemoteManagedSettingsVerified()).toBe(true)
  setSessionCache({ prependPlugins: [] })
  expect(isRemoteManagedSettingsVerified()).toBe(false)
})

test('empty server results and reset cannot vouch for a later snapshot', () => {
  setSessionCache({}, true)
  expect(isRemoteManagedSettingsVerified()).toBe(true)
  resetSyncCache()
  expect(isRemoteManagedSettingsVerified()).toBe(false)
  setSessionCache({})
  expect(isRemoteManagedSettingsVerified()).toBe(false)
  setSessionCache(null, true)
  expect(isRemoteManagedSettingsVerified()).toBe(false)
})
