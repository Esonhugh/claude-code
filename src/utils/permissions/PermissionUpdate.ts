import { posix } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
// Types extracted to src/types/permissions.ts to break import cycles
import type {
  AdditionalWorkingDirectory,
  WorkingDirectorySource,
} from '../../types/permissions.js'
import { logForDebugging } from '../debug.js'
import {
  applySSHPermissionOverlayUpdate,
  isManagedSSHRemoteRuntime,
} from '../../ssh/managedSSHPermissions.js'
import type { EditableSettingSource } from '../settings/constants.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { jsonStringify } from '../slowOperations.js'
import { toPosixPath } from './filesystem.js'
import type { PermissionBehavior, PermissionRuleValue } from './PermissionRule.js'
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from './PermissionUpdateSchema.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'
import { addPermissionRulesToSettings } from './permissionsLoader.js'

// Re-export for backwards compatibility
export type { AdditionalWorkingDirectory, WorkingDirectorySource }

export function extractRules(
  updates: PermissionUpdate[] | undefined,
): PermissionRuleValue[] {
  if (!updates) return []

  return updates.flatMap(update => {
    switch (update.type) {
      case 'addRules':
        return update.rules
      default:
        return []
    }
  })
}

export function hasRules(updates: PermissionUpdate[] | undefined): boolean {
  return extractRules(updates).length > 0
}

/**
 * Applies a single permission update to the context and returns the updated context
 * @param context The current permission context
 * @param update The permission update to apply
 * @returns The updated permission context
 */
export type InternalPermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      destination: PermissionUpdateDestination | 'sshOverlay'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | (Omit<Extract<PermissionUpdate, { type: 'setMode' }>, 'destination'> & {
      destination: PermissionUpdateDestination | 'sshOverlay'
    })
  | {
      type: 'addDirectories' | 'removeDirectories'
      destination: PermissionUpdateDestination | 'sshOverlay'
      directories: string[]
    }

export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: InternalPermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'setMode':
      logForDebugging(
        `Applying permission update: Setting mode to '${update.mode}'`,
      )
      return {
        ...context,
        mode: update.mode,
      }

    case 'addRules': {
      const ruleStrings = update.rules.map(rule =>
        permissionRuleValueToString(rule),
      )
      logForDebugging(
        `Applying permission update: Adding ${update.rules.length} ${update.behavior} rule(s) to destination '${update.destination}': ${jsonStringify(ruleStrings)}`,
      )

      // Determine which collection to update based on behavior
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'

      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: [
            ...(context[ruleKind][update.destination] || []),
            ...ruleStrings,
          ],
        },
      }
    }

    case 'replaceRules': {
      const ruleStrings = update.rules.map(rule =>
        permissionRuleValueToString(rule),
      )
      logForDebugging(
        `Replacing all ${update.behavior} rules for destination '${update.destination}' with ${update.rules.length} rule(s): ${jsonStringify(ruleStrings)}`,
      )

      // Determine which collection to update based on behavior
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'

      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: ruleStrings, // Replace all rules for this source
        },
      }
    }

    case 'addDirectories': {
      logForDebugging(
        `Applying permission update: Adding ${update.directories.length} director${update.directories.length === 1 ? 'y' : 'ies'} with destination '${update.destination}': ${jsonStringify(update.directories)}`,
      )
      // @ts-ignore - recovered code
      const newAdditionalDirs = new Map(context.additionalWorkingDirectories)
      for (const directory of update.directories) {
        newAdditionalDirs.set(directory, {
          path: directory,
          source: update.destination,
        })
      }
      return {
        ...context,
        additionalWorkingDirectories: newAdditionalDirs,
      }
    }

    case 'removeRules': {
      const ruleStrings = update.rules.map(rule =>
        permissionRuleValueToString(rule),
      )
      logForDebugging(
        `Applying permission update: Removing ${update.rules.length} ${update.behavior} rule(s) from source '${update.destination}': ${jsonStringify(ruleStrings)}`,
      )

      // Determine which collection to update based on behavior
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'

      // Filter out the rules to be removed
      const existingRules = context[ruleKind][update.destination] || []
      const rulesToRemove = new Set(ruleStrings)
      const filteredRules = existingRules.filter(
        rule => !rulesToRemove.has(rule),
      )

      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: filteredRules,
        },
      }
    }

    case 'removeDirectories': {
      logForDebugging(
        `Applying permission update: Removing ${update.directories.length} director${update.directories.length === 1 ? 'y' : 'ies'}: ${jsonStringify(update.directories)}`,
      )
      // @ts-ignore - recovered code
      const newAdditionalDirs = new Map(context.additionalWorkingDirectories)
      for (const directory of update.directories) {
        newAdditionalDirs.delete(directory)
      }
      return {
        ...context,
        additionalWorkingDirectories: newAdditionalDirs,
      }
    }

    default:
      return context
  }
}

/**
 * Applies multiple permission updates to the context and returns the updated context
 * @param context The current permission context
 * @param updates The permission updates to apply
 * @returns The updated permission context
 */
export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  let updatedContext = context
  for (const update of updates) {
    updatedContext = applyPermissionUpdate(updatedContext, update)
  }

  return updatedContext
}

export function supportsPersistence(
  destination: PermissionUpdateDestination | 'sshOverlay',
): destination is EditableSettingSource | 'sshOverlay' {
  if (destination === 'sshOverlay') return true
  return (
    destination === 'localSettings' ||
    destination === 'userSettings' ||
    destination === 'projectSettings'
  )
}

/**
 * Persists a permission update to the appropriate settings source
 * @param update The permission update to persist
 */
