import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { setAllowedSettingSources, setFlagSettingsInline } from '../../bootstrap/state.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { render } from '../../ink.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const plugin = {
  name: 'toggle-failure-plugin',
  manifest: {
    name: 'toggle-failure-plugin',
    description: 'Plugin used by toggle failure tests',
    version: '1.0.0',
  },
  path: '/tmp/toggle-failure-plugin',
  source: 'toggle-failure-plugin@test-marketplace',
  repository: 'test-marketplace',
}

let disableMode: 'success' | 'success-false' | 'reject' = 'success-false'

mock.module('../../utils/plugins/pluginLoader.js', () => ({
  loadAllPlugins: async () => ({ enabled: [plugin], disabled: [] }),
}))

const keybindingHandlers = new Map<string, () => void>()

mock.module('../../services/mcp/MCPConnectionManager.js', () => ({
  MCPConnectionManager: ({ children }: { children: React.ReactNode }) => children,
  useMcpReconnect: () => async () => {},
  useMcpToggleEnabled: () => async () => {},
}))

mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: (action: string, handler: () => void) => {
    keybindingHandlers.set(action, handler)
  },
  useKeybindings: (handlers: Record<string, () => void>) => {
    for (const [action, handler] of Object.entries(handlers)) {
      keybindingHandlers.set(action, handler)
    }
  },
}))

mock.module('../../services/plugins/pluginOperations.js', () => ({
  disablePluginOp: async () => {
    if (disableMode === 'reject') {
      throw new Error('policy rejected disable')
    }
    return disableMode === 'success'
      ? { success: true, message: 'disabled' }
      : { success: false, message: 'policy blocked disable' }
  },
  enablePluginOp: async () => ({ success: true, message: 'enabled' }),
  getPluginInstallationFromV2: () => ({ scope: 'user' }),
  isInstallableScope: (scope: string) =>
    scope === 'user' || scope === 'project' || scope === 'local',
  isPluginEnabledAtProjectScope: () => false,
  uninstallPluginOp: async () => ({ success: true, message: 'uninstalled' }),
  updatePluginOp: async () => ({ success: true, message: 'updated' }),
}))

mock.module('../../utils/plugins/pluginFlagging.js', () => ({
  getFlaggedPlugins: () => ({}),
  markFlaggedPluginsSeen: async () => {},
  removeFlaggedPlugin: () => {},
}))

mock.module('../../utils/plugins/installedPluginsManager.js', () => ({
  loadInstalledPluginsV2: () => ({ plugins: {} }),
}))

mock.module('../../utils/plugins/pluginStartupCheck.js', () => ({
  getPluginEditableScopes: () => new Map(),
}))

mock.module('../../utils/plugins/pluginFavorites.js', () => ({
  getFavoritePluginIds: () => new Set(),
  togglePluginFavorite: () => false,
}))

mock.module('../../utils/plugins/cacheUtils.js', () => ({
  clearAllCaches: () => {},
}))

class TestStdout extends Writable {
  columns = 100
  rows = 40
  isTTY = false
  output = ''

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString()
    callback()
  }
}

class TestStdin extends Readable {
  isTTY = true
  isRaw = false

  _read() {}

  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(message))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

async function renderAndToggle(
  expectedOutput: string,
): Promise<string> {
  process.env.NODE_ENV = 'test'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: '0.0.0-test',
  }
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsInline({ enabledPlugins: {} })
  resetSettingsCache()

  const { ManagePlugins } = await import('./ManagePlugins.js')
  const stdout = new TestStdout()
  const stdin = new TestStdin()
  const appState = getDefaultAppState()
  const instance = await render(
    <AppStateProvider
      initialState={{
        ...appState,
        mcp: { ...appState.mcp, clients: [], tools: [] },
        plugins: { ...appState.plugins, errors: [] },
      }}
    >
      <ManagePlugins setViewState={() => {}} setResult={() => {}} />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  await waitFor(
    () => stripAnsi(stdout.output).includes('toggle-failure-plugin'),
    `plugin did not render. Output:\n${stripAnsi(stdout.output)}`,
  )
  keybindingHandlers.get('plugin:toggle')?.()
  await waitFor(
    () => stripAnsi(stdout.output).includes(expectedOutput),
    `expected toggle state did not render. Output:\n${stripAnsi(stdout.output)}`,
  )
  instance.unmount()
  instance.cleanup()

  return stripAnsi(stdout.output)
}

disableMode = 'success'
const successOutput = await renderAndToggle('will disable')
assert.match(successOutput, /will disable/)
assert.match(successOutput, /Run \/reload-plugins to apply changes/)
assert.doesNotMatch(successOutput, /Failed to disable/)

for (const mode of ['success-false', 'reject'] as const) {
  disableMode = mode
  const output = await renderAndToggle('Failed to disable')
  assert.match(
    output,
    mode === 'success-false' ? /policy blocked disable/ : /policy rejected disable/,
  )
  assert.match(output, /enabled/)
  assert.doesNotMatch(output, /will disable/)
  assert.doesNotMatch(output, /Run \/reload-plugins to apply changes/)
}

console.log('ManagePlugins.toggleFailure.test.tsx passed')
