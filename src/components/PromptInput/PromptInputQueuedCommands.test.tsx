import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { clearCommandQueue, enqueue } from '../../utils/messageQueueManager.js'
import { PromptInputQueuedCommands } from './PromptInputQueuedCommands.js'

async function renderQueue(withKeybindings = false) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <AppStateProvider>
      {withKeybindings ? <KeybindingSetup><PromptInputQueuedCommands /></KeybindingSetup> : <PromptInputQueuedCommands />}
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

afterEach(() => clearCommandQueue())

test('a queued prompt shows the send-now hint', async () => {
  enqueue({ value: 'follow up question', mode: 'prompt' })
  const output = await renderQueue()
  expect(output).toContain('follow up question')
  expect(output).toContain('ctrl+x ctrl+s to send now')
})

test('system-generated queued commands get no send-now hint', async () => {
  enqueue({ value: 'scheduled tick', mode: 'prompt', isMeta: true })
  const output = await renderQueue()
  expect(output).not.toContain('to send now')
})

test('without extended key reporting the hint names the chord that can be typed, as official does', async () => {
  enqueue({ value: 'follow up question', mode: 'prompt' })
  const output = await renderQueue(true)
  expect(output).toContain('ctrl+x ctrl+s to send now')
})
