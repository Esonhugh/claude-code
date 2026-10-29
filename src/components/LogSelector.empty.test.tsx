import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { LogSelector } from './LogSelector.js'

test('an empty project list keeps the picker open with Ctrl+A and Esc', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const calls: string[] = []
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <LogSelector
          logs={[]}
          maxHeight={30}
          onSelect={() => {}}
          onCancel={() => calls.push('cancel')}
          onToggleAllProjects={() => calls.push('toggle')}
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
  const wait = () => new Promise(resolve => setTimeout(resolve, 80))
  try {
    await wait()
    expect(stripAnsi(output)).toContain('No conversations found in this project.')
    expect(stripAnsi(output)).toContain('show all projects')
    stdin.write('\x01')
    await wait()
    stdin.write('\x1b')
    await wait()
    expect(calls).toEqual(['toggle', 'cancel'])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
