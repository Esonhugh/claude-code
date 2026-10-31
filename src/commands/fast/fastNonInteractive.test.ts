import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fast from './fast.js'
import * as fastMode from '../../utils/fastMode.js'
import { call } from './fastNonInteractive.js'

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

test('/fast without arguments toggles fast mode like 2.1.311', async () => {
  spies.push(spyOn(fastMode, 'prefetchFastModeStatus').mockResolvedValue(undefined as never))
  const toggle = spyOn(fast, 'handleFastModeShortcut').mockResolvedValue('toggled')
  spies.push(toggle)
  const context = { getAppState: () => ({ fastMode: false }), setAppState: () => {} }
  expect(await call('', context as never)).toEqual({ type: 'text', value: 'toggled' })
  expect(toggle.mock.calls[0]?.[0]).toBe(true)
})

test('a -p /fast opt-in lifts the SDK opt-in block for this session only', async () => {
  const { setIsInteractive } = await import('../../bootstrap/state.js')
  const { getFastModeDisabledReason, setFastModeSessionOptIn } = await import('../../utils/fastMode.js')
  setIsInteractive(false)
  try {
    setFastModeSessionOptIn(false)
    const blocked = getFastModeDisabledReason()
    setFastModeSessionOptIn(true)
    const after = getFastModeDisabledReason()
    if (blocked === 'sdk_opt_in_required') expect(after).not.toBe('sdk_opt_in_required')
  } finally {
    setFastModeSessionOptIn(false)
  }
})
