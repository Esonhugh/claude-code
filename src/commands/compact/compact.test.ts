import { afterEach, beforeEach, expect, test } from 'bun:test'
import { clearRegisteredHooks, registerHookCallbacks, setIsInteractive } from '../../bootstrap/state.js'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES } from '../../services/compact/compact.js'
import { resetHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { createUserMessage } from '../../utils/messages.js'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { call } from './compact.js'

const context = (messages: unknown[]) => ({ messages, abortController: new AbortController() }) as never

// Non-interactive, so hooks run without the workspace trust dialog.
beforeEach(() => {
  setIsInteractive(false)
  clearRegisteredHooks()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  setSessionSettingsCache({ settings: {}, errors: [] })
})
afterEach(() => {
  setIsInteractive(true)
  clearRegisteredHooks()
  resetHooksConfigSnapshot()
  resetSettingsCache()
})

test('/compact with nothing the model answered refuses like 2.1.311', async () => {
  const onlyCommand = [createUserMessage({ content: '<command-name>/clear</command-name>' })]
  await expect(call('', context(onlyCommand))).rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
})

test('/compact with nothing the model answered still runs PreCompact first (official 2.1.329)', async () => {
  const inputs: unknown[] = []
  registerHookCallbacks({
    PreCompact: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async input => {
              inputs.push(input)
              return {}
            },
          },
        ],
      },
    ],
  })
  const statuses: unknown[][] = []
  const onlyCommand = [createUserMessage({ content: '<command-name>/cost</command-name>' })]
  await expect(
    call('keep it short', {
      messages: onlyCommand,
      abortController: new AbortController(),
      setSDKStatus: (...status: unknown[]) => statuses.push(status),
    } as never),
  ).rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  expect(inputs).toMatchObject([
    { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'keep it short' },
  ])
  expect(statuses).toEqual([
    ['compacting'],
    [null, { compact_result: 'failed', compact_error: ERROR_MESSAGE_NOT_ENOUGH_MESSAGES }],
  ])
})

test('/compact on an empty conversation reports nothing', async () => {
  expect(await call('', context([]))).toEqual({ type: 'text', value: '' })
})
