import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { call } from './powerup.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 60))

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await tick()
}

test('/powerup lists the 2.1.311 lessons, opens one and marks it done', async () => {
  saveGlobalConfig(current => ({ ...current, powerupsUnlocked: ['undo', 'gone'] }))
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const results: string[] = []
  const node = await call(result => { results.push(String(result)) }, {} as never, '')
  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState() as never}>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await waitFor(() => stripAnsi(output).includes('Esc to close'))
    let text = stripAnsi(output)
    expect(text).toContain('Power-ups 1/10 unlocked')
    expect(text).toContain('Talk to your codebase')
    expect(text).toContain('Dial the model')
    expect(text).toContain('↑/↓ to select · Enter to open · Esc to close')
    stdin.write('\r')
    await waitFor(() => stripAnsi(output).includes('Esc to back'))
    text = stripAnsi(output)
    expect(text).toContain('Type @ anywhere in your prompt')
    expect(text).toContain('Enter to mark done · Esc to back')
    output = ''
    stdin.write('\r')
    await waitFor(() => stripAnsi(output).includes('2/10 unlocked'))
    expect(stripAnsi(output)).toContain('2/10 unlocked')
    expect(getGlobalConfig().powerupsUnlocked).toEqual(['undo', 'at-mentions'])
    stdin.write('\u001b')
    await waitFor(() => results.length > 0)
    expect(results).toEqual(['Power-ups closed'])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
