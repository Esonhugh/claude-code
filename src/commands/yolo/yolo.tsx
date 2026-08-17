import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const result = context.requestPermissionModeChange
    ? await context.requestPermissionModeChange('bypassPermissions')
    : {
        success: false as const,
        error: 'Permission mode changes are unavailable in this session',
      }

  onDone(
    result.success === true
      ? 'Bypass permissions mode enabled'
      : `Bypass permissions mode was not enabled: ${result.error}`,
    { display: 'system' },
  )
  return null
}
