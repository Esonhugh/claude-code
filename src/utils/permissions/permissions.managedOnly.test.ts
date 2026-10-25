import { afterEach, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { resetSettingsCache, setCachedSettingsForSource } = await import('../settings/settingsCache.js')
const { syncPermissionRulesFromDisk } = await import('./permissions.js')

afterEach(() => resetSettingsCache())

test('allowManagedPermissionRulesOnly keeps --disallowedTools and session deny rules on reload', () => {
  setCachedSettingsForSource('policySettings', { allowManagedPermissionRulesOnly: true })
  const context = {
    ...getDefaultAppState().toolPermissionContext,
    alwaysAllowRules: { cliArg: ['Bash'], session: ['Read'], userSettings: ['Edit'] },
    alwaysDenyRules: { cliArg: ['WebFetch'], session: ['Bash(rm:*)'], userSettings: ['Write'] },
    alwaysAskRules: { cliArg: ['Glob'], session: ['Grep'] },
  } as ToolPermissionContext

  const synced = syncPermissionRulesFromDisk(context, [
    { source: 'policySettings', ruleBehavior: 'deny', ruleValue: { toolName: 'NotebookEdit' } },
  ])

  expect(synced.alwaysDenyRules.cliArg).toEqual(['WebFetch'])
  expect(synced.alwaysDenyRules.session).toEqual(['Bash(rm:*)'])
  expect(synced.alwaysDenyRules.policySettings).toEqual(['NotebookEdit'])
  expect(synced.alwaysDenyRules.userSettings ?? []).toEqual([])
  expect(synced.alwaysAllowRules.cliArg ?? []).toEqual([])
  expect(synced.alwaysAllowRules.session ?? []).toEqual([])
  expect(synced.alwaysAllowRules.userSettings ?? []).toEqual([])
  expect(synced.alwaysAskRules.cliArg ?? []).toEqual([])
  expect(synced.alwaysAskRules.session ?? []).toEqual([])
})
