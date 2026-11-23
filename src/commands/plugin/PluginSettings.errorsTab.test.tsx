import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { PluginSettings } from './PluginSettings.js'

let config: string
let saved: string | undefined
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'plugin-settings-'))
  saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
  resetSettingsCache()
  rmSync(config, { recursive: true, force: true })
})

async function openErrorsTab(plugins: Record<string, unknown>, isMainQueryRunning?: () => boolean) {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const done: Parameters<LocalJSXCommandOnDone>[] = []
  const appState = getDefaultAppState()
  const instance = await render(
    <AppStateProvider initialState={{ ...appState, plugins: { ...appState.plugins, ...plugins } } as never}>
      <KeybindingSetup>
        <MCPConnectionManager disabled dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
          <PluginSettings onComplete={(...args) => { done.push(args) }} args="manage" isMainQueryRunning={isMainQueryRunning} />
        </MCPConnectionManager>
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 5000
    while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  }
  // Wait for text painted after the key, not for what an earlier frame left.
  const press = async (key: string, expected?: string) => {
    await new Promise(resolve => setTimeout(resolve, 100))
    const from = output.length
    stdin.write(key)
    if (expected !== undefined) {
      await waitFor(() => stripAnsi(output.slice(from)).includes(expected))
      expect(stripAnsi(output.slice(from))).toContain(expected)
    }
    return () => stripAnsi(output.slice(from))
  }
  await waitFor(() => stripAnsi(output).includes('Errors (1)'))
  await press('\u001b[C')
  await press('\u001b[C', 'Enter to resolve')
  return { press, waitFor, done, close: () => { instance.unmount(); instance.cleanup() } }
}

test('Enter on a plugin error asks before uninstalling, with No focused', async () => {
  const menu = await openErrorsTab({
    errors: [{ type: 'dependency-unsatisfied', source: 'child@mk', plugin: 'child', dependency: 'base@mk', reason: 'not-found' }],
  })
  try {
    const confirm = await menu.press('\r', 'Uninstall child?')
    expect(confirm()).toContain('Uninstalling this plugin clears its error.')
    expect(confirm()).toMatch(/Yes, uninstall\s+❯ No, cancel/)
    await menu.press('\r', 'Enter to resolve')
    await menu.press('\u001b')
    await menu.waitFor(() => menu.done.length > 0)
    expect(menu.done).toEqual([[undefined, { display: 'skip' }]])
  } finally {
    menu.close()
  }
})

async function removeBrokenMarketplaceAndClose(isMainQueryRunning?: () => boolean) {
  const settingsPath = join(config, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({
    extraKnownMarketplaces: { broken: { source: { source: 'directory', path: join(config, 'missing') } } },
  }))
  resetSettingsCache()
  const menu = await openErrorsTab({
    installationStatus: { marketplaces: [{ name: 'broken', status: 'failed', error: 'not found' }], plugins: [] },
  }, isMainQueryRunning)
  try {
    await menu.press('\r', 'No plugin errors')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extraKnownMarketplaces?.broken).toBeUndefined()
    await menu.press('\u001b')
    await menu.waitFor(() => menu.done.length > 0)
    return menu.done
  } finally {
    menu.close()
  }
}

test('closing the menu after a change submits /reload-plugins', async () => {
  expect(await removeBrokenMarketplaceAndClose()).toEqual([
    [undefined, { display: 'skip', nextInput: '/reload-plugins', submitNextInput: true }],
  ])
})

test('closing the menu over a running response says the reload is queued', async () => {
  expect(await removeBrokenMarketplaceAndClose(() => true)).toEqual([
    [
      'Plugin changes apply when the current response finishes (/reload-plugins is queued).',
      { nextInput: '/reload-plugins', submitNextInput: true },
    ],
  ])
})
