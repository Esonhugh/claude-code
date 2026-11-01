import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { ModelPicker } from './ModelPicker.js'

test('/model offers "s to use this session only" next to "set as default" (2.1.311)', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const picks: string[] = []
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <ModelPicker
          initial={null}
          onSelect={model => picks.push(`default:${model}`)}
          onSelectForSession={model => picks.push(`session:${model}`)}
          isStandaloneCommand
        />
      </KeybindingSetup>
    </AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  try {
    await settle()
    const text = stripAnsi(output)
    expect(text).toContain('Your pick becomes the default for new sessions.')
    expect(text).toContain('Enter to set as default · s to use this session only · Esc to cancel')
    stdin.write('s')
    await settle()
    expect(picks).toEqual(['session:null'])
  } finally {
    instance.unmount()
  }
})
