import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

test('Enter on a plugin error asks before uninstalling and defaults to No', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'plugin-errors-confirm-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  const { render } = await import('../../ink.js')
  const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
  const { AppStateProvider, getDefaultAppState } = await import('../../state/AppState.js')
  const { ErrorsTabContent } = await import('./PluginSettings.js')

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const text = () => stripAnsi(output)
  const press = async (keys: string) => {
    output = ''
    stdin.write(keys)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const base = getDefaultAppState()
  const state = {
    ...base,
    plugins: {
      ...base.plugins,
      errors: [{
        type: 'dependency-unsatisfied',
        source: 'child@mkt2',
        plugin: 'child',
        dependency: 'base@mkt2',
        reason: 'not-found',
      }],
    },
  }
  const viewStates: unknown[] = []
  const tabs: string[] = []
  const instance = await render(
    <AppStateProvider initialState={state as never}>
      <KeybindingSetup>
        <ErrorsTabContent
          setViewState={viewState => viewStates.push(viewState)}
          setActiveTab={tab => tabs.push(tab)}
          markPluginsChanged={() => {}}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(text()).toContain('child')

    await press('\r')
    expect(viewStates).toEqual([])
    expect(text()).toContain('Uninstall child?')
    expect(text()).toContain('Uninstalling this plugin clears its error.')
    expect(text()).toContain('Yes, uninstall')
    expect(text()).toMatch(/❯ (2\. )?No, cancel/)

    // The default answer is No: Enter cancels and nothing is uninstalled.
    await press('\r')
    expect(viewStates).toEqual([])
    expect(tabs).toEqual([])

    await press('\r')
    expect(text()).toContain('Uninstall child?')
    await press('\u001b[A')
    await press('\r')
    expect(tabs).toEqual(['installed'])
    expect(viewStates).toEqual([
      { type: 'manage-plugins', targetPlugin: 'child', action: 'uninstall' },
    ])
  } finally {
    instance.unmount()
    instance.cleanup()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  }
})
