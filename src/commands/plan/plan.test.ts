import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
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

describe('/plan', () => {
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
