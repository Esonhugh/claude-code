import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { SelectMulti } from './SelectMulti.js'

test('multi-select descriptions line up under the option label', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 20, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <SelectMulti
          options={[
            { label: 'Small', value: 's', description: 'small size' },
            { label: 'Medium', value: 'm', description: 'medium size' },
          ]}
          onCancel={() => {}}
        />
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
    const lines = stripAnsi(output).split('\n')
    const label = lines.find(line => line.includes('Medium'))!
    const description = lines.find(line => line.includes('medium size'))!
    expect(description.indexOf('medium size')).toBe(label.indexOf('Medium'))
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
