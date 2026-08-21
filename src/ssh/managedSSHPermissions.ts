import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolPermissionContext } from '../Tool.js'
import type { SettingsJson } from '../utils/settings/types.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../utils/permissions/PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../utils/permissions/permissionRuleParser.js'
import type { AdditionalWorkingDirectory } from '../types/permissions.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { readFileSync } from '../utils/fileRead.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { logForDebugging } from '../utils/debug.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'

const SSH_PERMISSION_OVERLAY_FILE = 'ssh-permissions.json'
const SSH_PERMISSION_BOOTSTRAP_ENV = 'CLAUDE_CODE_SSH_PERMISSION_BOOTSTRAP'

const BEHAVIORS = ['allow', 'deny', 'ask'] as const satisfies readonly PermissionBehavior[]

export type SSHPermissionOverlay = {
  permissions?: Pick<
    NonNullable<SettingsJson['permissions']>,
    'allow' | 'deny' | 'ask' | 'additionalDirectories'
  >
}

export type SSHPermissionOverlayUpdate =
  | { type: 'addRules' | 'removeRules' | 'replaceRules'; behavior: PermissionBehavior; rules: PermissionRuleValue[] }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[] }
  | { type: 'setMode' }

export function isManagedSSHRemoteRuntime(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' &&
    env.CLAUDE_CODE_SSH_REMOTE === '1' &&
    !!env.CLAUDE_CODE_SSH_REMOTE_TOKEN
  )
}

export function getSSHPermissionOverlayPath(): string {
  return join(getClaudeConfigHomeDir(), SSH_PERMISSION_OVERLAY_FILE)
}

export function encodeSSHPermissionBootstrap(settings: SSHPermissionOverlay): string {
  return Buffer.from(jsonStringify(settings), 'utf8').toString('base64')
}

