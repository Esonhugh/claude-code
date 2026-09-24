import { afterEach, expect, test } from 'bun:test'
import { clearSessionCaches } from './caches.js'
import {
  getLastCacheSafeParams,
  saveCacheSafeParams,
  type CacheSafeParams,
} from '../../utils/forkedAgent.js'

afterEach(() => {
  saveCacheSafeParams(null)
})

test('clears the post-turn fork snapshot while preserving background agents', () => {
  saveCacheSafeParams({} as CacheSafeParams)

  clearSessionCaches(new Set(['preserved-background-agent']))

  expect(getLastCacheSafeParams()).toBeNull()
})
