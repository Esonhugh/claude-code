import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { BypassPermissionsModeDialog } from '../../components/BypassPermissionsModeDialog.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { isBypassPermissionsModeDisabled } from '../../utils/permissions/permissionSetup.js'
import { hasSkipDangerousModePermissionPrompt } from '../../utils/settings/settings.js'

function setBypassAvailable(
  context: LocalJSXCommandContext,
  available: boolean,
): void {
  context.setAppState(prev =>
    prev.toolPermissionContext.isBypassPermissionsModeAvailable === available
      ? prev
      : {
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            isBypassPermissionsModeAvailable: available,
          },
        },
  )
}

async function enableBypass(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<void> {
  const wasAvailable =
    context.getAppState().toolPermissionContext.isBypassPermissionsModeAvailable
  // Accepting the bypass dialog is what makes the mode available, like
  // launching with --allow-dangerously-skip-permissions.
  setBypassAvailable(context, true)
  const result = context.requestPermissionModeChange
    ? await context.requestPermissionModeChange('bypassPermissions')
    : {
        success: false as const,
        error: 'Permission mode changes are unavailable in this session',
      }
  const enabled =
    result.success === true &&
    context.getAppState().toolPermissionContext.mode === 'bypassPermissions'
  if (!enabled && !wasAvailable) {
    setBypassAvailable(context, false)
  }

  onDone(
    enabled
      ? 'Bypass permissions mode enabled'
      : `Bypass permissions mode was not enabled: ${
          result.success === true
            ? 'the permission mode did not change'
            : result.error
        }`,
    { display: 'system' },
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  if (isBypassPermissionsModeDisabled()) {
    onDone(
      'Bypass permissions mode was not enabled: it is disabled by settings or configuration',
      { display: 'system' },
    )
    return null
  }

  if (hasSkipDangerousModePermissionPrompt()) {
    await enableBypass(onDone, context)
    return null
  }

  return (
    <BypassPermissionsModeDialog
      onAccept={() => void enableBypass(onDone, context)}
      onDecline={() =>
        onDone('Bypass permissions mode was not enabled', {
          display: 'system',
        })
      }
    />
  )
}
