import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { setAllowedSettingSources, setFlagSettingsInline } from '../../bootstrap/state.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { render } from '../../ink.js'
import { markHostOwnedCodexAppsConfig } from '../../services/apps/trust.js'
import {
  CODEX_APPS_MCP_URL,
  CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
  CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME,
  CODEX_APPS_SERVER_NAME,
} from '../../services/apps/types.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
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

const builtinPlugin = {
  name: 'builtin-fixture',
  manifest: {
    name: 'builtin-fixture',
    description: 'Built-in grouping fixture',
    version: '1.0.0',
  },
  path: '/tmp/builtin-fixture',
  source: 'builtin-fixture@builtin',
  repository: 'builtin',
  enabled: false,
  isBuiltin: true,
}
const pinnedPlugin = {
  ...plugin,
  name: 'pinned-plugin',
  manifest: {
    ...plugin.manifest,
    name: 'pinned-plugin',
    description: 'Version-constrained plugin fixture',
  },
  source: 'pinned-plugin@test-marketplace',
  enabled: true,
}

let disableMode: 'success' | 'success-false' | 'reject' = 'success-false'
let loadBuiltinOnly = false
const enableCalls: string[] = []
const uninstallCalls: string[] = []
const installationLookups: string[] = []

mock.module('../../utils/plugins/pluginLoader.js', () => ({
  loadAllPlugins: async () => ({
    enabled: loadBuiltinOnly ? [] : [plugin, pinnedPlugin],
    disabled: [builtinPlugin],
  }),
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
  enablePluginOp: async (pluginId: string) => {
    enableCalls.push(pluginId)
    return { success: true, message: 'enabled' }
  },
  getPluginInstallationFromV2: (pluginId: string) => {
    installationLookups.push(pluginId)
    return { scope: 'user' }
  },
  isInstallableScope: (scope: string) =>
    scope === 'user' || scope === 'project' || scope === 'local',
  isPluginEnabledAtProjectScope: () => false,
  uninstallPluginOp: async (pluginId: string) => {
    uninstallCalls.push(pluginId)
    return { success: true, message: 'uninstalled' }
  },
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

function pendingMcp(
  name: string,
  kind?: 'connectors' | 'plugins' | 'claude-ai',
): MCPServerConnection {
  const config =
    kind === 'connectors' || kind === 'plugins'
      ? markHostOwnedCodexAppsConfig(
          {
            type: 'http',
            url:
              kind === 'connectors'
                ? CODEX_APPS_MCP_URL
                : CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
            scope: 'dynamic',
          },
          kind,
        )
      : kind === 'claude-ai'
        ? {
            type: 'claudeai-proxy' as const,
            url: 'https://example.invalid/mcp',
            id: 'official-app-fixture',
            scope: 'claudeai' as const,
          }
        : {
            type: 'stdio' as const,
            command: 'unused-test-command',
            args: [],
            scope: 'dynamic' as const,
          }
  return { name, type: 'pending', config }
}

async function renderPluginList(
  clients: MCPServerConnection[],
): Promise<string> {
  process.env.NODE_ENV = 'test'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: '0.0.0-test',
  }
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsInline({
    enabledPlugins: loadBuiltinOnly
      ? {}
      : { 'pinned-plugin@test-marketplace': ['^1.0.0'] },
  })
  resetSettingsCache()

  const { ManagePlugins } = await import('./ManagePlugins.js')
  const stdout = new TestStdout()
  const stdin = new TestStdin()
  const appState = getDefaultAppState()
  const instance = await render(
    <AppStateProvider
      initialState={{
        ...appState,
        mcp: { ...appState.mcp, clients, tools: [] },
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
  const output = stripAnsi(stdout.output)
  instance.unmount()
  instance.cleanup()
  return output
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
  setFlagSettingsInline({
    enabledPlugins: loadBuiltinOnly
      ? {}
      : { 'pinned-plugin@test-marketplace': ['^1.0.0'] },
  })
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

  const expectedPluginName = loadBuiltinOnly
    ? 'builtin-fixture'
    : 'toggle-failure-plugin'
  await waitFor(
    () => stripAnsi(stdout.output).includes(expectedPluginName),
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

async function renderBuiltinAutoUninstall(): Promise<string> {
  process.env.NODE_ENV = 'test'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: '0.0.0-test',
  }
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsInline({
    enabledPlugins: loadBuiltinOnly
      ? {}
      : { 'pinned-plugin@test-marketplace': ['^1.0.0'] },
  })
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
      <ManagePlugins
        setViewState={() => {}}
        setResult={() => {}}
        targetPlugin="builtin-fixture@builtin"
        action="uninstall"
      />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  await waitFor(
    () => stripAnsi(stdout.output).includes('cannot be updated or uninstalled'),
    `built-in uninstall guard did not render. Output:\n${stripAnsi(stdout.output)}`,
  )
  const output = stripAnsi(stdout.output)
  instance.unmount()
  instance.cleanup()
  return output
}

const groupedOutput = await renderPluginList([
  pendingMcp(CODEX_APPS_SERVER_NAME, 'connectors'),
  pendingMcp(CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME, 'plugins'),
  pendingMcp('ordinary_dynamic'),
  pendingMcp('host_owned_other_name', 'connectors'),
  pendingMcp('claude.ai Claude Docs', 'claude-ai'),
])
const codexAppsSection = groupedOutput.match(/Codex Apps\n([^]*?)\n\n/)?.[1]
assert.ok(codexAppsSection)
assert.match(codexAppsSection, /codex_apps MCP/)
assert.match(codexAppsSection, /codex_apps_plugins MCP/)
assert.doesNotMatch(codexAppsSection, /ordinary_dynamic MCP/)
assert.doesNotMatch(codexAppsSection, /host_owned_other_name MCP/)
assert.match(groupedOutput, /Built-in\s+builtin-fixture Plugin · builtin · [^\n]*disabled/)
assert.match(groupedOutput, /pinned-plugin Plugin · test-marketplace · [^\n]*enabled/)
const dynamicSection = groupedOutput.match(
  /Built-in\n([^]*?ordinary_dynamic MCP[^]*?)\n\n/,
)?.[1]
assert.ok(dynamicSection)
assert.match(dynamicSection, /ordinary_dynamic MCP/)
assert.match(dynamicSection, /host_owned_other_name MCP/)
assert.match(
  groupedOutput,
  /Claude AI\s+claude\.ai Claude Docs MCP Claude Official App/,
)
assert.doesNotMatch(groupedOutput, /\n {2}claudeai\n/)

loadBuiltinOnly = true
enableCalls.length = 0
const builtinToggleOutput = await renderAndToggle('will enable')
assert.deepEqual(enableCalls, ['builtin-fixture@builtin'])
assert.match(builtinToggleOutput, /will enable/)
assert.doesNotMatch(builtinToggleOutput, /will disable/)
installationLookups.length = 0
uninstallCalls.length = 0
const builtinAutoUninstallOutput = await renderBuiltinAutoUninstall()
assert.match(builtinAutoUninstallOutput, /Built-in plugins cannot be updated or uninstalled/)
assert.deepEqual(installationLookups, [])
assert.deepEqual(uninstallCalls, [])
loadBuiltinOnly = false

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
