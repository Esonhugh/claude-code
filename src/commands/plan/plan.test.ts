import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import planCommand from './index.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { call } from './plan.js'

const permissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
} satisfies ToolPermissionContext

const originalSettings = getSessionSettingsCache()

beforeEach(() => {
  setSessionSettingsCache({ settings: { planModeAvailable: true }, errors: [] })
})

afterEach(() => {
  if (originalSettings) setSessionSettingsCache(originalSettings)
  else resetSettingsCache()
})

describe('/plan', () => {
  it('is hidden and refuses new entries without the opt-in', async () => {
    setSessionSettingsCache({ settings: {}, errors: [] })
    assert.equal((planCommand as { isEnabled?: () => boolean }).isEnabled?.(), false)
    let output = ''
    await call(
      result => { output = result ?? '' },
      {
        getAppState: () => ({ toolPermissionContext: permissionContext }),
        requestPermissionModeChange: () => { throw new Error('must not request a mode change') },
        setAppState: () => { throw new Error('must not change state') },
      } as unknown as LocalJSXCommandContext,
      '',
    )
    assert.match(output, /"planModeAvailable": true/)
    setSessionSettingsCache({ settings: { planModeAvailable: true }, errors: [] })
    assert.equal((planCommand as { isEnabled?: () => boolean }).isEnabled?.(), true)
  })

  it('waits for the shared permission mode transition before reporting success', async () => {
    let requestedMode = ''
    let output = ''

    await call(
      result => {
        output = result ?? ''
      },
      {
        getAppState: () => ({ toolPermissionContext: permissionContext }),
        setAppState: () => {
          throw new Error('must not commit local state directly')
        },
        requestPermissionModeChange: async mode => {
          requestedMode = mode
          return { success: true }
        },
      } as unknown as LocalJSXCommandContext,
      '',
    )

    assert.equal(requestedMode, 'plan')
    assert.equal(output, 'Enabled plan mode')
  })

  it('reports rejection without claiming plan mode was enabled', async () => {
    let output = ''

    await call(
      result => {
        output = result ?? ''
      },
      {
        getAppState: () => ({ toolPermissionContext: permissionContext }),
        setAppState: () => {
          throw new Error('must not commit rejected state')
        },
        requestPermissionModeChange: async () => ({
          success: false,
          error: 'remote rejected mode',
        }),
      } as unknown as LocalJSXCommandContext,
      '',
    )

    assert.equal(output, 'Plan mode was not enabled: remote rejected mode')
  })
})
