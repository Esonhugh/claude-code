import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { basename } from 'node:path'
import stripAnsi from 'strip-ansi'
import { getOriginalCwd } from '../bootstrap/state.js'
import { render, useStdin } from '../ink.js'
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
  let emitter: ReturnType<typeof useStdin>['internal_eventEmitter'] | undefined
  function Probe(): null { emitter = useStdin().internal_eventEmitter; return null }
  const instance = await render(
    <AppStateProvider>
      <Probe />
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
    expect(stripAnsi(output)).toContain('Search…')
    // Like 2.1.311, the project being listed is named under the search box.
    expect(stripAnsi(output)).toMatch(new RegExp(`(^|\\n) {4}${basename(getOriginalCwd())}\\s*\\n`))
    expect(stripAnsi(output)).toMatch(/Ctrl\+A to show all projects · Type to search · Esc to cancel/)
    stdin.write('\x01')
    await wait()
    // A lone ESC waits on App's 50ms flush timer, which can outlast wait() under load.
    let listener!: (event: { key: { escape: boolean } }) => void
    const dispatched = new Promise<boolean>(resolve => {
      listener = event => { if (event.key.escape) resolve(true) }
      emitter!.prependListener('input', listener)
      setTimeout(() => resolve(false), 2000)
    })
    stdin.write('\x1b')
    try { expect(await dispatched).toBe(true) } finally { emitter!.removeListener('input', listener) }
    await wait()
    expect(calls).toEqual(['toggle', 'cancel'])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
