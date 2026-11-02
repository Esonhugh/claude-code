import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { BypassPermissionsModeDialog } from './BypassPermissionsModeDialog.js'

test('the bypass warning lists its choices without numbers, like official', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <BypassPermissionsModeDialog onAccept={() => {}} onDecline={() => {}} />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const text = stripAnsi(output)
    expect(text).toContain('Yes, I accept')
    expect(text).not.toMatch(/\b[12]\. (No|Yes)/)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
