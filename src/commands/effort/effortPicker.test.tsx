import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { call } from './effort.js'

test('a bare /effort opens the effort slider like 2.1.311; s applies for this session only', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 30, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const results: string[] = []
  const node = await call(result => { results.push(String(result)) }, {} as never, '')
  const state = { ...getDefaultAppState(), mainLoopModel: 'claude-opus-5-5', effortValue: 'medium' }
  const instance = await render(
    <AppStateProvider initialState={state as never}>
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
    await new Promise(resolve => setTimeout(resolve, 50))
    const text = stripAnsi(output)
    expect(text).toMatch(/Faster\s+Smarter/)
    expect(text).toContain('low     medium     high     xhigh      max')
    expect(text).toContain('─'.repeat(10) + '▲' + '─'.repeat(31))
    expect(text).toContain('Ultracode  off')
    expect(text).toContain('←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel')
    stdin.write('\u001b[C')
    await new Promise(resolve => setTimeout(resolve, 50))
    stdin.write('s')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(results).toEqual([
      'Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation',
    ])
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
