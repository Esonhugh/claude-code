import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { clearMdmSettingsCache, setMdmSettingsCache } from './mdm/settings.js'
import { applyRestrictiveSettings, getSettingsForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'
import type { SettingsJson } from './types.js'

let root: string
const previousManagedPath = getManagedFilePath.cache.get(undefined)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'policy-settings-merge-'))
  mkdirSync(join(root, 'managed'))
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  getManagedSettingsDropInDir.cache.clear()
  clearMdmSettingsCache()
  resetSettingsCache()
})

afterEach(() => {
  clearMdmSettingsCache()
  resetSettingsCache()
  if (previousManagedPath === undefined) getManagedFilePath.cache.delete(undefined)
  else getManagedFilePath.cache.set(undefined, previousManagedPath)
  getManagedSettingsDropInDir.cache.clear()
  rmSync(root, { recursive: true, force: true })
})

// Like official 2.1.292: when managed tiers compose with managedSourcesBehavior "merge",
// restrictive keys keep the most restrictive value any tier sets, while other keys
// still come from the highest tier.
test('restrictive keys keep the most restrictive value any managed tier sets', () => {
  const highest: SettingsJson = {
    managedSourcesBehavior: 'merge',
    enableWorkflows: true,
    disableAllHooks: false,
    spinnerTipsEnabled: false,
    crossSessionInbound: 'accept',
  }
  const lower: SettingsJson = {
    enableWorkflows: false,
    disableAllHooks: true,
    spinnerTipsEnabled: true,
    crossSessionInbound: 'hold',
    permissions: { disableBypassPermissionsMode: 'disable' },
    sandbox: { network: { allowLocalBinding: false } },
  }
  const lowest: SettingsJson = { crossSessionInbound: 'refuse' }
  const merged: SettingsJson = {
    ...lower,
    enableWorkflows: true,
    disableAllHooks: false,
    spinnerTipsEnabled: false,
    crossSessionInbound: 'accept',
  }
  applyRestrictiveSettings(merged, [highest, lower, lowest])
  expect(merged).toEqual({
    enableWorkflows: false,
    disableAllHooks: true,
    spinnerTipsEnabled: false,
    crossSessionInbound: 'refuse',
    permissions: { disableBypassPermissionsMode: 'disable' },
    sandbox: { network: { allowLocalBinding: false } },
  })
})

test('a lower managed tier cannot set a permissive value the highest tier leaves unset', () => {
  const lower: SettingsJson = {
    enableWorkflows: true,
    disableAllHooks: false,
    crossSessionInbound: 'accept',
    sandbox: { enabled: false, network: { allowLocalBinding: true } },
    model: 'lower-model',
  }
  const merged: SettingsJson = structuredClone(lower)
  applyRestrictiveSettings(merged, [{ managedSourcesBehavior: 'merge' }, lower])
  expect(merged).toEqual({ model: 'lower-model' })
})

test('merged policy settings apply the restrictive keys across MDM and managed file tiers', () => {
  writeFileSync(
    join(root, 'managed', 'managed-settings.json'),
    JSON.stringify({ enableWorkflows: false, disableAllHooks: true, spinnerTipsEnabled: true }),
  )
  setMdmSettingsCache(
    {
      settings: {
        managedSourcesBehavior: 'merge',
        enableWorkflows: true,
        disableAllHooks: false,
        spinnerTipsEnabled: false,
      },
      errors: [],
    },
    { settings: {}, errors: [] },
  )
  resetSettingsCache()
  expect(getSettingsForSource('policySettings')).toEqual({
    enableWorkflows: false,
    disableAllHooks: true,
    spinnerTipsEnabled: false,
  })
})
