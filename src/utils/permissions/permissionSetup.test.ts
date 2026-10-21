import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'
import type { SettingsJson } from '../settings/types.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { initialPermissionModeFromCLI } = await import('./permissionSetup.js')
const {
  PERMISSION_MODE_CHOICES,
  permissionModeFromString,
  permissionModeShortTitle,
  permissionModeTitle,
} = await import('./PermissionMode.js')
const { SettingsSchema } = await import('../settings/types.js')

const originalSettings = getSessionSettingsCache()
const originalRemote = process.env.CLAUDE_CODE_REMOTE

function configure(settings: SettingsJson): void {
  setSessionSettingsCache({ settings, errors: [] })
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_REMOTE
})

afterEach(() => {
  if (originalRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
  else process.env.CLAUDE_CODE_REMOTE = originalRemote
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

test('manual is the public name of the default permission mode', () => {
  expect(permissionModeFromString('manual')).toBe('default')
  expect(permissionModeTitle('default')).toBe('Manual')
  expect(permissionModeShortTitle('default')).toBe('Manual')
  expect(PERMISSION_MODE_CHOICES).toContain('manual')
  expect(PERMISSION_MODE_CHOICES).not.toContain('default')
})

test('--permission-mode manual starts in the default mode', () => {
  configure({})
  expect(initialPermissionModeFromCLI({ permissionModeCli: 'manual', dangerouslySkipPermissions: false }).mode).toBe('default')
})

test('"defaultMode": "manual" is valid settings and resolves to the default mode', () => {
  const parsed = SettingsSchema().safeParse({ permissions: { defaultMode: 'manual' } })
  expect(parsed.success).toBe(true)
  configure({ permissions: { defaultMode: 'manual' } } as SettingsJson)
  expect(initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }).mode).toBe('default')
  configure({ permissions: { defaultMode: 'manual' } } as SettingsJson)
  expect(initialPermissionModeFromCLI({ permissionModeCli: 'acceptEdits', dangerouslySkipPermissions: false }).mode).toBe('acceptEdits')
})

function configureSources(sources: Partial<Record<'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings', SettingsJson>>): void {
  resetSettingsCache()
  let merged: SettingsJson = {}
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const) {
    const settings = sources[source] ?? null
    setCachedSettingsForSource(source, settings)
    if (settings?.permissions?.defaultMode) merged = { ...merged, permissions: { defaultMode: settings.permissions.defaultMode } }
  }
  setSessionSettingsCache({ settings: merged, errors: [] })
}

test('defaultMode bypassPermissions from project or local settings is ignored', () => {
  for (const source of ['projectSettings', 'localSettings'] as const) {
    configureSources({ [source]: { permissions: { defaultMode: 'bypassPermissions' } } })
    expect(initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }).mode).toBe('default')
  }
})

test('defaultMode bypassPermissions from user, flag or policy settings still applies', () => {
  for (const source of ['userSettings', 'flagSettings', 'policySettings'] as const) {
    configureSources({ [source]: { permissions: { defaultMode: 'bypassPermissions' } } })
    expect(initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }).mode).toBe('bypassPermissions')
  }
})

test('project defaultMode acceptEdits still applies', () => {
  configureSources({ projectSettings: { permissions: { defaultMode: 'acceptEdits' } } })
  expect(initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }).mode).toBe('acceptEdits')
})
