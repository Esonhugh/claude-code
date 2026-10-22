import { afterEach, expect, test } from 'bun:test'
import {
  getSessionSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'
import type { SettingsJson } from '../settings/types.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { restorePermissionModeForResume } = await import('./permissionSetup.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { setPermissionModeSetByCli } = await import('../../bootstrap/state.js')

const originalSettings = getSessionSettingsCache()

function configure(settings: SettingsJson): void {
  setSessionSettingsCache({ settings, errors: [] })
}

afterEach(() => {
  setPermissionModeSetByCli(false)
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

test('a resumed session gets back the mode its transcript last recorded', () => {
  configure({})
  const base = getEmptyToolPermissionContext()
  expect(restorePermissionModeForResume(base, 'acceptEdits').mode).toBe(
    'acceptEdits',
  )
  expect(restorePermissionModeForResume(base, 'default')).toBe(base)
  expect(restorePermissionModeForResume(base, undefined)).toBe(base)
})

test('bypassPermissions is only restored when this launch made it available', () => {
  configure({})
  const base = getEmptyToolPermissionContext()
  expect(restorePermissionModeForResume(base, 'bypassPermissions').mode).toBe(
    'default',
  )
  expect(
    restorePermissionModeForResume(
      { ...base, isBypassPermissionsModeAvailable: true },
      'bypassPermissions',
    ).mode,
  ).toBe('bypassPermissions')
  configure({ permissions: { disableBypassPermissionsMode: 'disable' } })
  expect(
    restorePermissionModeForResume(
      { ...base, isBypassPermissionsModeAvailable: true },
      'bypassPermissions',
    ).mode,
  ).toBe('default')
})

test('plan is only restored when plan mode is available', () => {
  const base = { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const }
  configure({})
  expect(restorePermissionModeForResume(base, 'plan').mode).toBe('acceptEdits')
  configure({ planModeAvailable: true } as SettingsJson)
  const restored = restorePermissionModeForResume(base, 'plan')
  expect(restored.mode).toBe('plan')
})

test('auto is not restored while auto mode is unavailable', () => {
  configure({ permissions: { disableAutoMode: 'disable' } } as SettingsJson)
  const base = getEmptyToolPermissionContext()
  expect(restorePermissionModeForResume(base, 'auto').mode).toBe('default')
})

test('an explicit --permission-mode or --dangerously-skip-permissions wins', () => {
  configure({})
  setPermissionModeSetByCli(true)
  const base = getEmptyToolPermissionContext()
  expect(restorePermissionModeForResume(base, 'acceptEdits')).toBe(base)
})
