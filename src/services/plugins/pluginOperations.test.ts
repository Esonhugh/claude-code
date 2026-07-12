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

mock.module('../../utils/settings/settings.js', () => ({
  ...settingsModule,
  getSettingsForSource: () => ({
    enabledPlugins: { 'example@marketplace': true },
  }),
  updateSettingsForSource: () => ({ error: settingsError }),
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

const { uninstallPluginOp } = await import('./pluginOperations.js')
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

console.log('pluginOperations.test.ts passed')