export function persistPermissionUpdate(update: InternalPermissionUpdate): void {
  const updateToPersist =
    isManagedSSHRemoteRuntime() && update.destination !== 'session'
      ? { ...update, destination: 'sshOverlay' as const }
      : update
  if (!supportsPersistence(updateToPersist.destination)) return

  logForDebugging(
    `Persisting permission update: ${updateToPersist.type} to source '${updateToPersist.destination}'`,
  )

  if (updateToPersist.destination === 'sshOverlay') {
    applySSHPermissionOverlayUpdate(updateToPersist)
    return
  }

  const editableUpdate = updateToPersist as PermissionUpdate & {
    destination: EditableSettingSource
  }

  switch (editableUpdate.type) {
    case 'addRules': {
      logForDebugging(
        `Persisting ${editableUpdate.rules.length} ${editableUpdate.behavior} rule(s) to ${editableUpdate.destination}`,
      )
      addPermissionRulesToSettings(
        {
          ruleValues: editableUpdate.rules,
          ruleBehavior: editableUpdate.behavior,
        },
        editableUpdate.destination,
      )
      break
    }

    case 'addDirectories': {
      logForDebugging(
        `Persisting ${editableUpdate.directories.length} director${editableUpdate.directories.length === 1 ? 'y' : 'ies'} to ${editableUpdate.destination}`,
      )
      const existingSettings = getSettingsForSource(editableUpdate.destination)
      const existingDirs =
        existingSettings?.permissions?.additionalDirectories || []

      // Add new directories, avoiding duplicates
      const dirsToAdd = editableUpdate.directories.filter(
        dir => !existingDirs.includes(dir),
      )

      if (dirsToAdd.length > 0) {
        const updatedDirs = [...existingDirs, ...dirsToAdd]
        updateSettingsForSource(editableUpdate.destination, {
          permissions: {
            additionalDirectories: updatedDirs,
          },
        })
      }
      break
    }

    case 'removeRules': {
      // Handle rule removal
      logForDebugging(
        `Removing ${editableUpdate.rules.length} ${editableUpdate.behavior} rule(s) from ${editableUpdate.destination}`,
      )
      const existingSettings = getSettingsForSource(editableUpdate.destination)
      const existingPermissions = existingSettings?.permissions || {}
      const existingRules = existingPermissions[editableUpdate.behavior] || []

      // Convert rules to normalized strings for comparison
      // Normalize via parse→serialize roundtrip so "Bash(*)" and "Bash" match
      const rulesToRemove = new Set(
        editableUpdate.rules.map(permissionRuleValueToString),
      )
      const filteredRules = existingRules.filter(rule => {
        const normalized = permissionRuleValueToString(
          permissionRuleValueFromString(rule),
        )
        return !rulesToRemove.has(normalized)
      })

      updateSettingsForSource(editableUpdate.destination, {
        permissions: {
          [editableUpdate.behavior]: filteredRules,
        },
      })
      break
    }

    case 'removeDirectories': {
      logForDebugging(
        `Removing ${editableUpdate.directories.length} director${editableUpdate.directories.length === 1 ? 'y' : 'ies'} from ${editableUpdate.destination}`,
      )
      const existingSettings = getSettingsForSource(editableUpdate.destination)
      const existingDirs =
        existingSettings?.permissions?.additionalDirectories || []

      // Remove specified directories
      const dirsToRemove = new Set(editableUpdate.directories)
      const filteredDirs = existingDirs.filter(dir => !dirsToRemove.has(dir))

      updateSettingsForSource(editableUpdate.destination, {
        permissions: {
          additionalDirectories: filteredDirs,
        },
      })
      break
    }

    case 'setMode': {
      logForDebugging(
        `Persisting mode '${editableUpdate.mode}' to ${editableUpdate.destination}`,
      )
      updateSettingsForSource(editableUpdate.destination, {
        permissions: {
          defaultMode: editableUpdate.mode,
        },
      })
      break
    }

    case 'replaceRules': {
      logForDebugging(
        `Replacing all ${editableUpdate.behavior} rules in ${editableUpdate.destination} with ${editableUpdate.rules.length} rule(s)`,
      )
      const ruleStrings = editableUpdate.rules.map(permissionRuleValueToString)
      updateSettingsForSource(editableUpdate.destination, {
        permissions: {
          [editableUpdate.behavior]: ruleStrings,
        },
      })
      break
    }
  }
}

/**
 * Persists multiple permission updates to the appropriate settings sources
 * Only persists updates with persistable sources
 * @param updates The permission updates to persist
 */
export function persistPermissionUpdates(updates: PermissionUpdate[]): void {
  for (const update of updates) {
    persistPermissionUpdate(update)
  }
}

/**
 * Creates a Read rule suggestion for a directory.
 * @param dirPath The directory path to create a rule for
 * @param destination The destination for the permission rule (defaults to 'session')
 * @returns A PermissionUpdate for a Read rule, or undefined for the root directory
 */
export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  // Convert to POSIX format for pattern matching (handles Windows internally)
  const pathForPattern = toPosixPath(dirPath)

  // Root directory is too broad to be a reasonable permission target
  if (pathForPattern === '/') {
    return undefined
  }

  // For absolute paths, prepend an extra / to create //path/** pattern
  const ruleContent = posix.isAbsolute(pathForPattern)
    ? `/${pathForPattern}/**`
    : `${pathForPattern}/**`

  return {
    type: 'addRules',
    rules: [
      {
        toolName: 'Read',
        ruleContent,
      },
    ],
    behavior: 'allow',
    destination,
  }
}
