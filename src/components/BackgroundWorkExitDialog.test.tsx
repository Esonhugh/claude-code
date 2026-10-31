import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { BackgroundWorkExitDialog } from './BackgroundWorkExitDialog.js'

async function renderDialog(rows = 30) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <BackgroundWorkExitDialog
          items={[
            { label: 'subagent', detail: 'Run gamma timer' },
            { label: 'shell', detail: 'python3 timer.py GAMMA 300' },
          ]}
          onExit={() => {}}
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
    return stripAnsi(output)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('matches the official title, item rows and option order', async () => {
  const output = await renderDialog()
  expect(output).toContain('Background work is running')
  expect(output).toContain('The following will stop when you exit:')
  expect(output).toContain('subagent · Run gamma timer')
  expect(output).toContain('shell · python3 timer.py GAMMA 300')
  const lines = output.split('\n')
  const at = (label: string) => lines.findIndex(line => line.includes(label))
  expect(at('Exit and stop tasks')).toBeLessThan(at('Stay'))
  expect(lines[at('Exit and stop tasks')]).toMatch(/[❯>] 1\. Exit and stop tasks/)
})

test('collapses rows that do not fit the terminal', async () => {
  const output = await renderDialog(13)
  expect(output).toContain('subagent · Run gamma timer')
  expect(output).not.toContain('shell · python3')
  expect(output).toContain('+1 more item')
})