function decodeSSHPermissionBootstrap(value: string | undefined): SSHPermissionOverlay {
  if (!value) return {}
  try {
    const parsed = safeParseJSON(Buffer.from(value, 'base64').toString('utf8'), false)
    return normalizeOverlay(parsed as SSHPermissionOverlay)
  } catch (error) {
    logForDebugging(
      `[SSH permissions] failed to decode permission bootstrap: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return {}
  }
}

export function extractEditablePermissionOverlay(
  settingsList: Array<SettingsJson | null | undefined>,
): SSHPermissionOverlay {
  const overlays = settingsList.map(settings => ({
    permissions: settings?.permissions,
  })) as SSHPermissionOverlay[]
  return mergePermissionOverlays(overlays)
}

export function loadSSHPermissionOverlay(): SSHPermissionOverlay {
  try {
    const content = readFileSync(getSSHPermissionOverlayPath())
    if (!content.trim()) return {}
    const parsed = safeParseJSON(content, false)
    return normalizeOverlay(parsed as SSHPermissionOverlay)
  } catch {
    return {}
  }
}

export function saveSSHPermissionOverlay(overlay: SSHPermissionOverlay): void {
  const normalized = normalizeOverlay(overlay)
  const path = getSSHPermissionOverlayPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${jsonStringify(normalized, null, 2)}\n`, 'utf8')
  resetSettingsCache()
}

export function ensureSSHPermissionOverlay(settingsList: SettingsJson[]): SSHPermissionOverlay {
  const remoteEditable = extractEditablePermissionOverlay(settingsList)
  const localEditable = decodeSSHPermissionBootstrap(
    process.env[SSH_PERMISSION_BOOTSTRAP_ENV],
  )
  const existing = loadSSHPermissionOverlay()
  const merged = mergePermissionOverlays([existing, remoteEditable, localEditable])
  saveSSHPermissionOverlay(merged)
  return merged
}

export function mergePermissionOverlays(
  overlays: Array<SSHPermissionOverlay | null | undefined>,
): SSHPermissionOverlay {
  const result: SSHPermissionOverlay = { permissions: {} }
  for (const overlay of overlays) {
    const permissions = overlay?.permissions
    if (!permissions) continue
    for (const behavior of BEHAVIORS) {
      result.permissions![behavior] = canonicalDedupeRules([
        ...(result.permissions![behavior] ?? []),
        ...(permissions[behavior] ?? []),
      ])
    }
    result.permissions!.additionalDirectories = canonicalDedupeStrings([
      ...(result.permissions!.additionalDirectories ?? []),
      ...(permissions.additionalDirectories ?? []),
    ])
  }
  return normalizeOverlay(result)
}

function normalizeOverlay(value: SSHPermissionOverlay | null | undefined): SSHPermissionOverlay {
  const permissions = value?.permissions
  const result: SSHPermissionOverlay = { permissions: {} }
  if (!permissions) return result
  for (const behavior of BEHAVIORS) {
    result.permissions![behavior] = canonicalDedupeRules(permissions[behavior] ?? [])
  }
  result.permissions!.additionalDirectories = canonicalDedupeStrings(
    permissions.additionalDirectories ?? [],
  )
  return result
}

function canonicalDedupeRules(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const canonical = permissionRuleValueToString(permissionRuleValueFromString(value))
    if (seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return result
}

function canonicalDedupeStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function overlayToPermissionRules(overlay: SSHPermissionOverlay): PermissionRule[] {
  const permissions = overlay.permissions
  if (!permissions) return []
  const rules: PermissionRule[] = []
  for (const behavior of BEHAVIORS) {
    for (const ruleString of permissions[behavior] ?? []) {
      rules.push({
        source: 'sshOverlay',
        ruleBehavior: behavior,
        ruleValue: permissionRuleValueFromString(ruleString),
      })
    }
  }
  return rules
}

export function overlayDirectories(
  overlay: SSHPermissionOverlay,
): AdditionalWorkingDirectory[] {
  return (overlay.permissions?.additionalDirectories ?? []).map(path => ({
    path,
    source: 'sshOverlay',
  }))
}

export function applySSHPermissionOverlayUpdate(
  update: SSHPermissionOverlayUpdate,
): SSHPermissionOverlay {
  const overlay = loadSSHPermissionOverlay()
  const permissions = (overlay.permissions ??= {})
  switch (update.type) {
    case 'addRules': {
      permissions[update.behavior] = canonicalDedupeRules([
        ...(permissions[update.behavior] ?? []),
        ...update.rules.map(permissionRuleValueToString),
      ])
      break
    }
    case 'replaceRules': {
      permissions[update.behavior] = canonicalDedupeRules(
        update.rules.map(permissionRuleValueToString),
      )
      break
    }
    case 'removeRules': {
      const remove = new Set(update.rules.map(permissionRuleValueToString))
      permissions[update.behavior] = (permissions[update.behavior] ?? []).filter(
        rule => !remove.has(permissionRuleValueToString(permissionRuleValueFromString(rule))),
      )
      break
    }
    case 'addDirectories': {
      permissions.additionalDirectories = canonicalDedupeStrings([
        ...(permissions.additionalDirectories ?? []),
        ...update.directories,
      ])
      break
    }
    case 'removeDirectories': {
      const remove = new Set(update.directories)
      permissions.additionalDirectories = (permissions.additionalDirectories ?? []).filter(
        directory => !remove.has(directory),
      )
      break
    }
    case 'setMode': {
      break
    }
  }
  saveSSHPermissionOverlay(overlay)
  return overlay
}

export function readSSHPermissionRuntimeState(context: ToolPermissionContext): {
  overlay: SSHPermissionOverlay
  rules: PermissionRule[]
  additionalDirectories: AdditionalWorkingDirectory[]
} {
  const overlay = loadSSHPermissionOverlay()
  const overlayDirSet = new Set(overlay.permissions?.additionalDirectories ?? [])
  const additionalDirectories = Array.from(
    context.additionalWorkingDirectories as unknown as ReadonlyMap<string, AdditionalWorkingDirectory>,
  )
    .map(([, directory]) => directory)
    .filter(
      directory =>
        directory.source === 'policySettings' ||
        directory.source === 'sshOverlay' ||
        overlayDirSet.has(directory.path),
    )
  return {
    overlay,
    rules: overlayToPermissionRules(overlay),
    additionalDirectories,
  }
}
