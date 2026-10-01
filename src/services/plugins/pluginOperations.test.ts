#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mock } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const settingsModule = await import('../../utils/settings/settings.js')
const pluginLoaderModule = await import('../../utils/plugins/pluginLoader.js')
const installedPluginsModule = await import(
  '../../utils/plugins/installedPluginsManager.js'
)
const cacheModule = await import('../../utils/plugins/cacheUtils.js')
const optionsModule = await import(
  '../../utils/plugins/pluginOptionsStorage.js'
)
const directoriesModule = await import(
  '../../utils/plugins/pluginDirectories.js'
)

let settingsError: Error | null = new Error('settings are read-only')
let installationPresent = true
let installationRemoved = false
let cachesCleared = false
let versionOrphaned = false
let optionsDeleted = false
let dataDirDeleted = false
const settingsBySource = {
  userSettings: {
    enabledPlugins: { 'example@marketplace': true } as Record<
      string,
      boolean | string[] | undefined
    >,
  },
  projectSettings: { enabledPlugins: {} as Record<string, boolean> },
  localSettings: { enabledPlugins: {} as Record<string, boolean> },
  flagSettings: { enabledPlugins: {} as Record<string, boolean> },
  policySettings: { enabledPlugins: {} as Record<string, boolean> },
}

mock.module('../../utils/settings/settings.js', () => ({
  ...settingsModule,
  getSettingsForSource: (source: keyof typeof settingsBySource) =>
    settingsBySource[source],
  updateSettingsForSource: (
    source: keyof typeof settingsBySource,
    update: { enabledPlugins?: Record<string, boolean | string[] | undefined> },
  ) => {
    if (!settingsError && update.enabledPlugins) {
      settingsBySource[source].enabledPlugins = update.enabledPlugins as never
    }
    return { error: settingsError }
  },
}))
mock.module('../../utils/plugins/pluginLoader.js', () => ({
  ...pluginLoaderModule,
  loadAllPlugins: async () => ({ enabled: [], disabled: [] }),
}))
mock.module('../../utils/plugins/installedPluginsManager.js', () => ({
  ...installedPluginsModule,
  loadInstalledPluginsV2: () => ({
    version: 2,
    plugins: installationPresent
      ? {
          'example@marketplace': [
            { scope: 'user', installPath: '/tmp/example-plugin' },
          ],
        }
      : {},
  }),
  removePluginInstallation: () => {
    installationRemoved = true
    installationPresent = false
  },
}))
mock.module('../../utils/plugins/cacheUtils.js', () => ({
  ...cacheModule,
  clearAllCaches: () => {
    cachesCleared = true
  },
  markPluginVersionOrphaned: async () => {
    versionOrphaned = true
  },
}))
mock.module('../../utils/plugins/pluginOptionsStorage.js', () => ({
  ...optionsModule,
  deletePluginOptions: () => {
    optionsDeleted = true
  },
}))
mock.module('../../utils/plugins/pluginDirectories.js', () => ({
  ...directoriesModule,
  deletePluginDataDir: async () => {
    dataDirDeleted = true
  },
}))

const { setPluginEnabledOp, uninstallPluginOp } = await import(
  './pluginOperations.js'
)
const result = await uninstallPluginOp('example@marketplace')

assert.equal(result.success, false)
assert.match(result.message, /settings are read-only/)
assert.equal(installationRemoved, false)
assert.equal(cachesCleared, false)
assert.equal(versionOrphaned, false)
assert.equal(optionsDeleted, false)
assert.equal(dataDirDeleted, false)

settingsError = null
const successResult = await uninstallPluginOp('example@marketplace')

assert.equal(successResult.success, true)
assert.equal(successResult.pluginId, 'example@marketplace')
assert.equal(successResult.scope, 'user')
assert.equal(installationRemoved, true)
assert.equal(cachesCleared, true)
assert.equal(versionOrphaned, true)
assert.equal(optionsDeleted, true)
assert.equal(dataDirDeleted, true)

settingsBySource.userSettings.enabledPlugins['builtin-fixture@builtin'] = false
settingsBySource.projectSettings.enabledPlugins['builtin-fixture@builtin'] = false
const overriddenBuiltin = await setPluginEnabledOp(
  'builtin-fixture@builtin',
  true,
)
assert.equal(overriddenBuiltin.success, false)
assert.match(overriddenBuiltin.message, /project settings/i)
assert.equal(
  settingsBySource.userSettings.enabledPlugins['builtin-fixture@builtin'],
  false,
)

settingsBySource.projectSettings.enabledPlugins = {}
settingsBySource.policySettings.enabledPlugins['builtin-fixture@builtin'] = false
const managedBuiltin = await setPluginEnabledOp('builtin-fixture@builtin', true)
assert.equal(managedBuiltin.success, false)
assert.match(managedBuiltin.message, /policy|organization/i)
assert.equal(
  settingsBySource.userSettings.enabledPlugins['builtin-fixture@builtin'],
  false,
)

settingsBySource.policySettings.enabledPlugins = {}
const enabledBuiltin = await setPluginEnabledOp('builtin-fixture@builtin', true)
assert.equal(enabledBuiltin.success, true)
assert.equal(
  settingsBySource.userSettings.enabledPlugins['builtin-fixture@builtin'],
  true,
)

settingsBySource.userSettings.enabledPlugins['read-only@marketplace'] = false
settingsBySource.flagSettings.enabledPlugins['read-only@marketplace'] = true
const readOnlyDisable = await setPluginEnabledOp('read-only@marketplace', false)
assert.equal(readOnlyDisable.success, false)
assert.match(readOnlyDisable.message, /command-line settings/i)
assert.equal(
  settingsBySource.userSettings.enabledPlugins['read-only@marketplace'],
  false,
)

settingsBySource.flagSettings.enabledPlugins = {}
settingsBySource.policySettings.enabledPlugins['blocked@marketplace'] = false
const policyEnable = await setPluginEnabledOp('blocked@marketplace', true)
assert.equal(policyEnable.success, false)
assert.match(policyEnable.message, /organization policy/i)

console.log('pluginOperations.test.ts passed')
