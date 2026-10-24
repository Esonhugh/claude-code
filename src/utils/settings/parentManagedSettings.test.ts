import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setParentManagedSettings } from '../../bootstrap/state.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { clearMdmSettingsCache } from './mdm/settings.js'
import { getSettingsForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

let root: string
const previousManagedPath = getManagedFilePath.cache.get(undefined)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parent-managed-settings-'))
  mkdirSync(join(root, 'managed'))
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  getManagedSettingsDropInDir.cache.clear()
  clearMdmSettingsCache()
  resetSettingsCache()
})

afterEach(() => {
  setParentManagedSettings(null)
  clearMdmSettingsCache()
  resetSettingsCache()
  if (previousManagedPath === undefined) getManagedFilePath.cache.delete(undefined)
  else getManagedFilePath.cache.set(undefined, previousManagedPath)
  getManagedSettingsDropInDir.cache.clear()
  rmSync(root, { recursive: true, force: true })
})

const parent = {
  model: 'parent-model',
  env: { FOO: '1' },
  cleanupPeriodDays: 1,
  permissions: { allow: ['Bash'], deny: ['WebFetch'] },
  sandbox: { network: { allowManagedDomainsOnly: true, allowLocalBinding: true } },
  disableAllHooks: true,
  enableWorkflows: true,
}

test('with no admin tier, --managed-settings is the policy tier, restrictive keys only', () => {
  setParentManagedSettings(parent)
  resetSettingsCache()
  expect(getSettingsForSource('policySettings')).toEqual({
    permissions: { deny: ['WebFetch'] },
    sandbox: { network: { allowManagedDomainsOnly: true } },
    disableAllHooks: true,
  })
})

test('an admin managed-settings.json drops --managed-settings unless it opts into merge', () => {
  const file = join(root, 'managed', 'managed-settings.json')
  writeFileSync(file, JSON.stringify({ permissions: { deny: ['Write'] } }))
  setParentManagedSettings(parent)
  resetSettingsCache()
  expect(getSettingsForSource('policySettings')).toEqual({ permissions: { deny: ['Write'] } })

  writeFileSync(file, JSON.stringify({ parentSettingsBehavior: 'merge', permissions: { deny: ['Write'] } }))
  resetSettingsCache()
  expect(getSettingsForSource('policySettings')).toEqual({
    parentSettingsBehavior: 'merge',
    permissions: { deny: ['WebFetch', 'Write'] },
    sandbox: { network: { allowManagedDomainsOnly: true } },
    disableAllHooks: true,
  })
})
