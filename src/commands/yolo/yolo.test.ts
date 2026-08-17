import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import type { LocalJSXCommandContext } from '../../commands.js'
import { call } from './yolo.js'

describe('/yolo', () => {
  it('reports success only after the permission mode change is confirmed', async () => {
    let requestedMode = ''
    let output = ''

    await call(
      result => {
        output = result ?? ''
      },
      {
        requestPermissionModeChange: async mode => {
          requestedMode = mode
          return { success: true }
        },
      } as unknown as LocalJSXCommandContext,
    )

    assert.equal(requestedMode, 'bypassPermissions')
    assert.equal(output, 'Bypass permissions mode enabled')
  })

  it('reports rejection instead of claiming that bypass was enabled', async () => {
    let output = ''

    await call(
      result => {
        output = result ?? ''
      },
      {
        requestPermissionModeChange: async () => ({
          success: false,
          error: 'permission opt-in is required',
        }),
      } as unknown as LocalJSXCommandContext,
    )

    assert.equal(
      output,
      'Bypass permissions mode was not enabled: permission opt-in is required',
    )
  })
})
