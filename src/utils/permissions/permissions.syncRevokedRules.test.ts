import { expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { syncPermissionRulesFromDisk } = await import('./permissions.js')

test('revoking flagSettings and policySettings rules clears them from the context', () => {
  const context = {
    ...getDefaultAppState().toolPermissionContext,
    alwaysAllowRules: { flagSettings: ['Write'], policySettings: ['Read'], cliArg: ['Glob'] },
    alwaysDenyRules: { flagSettings: ['Bash'], policySettings: ['WebFetch'], session: ['Grep'] },
    alwaysAskRules: { flagSettings: ['Edit'] },
  } as ToolPermissionContext

  const synced = syncPermissionRulesFromDisk(context, [])

  expect(synced.alwaysAllowRules.flagSettings ?? []).toEqual([])
  expect(synced.alwaysDenyRules.flagSettings ?? []).toEqual([])
  expect(synced.alwaysAskRules.flagSettings ?? []).toEqual([])
  expect(synced.alwaysAllowRules.policySettings ?? []).toEqual([])
  expect(synced.alwaysDenyRules.policySettings ?? []).toEqual([])
  expect(synced.alwaysAllowRules.cliArg).toEqual(['Glob'])
  expect(synced.alwaysDenyRules.session).toEqual(['Grep'])
})
