import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render, Text } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { Select } from './select.js'

test('a label that wraps keeps the pointer and index columns intact', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <Select
          options={[
            { label: 'Yes', value: 'yes' },
            {
              label: (
                <Text>
                  Yes, and always allow access to <Text bold>{`/tmp/${'a'.repeat(90)}/work`}</Text> from this project
                </Text>
              ),
              value: 'always',
            },
            { label: 'No', value: 'no' },
          ]}
          onChange={() => {}}
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
    expect(lines.some(l => l.startsWith('  2. Yes, and always allow access to'))).toBe(true)
    expect(lines.some(l => l.startsWith('  3. No'))).toBe(true)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
