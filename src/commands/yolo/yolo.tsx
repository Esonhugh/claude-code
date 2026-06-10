import * as React from 'react'
import { setSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const { setAppState } = context

  setSessionBypassPermissionsMode(true)
  setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    }),
  }))

  onDone('⚡ Bypass permissions mode enabled')
  return null
}
