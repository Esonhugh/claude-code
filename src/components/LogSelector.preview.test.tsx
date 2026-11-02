import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import type { LogOption } from '../types/logs.js'
import { LogSelector } from './LogSelector.js'

test('Space opens the session preview and the footer says so', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 160, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const now = new Date()
  const log: LogOption = {
    date: now.toISOString(),
    messages: [],
    value: 0,
    created: now,
    modified: now,
    firstPrompt: 'Probe session',
    messageCount: 3,
    isSidechain: false,
    sessionId: '00000000-0000-4000-8000-000000000001',
  }
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <LogSelector logs={[log]} maxHeight={30} onSelect={() => {}} onCancel={() => {}} />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    const deadline = Date.now() + 10_000
    while (!/Esc to cancel\n/.test(stripAnsi(output)) && Date.now() < deadline) await sleep(20)
    const list = stripAnsi(output)
    // Like 2.1.311 the picker is a Pane: its contents sit two columns in.
    expect(list).toMatch(/(^|\n) {2}Resume session/)
    expect(list).toMatch(/Space to preview · Ctrl\+R to rename · Type to search · Esc to cancel\n/)
    output = ''
    // The list paints before TreeSelect reports its focused row back to
    // LogSelector, and Space with no focused session does nothing. Under CI
    // load that gap outlasts a fixed sleep, so press again until it opens;
    // extra presses are ignored once the preview owns input.
    while (!stripAnsi(output).includes('Loading session…') && Date.now() < deadline) {
      stdin.write(' ')
      await sleep(100)
    }
    expect(stripAnsi(output)).toContain('Loading session…')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}, 30_000)
