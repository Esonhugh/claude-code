import { afterEach, expect, test } from 'bun:test'
import { clearSessionCaches } from './caches.js'
import { recordToolsUsed, resetToolsUsedForTesting, toolsUsedNames } from '../../tools/PollTool/toolsUsed.js'
import {
  getLastCacheSafeParams,
  saveCacheSafeParams,
  type CacheSafeParams,
} from '../../utils/forkedAgent.js'

afterEach(() => {
  saveCacheSafeParams(null)
  resetToolsUsedForTesting()
})

test('clears the post-turn fork snapshot while preserving background agents', () => {
  saveCacheSafeParams({} as CacheSafeParams)

  clearSessionCaches(new Set(['preserved-background-agent']))

  expect(getLastCacheSafeParams()).toBeNull()
})

test('forgets the tools the cleared conversation used, so a later Poll delivery does not name them', () => {
  recordToolsUsed(['Bash', 'Poll', 'REPL'])

  clearSessionCaches()

  expect(toolsUsedNames()).toEqual([])
})
