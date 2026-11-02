import { afterAll, beforeAll, expect, test } from 'bun:test'
import React from 'react'
import { mkdtempSync, rmSync } from 'fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { type CustomTheme, reloadCustomThemes, saveCustomTheme } from '../utils/customThemes.js'
import { ThemePicker } from './ThemePicker.js'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'theme-picker-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  saveCustomTheme({ slug: 'ocean', name: 'Ocean', base: 'dark', overrides: {} })
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  reloadCustomThemes()
})

test('the theme picker lists Auto, custom themes and New custom theme…', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const calls: Array<CustomTheme | undefined | string> = []
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <ThemePicker
          onThemeSelect={setting => calls.push(setting)}
          onCustomTheme={theme => calls.push(theme)}
          skipExitHandling
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
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  try {
    await settle()
    const text = stripAnsi(output)
    expect(text).toContain('Auto (match terminal)')
    expect(text).toContain('✔ Dark mode')
    expect(text).toMatch(/Ocean\s+custom/)
    expect(text).toContain('New custom theme…')
    expect(text).not.toMatch(/\d\.\s+Dark mode/)

    // Dark mode (current) → Light … ANSI → Ocean: ctrl+e edits it.
    for (let i = 0; i < 6; i++) { stdin.write('\u001B[B'); await settle() }
    expect(stripAnsi(output).split('Enter to select').at(-1)).toContain('ctrl+e to edit')
    stdin.write('\u0005')
    await settle()
    // → New custom theme…: Enter starts a new one.
    stdin.write('\u001B[B')
    await settle()
    stdin.write('\r')
    await settle()
    expect(calls).toEqual([
      { slug: 'ocean', name: 'Ocean', base: 'dark', overrides: {} },
      undefined,
    ])
  } finally {
    instance.unmount()
  }
})
