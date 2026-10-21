import { afterEach, expect, test } from 'bun:test'
import {
  getSessionSettingsCache,
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

function configure(settings: SettingsJson): void {
  setSessionSettingsCache({ settings, errors: [] })
}

afterEach(() => {
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

test('a team lead mode_set_request goes through the same gates as SDK set_permission_mode', async () => {
  const { transitionPermissionModeWithGates } = await import('./permissionSetup.js')
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const base = getEmptyToolPermissionContext()
  configure({})
  expect(transitionPermissionModeWithGates(base, 'acceptEdits').mode).toBe('acceptEdits')
  expect(() => transitionPermissionModeWithGates(base, 'bypassPermissions')).toThrow(/not available/)
  expect(transitionPermissionModeWithGates({ ...base, isBypassPermissionsModeAvailable: true }, 'bypassPermissions').mode)
    .toBe('bypassPermissions')
  configure({ permissions: { disableBypassPermissionsMode: 'disable' } })
  expect(() => transitionPermissionModeWithGates({ ...base, isBypassPermissionsModeAvailable: true }, 'bypassPermissions'))
    .toThrow(/disabled/)
  configure({ permissions: { disableAutoMode: 'disable' } })
  expect(() => transitionPermissionModeWithGates(base, 'auto')).toThrow(/auto mode is unavailable/)
  configure({ planModeAvailable: false })
  expect(() => transitionPermissionModeWithGates(base, 'plan')).toThrow(/Plan mode is disabled/)
})
