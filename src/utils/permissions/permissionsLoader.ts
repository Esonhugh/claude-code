import { spawnSync } from 'child_process'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getGlobalConfig, getProjectPathForConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import {
  isManagedSSHRemoteRuntime,
  loadSSHPermissionOverlay,
  overlayToPermissionRules,
} from '../../ssh/managedSSHPermissions.js'
import { isSourceAdminTrusted } from '../settings/pluginOnlyPolicy.js'
import type { SettingsJson } from '../settings/types.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from '../plugins/pluginIdentifier.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/**
 * Returns true if allowManagedPermissionRulesOnly is enabled in managed settings (policySettings).
 * When enabled, only permission rules from managed settings are respected.
 */
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedPermissionRulesOnly ===
    true
  )
}

const withheldAllowedToolsWarned = new Set<string>()

/**
 * The allowed-tools a skill or command may pre-approve. Under
 * allowManagedPermissionRulesOnly only managed, built-in and bundled ones and
 * plugins from an official marketplace keep them (official 2.1.282); the rest
 * run their tool calls and inline shell through the session's rules.
 */
export function getCommandAllowedTools(command: {
  name?: string
  source: string
  allowedTools?: string[]
  pluginInfo?: { repository: string }
}): string[] {
  const allowedTools = command.allowedTools ?? []
  if (allowedTools.length === 0 || !shouldAllowManagedPermissionRulesOnly()) {
    return allowedTools
  }
  const trusted =
    command.source === 'plugin'
      ? command.pluginInfo !== undefined &&
        isOfficialMarketplaceName(
          parsePluginIdentifier(command.pluginInfo.repository).marketplace,
        )
      : isSourceAdminTrusted(command.source)
  if (trusted) return allowedTools
  const origin = `/${command.name ?? 'unknown'} (${command.pluginInfo?.repository ?? command.source})`
  if (!withheldAllowedToolsWarned.has(origin)) {
    withheldAllowedToolsWarned.add(origin)
    logForDebugging(
      `Ignoring allowed-tools ${allowedTools.join(', ')} from ${origin}: permission rules are restricted to managed settings (allowManagedPermissionRulesOnly).`,
      { level: 'warn' },
    )
  }
  return []
}

/**
 * Returns true if "always allow" options should be shown in permission prompts.
 * When allowManagedPermissionRulesOnly is enabled, these options are hidden.
 */
export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

const SUPPORTED_RULE_BEHAVIORS = [
  'allow',
  'deny',
  'ask',
] as const satisfies PermissionBehavior[]

/**
 * Lenient version of getSettingsForSource that doesn't fail on ANY validation errors.
 * Simply parses the JSON and returns it as-is without schema validation.
 *
 * Used when loading settings to append new rules (avoids losing existing rules
 * due to validation failures in unrelated fields like hooks).
 *
 * FOR EDITING ONLY - do not use this for reading settings for execution.
 */
function getSettingsForSourceLenient_FOR_EDITING_ONLY_NOT_FOR_READING(
  source: SettingSource,
): SettingsJson | null {
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return null
  }

  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
    const content = readFileSync(resolvedPath)
    if (content.trim() === '') {
      return {}
    }

    const data = safeParseJSON(content, false)
    // Return raw parsed JSON without validation to preserve all existing settings
    // This is safe because we're only using this for reading/appending, not for execution
    return data && typeof data === 'object' ? (data as SettingsJson) : null
  } catch {
    return null
  }
}

/**
 * Converts permissions JSON to an array of PermissionRule objects
 * @param data The parsed permissions data
 * @param source The source of these rules
 * @returns Array of PermissionRule objects
 */
function settingsJsonToRules(
  data: SettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!data || !data.permissions) {
    return []
  }

  const { permissions } = data
  const rules: PermissionRule[] = []
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior]
    if (behaviorArray) {
      for (const ruleString of behaviorArray) {
        rules.push({
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        })
      }
    }
  }
  return rules
}

/**
 * Loads all permission rules from all relevant sources (managed and project settings)
 * @returns Array of all permission rules
 */
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  const sshOverlayRules = isManagedSSHRemoteRuntime()
    ? overlayToPermissionRules(loadSSHPermissionOverlay())
    : []

  // If allowManagedPermissionRulesOnly is set, only use managed permission rules.
  if (shouldAllowManagedPermissionRulesOnly()) {
    return [...getPermissionRulesForSource('policySettings'), ...sshOverlayRules]
  }

  // Managed SSH remotes intentionally run with policy plus the remote-owned
  // overlay only. User/project/local settings are merged into that overlay at
  // startup and edits rewrite the overlay instead of local settings.
  if (isManagedSSHRemoteRuntime()) {
    return [...getPermissionRulesForSource('policySettings'), ...sshOverlayRules]
  }

  // Otherwise, load from all enabled sources (backwards compatible)
  const rules: PermissionRule[] = []

  for (const source of getEnabledSettingSources()) {
    rules.push(...getPermissionRulesForSource(source))
  }

  // Like official 2.1.303, a git-tracked .claude/settings.local.json is repo
  // content: its allow rules apply only once this workspace is explicitly
  // trusted. Its deny and ask rules still apply.
  const localAllow = rules.filter(
    rule => rule.source === 'localSettings' && rule.ruleBehavior === 'allow',
  )
  if (
    localAllow.length > 0 &&
    getGlobalConfig().projects?.[getProjectPathForConfig()]
      ?.hasTrustDialogAccepted !== true &&
    isLocalSettingsGitTracked(getOriginalCwd())
  ) {
    logForDebugging(
      `Ignoring ${localAllow.length} permissions.allow rule(s) from .claude/settings.local.json: the file is tracked by git and this workspace is not explicitly trusted.`,
      { level: 'warn' },
    )
    return rules.filter(rule => !localAllow.includes(rule))
  }
  return rules
}

