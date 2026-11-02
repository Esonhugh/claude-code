import { afterEach, expect, test } from 'bun:test'

import { getDefaultAppState } from '../state/AppStateStore.js'
import { buildHooksListingResponse } from './hostControlRequests.js'

const saved = process.env.CLAUDE_CODE_SAFE_MODE
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_SAFE_MODE
  else process.env.CLAUDE_CODE_SAFE_MODE = saved
})

test('safeMode is omitted outside safe mode like 2.1.311', () => {
  delete process.env.CLAUDE_CODE_SAFE_MODE
  expect(buildHooksListingResponse(getDefaultAppState(), [])).not.toHaveProperty('safeMode')
})

test('safe mode reports how to leave it', () => {
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  expect(buildHooksListingResponse(getDefaultAppState(), []).safeMode).toEqual({
    managedHooksStillApply: false,
    exitHint: 'unset CLAUDE_CODE_SAFE_MODE',
  })
})
