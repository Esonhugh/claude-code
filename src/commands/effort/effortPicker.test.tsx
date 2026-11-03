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

async function renderPicker(state: Record<string, unknown>, columns = 120): Promise<{ text: () => string; done: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 30, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const node = await call(() => {}, {} as never, '')
  const instance = await render(
    <AppStateProvider initialState={{ ...getDefaultAppState(), ...state } as never}>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 50))
  return {
    text: () => stripAnsi(output),
    done: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

test('the slider marks xhigh itself, not high', async () => {
  const picker = await renderPicker({ mainLoopModel: 'claude-opus-5-5', effortValue: 'xhigh' })
  try {
    expect(picker.text()).toContain('─'.repeat(30) + '▲' + '─'.repeat(11))
  } finally {
    picker.done()
  }
})

test('a configured level the model allowlist lacks still shows and is marked', async () => {
  const picker = await renderPicker({ mainLoopModel: 'my-gateway-model', effortValue: 'max' })
  try {
    const text = picker.text()
    expect(text).toContain('low     medium     high      max')
    expect(text).toContain('─'.repeat(30) + '▲' + '─')
  } finally {
    picker.done()
  }
})

test('a narrow terminal keeps the track on one line and puts Ultracode below', async () => {
  const picker = await renderPicker({ mainLoopModel: 'claude-opus-5-5', effortValue: 'medium' }, 60)
  try {
    const lines = picker.text().split('\n')
    const track = lines.find(line => line.includes('▲'))!
    expect(track.trim()).toBe('─'.repeat(10) + '▲' + '─'.repeat(31))
    expect(lines.findIndex(line => line.includes('Ultracode'))).toBeGreaterThan(lines.indexOf(track) + 1)
  } finally {
    picker.done()
  }
})