const localSettingsGitTracked = new Map<string, boolean>()

function isLocalSettingsGitTracked(cwd: string): boolean {
  const cached = localSettingsGitTracked.get(cwd)
  if (cached !== undefined) return cached
  const result = spawnSync(
    'git',
    [
      '-C',
      cwd,
      'ls-files',
      '--error-unmatch',
      '--',
      ':(icase).claude/settings.local.json',
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: 'C',
        GIT_TRACE2: '0',
        GIT_TRACE2_PERF: '0',
        GIT_TRACE2_EVENT: '0',
      },
    },
  )
  // Exit 0: tracked. Exit 1, outside a repository, or no git: untracked.
  // Any other failure counts as tracked.
  const notARepo =
    result.status === 128 &&
    /^fatal: not a git repository/.test(result.stderr ?? '')
  const tracked = result.error
    ? (result.error as NodeJS.ErrnoException).code !== 'ENOENT'
    : result.status !== 1 && !notARepo
  localSettingsGitTracked.set(cwd, tracked)
  return tracked
}

/**
 * Loads permission rules from a specific source
 * @param source The source to load from
 * @returns Array of permission rules from that source
 */
export function getPermissionRulesForSource(
  source: SettingSource,
): PermissionRule[] {
  const settingsData = getSettingsForSource(source)
  return settingsJsonToRules(settingsData, source)
}

export type PermissionRuleFromEditableSettings = PermissionRule & {
  source: EditableSettingSource
}

// Editable sources that can be modified (excludes policySettings and flagSettings)
const EDITABLE_SOURCES: EditableSettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
]

/**
 * Deletes a rule from the project permissions file
 * @param rule The rule to delete
 * @returns Promise resolving to a boolean indicating success
 */
export function deletePermissionRuleFromSettings(
  rule: PermissionRuleFromEditableSettings,
): boolean {
  // Runtime check to ensure source is actually editable
  if (!EDITABLE_SOURCES.includes(rule.source as EditableSettingSource)) {
    return false
  }

  const ruleString = permissionRuleValueToString(rule.ruleValue)
  const settingsData = getSettingsForSource(rule.source)

  // If there's no settings data or permissions, nothing to do
  if (!settingsData || !settingsData.permissions) {
    return false
  }

  const behaviorArray = settingsData.permissions[rule.ruleBehavior]
  if (!behaviorArray) {
    return false
  }

  // Normalize raw settings entries via roundtrip parse→serialize so legacy
  // names (e.g. "KillShell") match their canonical form ("TaskStop").
  const normalizeEntry = (raw: string): string =>
    permissionRuleValueToString(permissionRuleValueFromString(raw))

  if (!behaviorArray.some(raw => normalizeEntry(raw) === ruleString)) {
    return false
  }

  try {
    // Keep a copy of the original permissions data to preserve unrecognized keys
    const updatedSettingsData = {
      ...settingsData,
      permissions: {
        ...settingsData.permissions,
        [rule.ruleBehavior]: behaviorArray.filter(
          raw => normalizeEntry(raw) !== ruleString,
        ),
      },
    }

    const { error } = updateSettingsForSource(rule.source, updatedSettingsData)
    if (error) {
      // Error already logged inside updateSettingsForSource
      return false
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

function getEmptyPermissionSettingsJson(): SettingsJson {
  return {
    permissions: {},
  }
}

/**
 * Adds rules to the project permissions file
 * @param ruleValues The rule values to add
 * @returns Promise resolving to a boolean indicating success
 */
export function addPermissionRulesToSettings(
  {
    ruleValues,
    ruleBehavior,
  }: {
    ruleValues: PermissionRuleValue[]
    ruleBehavior: PermissionBehavior
  },
  source: EditableSettingSource,
): boolean {
  // When allowManagedPermissionRulesOnly is enabled, don't persist new permission rules
  if (shouldAllowManagedPermissionRulesOnly()) {
    return false
  }

  if (ruleValues.length < 1) {
    // No rules to add
    return true
  }

  const ruleStrings = ruleValues.map(permissionRuleValueToString)
  // First try the normal settings loader which validates the schema
  // If validation fails, fall back to lenient loading to preserve existing rules
  // even if some fields (like hooks) have validation errors
  const settingsData =
    getSettingsForSource(source) ||
    getSettingsForSourceLenient_FOR_EDITING_ONLY_NOT_FOR_READING(source) ||
    getEmptyPermissionSettingsJson()

  try {
    // Ensure permissions object exists
    const existingPermissions = settingsData.permissions || {}
    const existingRules = existingPermissions[ruleBehavior] || []

    // Filter out duplicates - normalize existing entries via roundtrip
    // parse→serialize so legacy names match their canonical form.
    const existingRulesSet = new Set(
      existingRules.map(raw =>
        permissionRuleValueToString(permissionRuleValueFromString(raw)),
      ),
    )
    const newRules = ruleStrings.filter(rule => !existingRulesSet.has(rule))

    // If no new rules to add, return success
    if (newRules.length === 0) {
      return true
    }

    // Keep a copy of the original settings data to preserve unrecognized keys
    const updatedSettingsData = {
      ...settingsData,
      permissions: {
        ...existingPermissions,
        [ruleBehavior]: [...existingRules, ...newRules],
      },
    }
    const result = updateSettingsForSource(source, updatedSettingsData)

    if (result.error) {
      throw result.error
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}
