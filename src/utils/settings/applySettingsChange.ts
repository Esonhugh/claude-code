import { feature } from 'bun:bundle'
import type { AppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import {
  createDisabledBypassPermissionsContext,
  findOverlyBroadBashPermissions,
  isBypassPermissionsModeDisabled,
  removeDangerousPermissions,
  transitionPlanAutoMode,
  verifyAutoModeGateAccess,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'
import { isAnt } from 'src/utils/userType.js'


/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed-settings
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  let syncedState: Pick<AppState, 'toolPermissionContext' | 'fastMode'> | undefined
  setAppState(prev => {
    let newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    // Ant-only: re-strip overly broad Bash allow rules after settings sync
    if (
      isAnt() &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
    ) {
      const overlyBroad = findOverlyBroadBashPermissions(updatedRules, [])
      if (overlyBroad.length > 0) {
        newContext = removeDangerousPermissions(newContext, overlyBroad)
      }
    }

    if (
      newContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      newContext = createDisabledBypassPermissionsContext(newContext)
    }

    newContext = transitionPlanAutoMode(newContext)

    // Sync effortLevel from settings to top-level AppState when it changes
    // (e.g. via applyFlagSettings from IDE). Only propagate if the setting
    // itself changed — otherwise unrelated settings churn (e.g. tips dismissal
    // on startup) would clobber a --effort CLI flag value held in AppState.
    const prevEffort = prev.settings.effortLevel
    const newEffort = newSettings.effortLevel
    const effortChanged = prevEffort !== newEffort

    syncedState = { toolPermissionContext: newContext, fastMode: prev.fastMode }
    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext: newContext,
      // Only propagate a defined new value — when the disk key is absent
      // (e.g. /effort max for non-ants writes undefined; --effort CLI flag),
      // prev.settings.effortLevel can be stale (internal writes suppress the
      // watcher that would resync AppState.settings), so effortChanged would
      // be true and we'd wipe a session-scoped value held in effortValue.
      ...(effortChanged && newEffort !== undefined
        ? { effortValue: newEffort }
        : {}),
    }
  })

  // Like official 2.1.251 and 2.1.295, re-check auto mode against the new
  // settings: disableAutoMode added mid-session leaves auto, and removing it
  // offers auto again without a restart.
  if (feature('TRANSCRIPT_CLASSIFIER') && syncedState) {
    void recheckAutoModeGate(
      syncedState.toolPermissionContext,
      syncedState.fastMode,
      setAppState,
    )
  }
}

/** Applies a fresh auto mode gate check to the current state. */
export async function recheckAutoModeGate(
  context: ToolPermissionContext,
  fastMode: boolean | undefined,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<void> {
  const { updateContext, notification } = await verifyAutoModeGateAccess(
    context,
    fastMode,
  )
  setAppState(prev => {
    const nextContext = updateContext(prev.toolPermissionContext)
    const next =
      nextContext === prev.toolPermissionContext
        ? prev
        : { ...prev, toolPermissionContext: nextContext }
    if (!notification) return next
    return {
      ...next,
      notifications: {
        ...next.notifications,
        queue: [
          ...next.notifications.queue,
          {
            key: 'auto-mode-gate-notification',
            text: notification,
            color: 'warning' as const,
            priority: 'high' as const,
          },
        ],
      },
    }
  })
}
