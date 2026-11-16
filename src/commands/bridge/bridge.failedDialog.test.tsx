import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'

const home = mkdtempSync(join(tmpdir(), 'cc-rc-dialog-'))
const savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

const { render } = await import('../../ink.js')
const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
const { AppStateProvider, useAppStateStore } = await import('../../state/AppState.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { call } = await import('./bridge.js')

const toast = { key: 'bridge-failed', text: 'Remote Control failed', priority: 'immediate' as const }
const UP = '\x1b[A'

// /remote-control while the bridge is enabled opens the disconnect dialog.
async function open(patch: Partial<AppState>) {
  const stdout = Object.assign(new PassThrough(), { columns: 160, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let store: ReturnType<typeof useAppStateStore> | undefined
  const done: (string | undefined)[] = []
  function Capture(): null { store = useAppStateStore(); return null }
  const node = await call(result => { done.push(result) }, {} as ToolUseContext & LocalJSXCommandContext, '')
  const initial = { ...getDefaultAppState(), notifications: { current: toast, queue: [], pinned: [] }, replBridgeEnabled: true, ...patch }
  const instance = await render(
    <AppStateProvider initialState={initial}>
      <KeybindingSetup>
        <Capture />
        {node}
      </KeybindingSetup>
    </AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  await settle()
  return {
    text: () => stripAnsi(output),
    state: () => store!.getState(),
    done,
    press: async (key: string) => { stdin.write(key); await settle() },
    close: () => instance.unmount(),
  }
}

describe('/remote-control while Remote Control has failed (official 2.1.325)', () => {
  test('says it isn\'t connected, maps /login, and hints per kind', async () => {
    const d = await open({ replBridgeError: '/login', replBridgeErrorKind: 'auth' })
    try {
      const text = d.text()
      expect(text).toContain("× Remote Control isn't connected.")
      expect(text).toContain('Remote Control needs a claude.ai sign-in.')
      expect(text).toContain('Run /login to restore Remote Control.')
      expect(text).not.toContain('available via Remote Control')
    } finally { d.close() }
  })

  test('a terminal failure explains the 10s wait; no QR row when it was never live', async () => {
    const d = await open({ replBridgeError: 'connection to server lost', replBridgeErrorKind: 'terminal' })
    try {
      const text = d.text()
      expect(text).toContain('connection to server lost')
      expect(text).toContain('To try again, choose Continue, wait about 10 seconds for Remote Control to switch off, then run /remote-control.')
      expect(text).not.toContain('QR code')
    } finally { d.close() }
  })

  test('ended elsewhere says to keep working', async () => {
    const d = await open({ replBridgeError: 'session ended', replBridgeErrorKind: 'ended_elsewhere' })
    try {
      expect(d.text()).toContain('You can keep working here without Remote Control.')
    } finally { d.close() }
  })

  test('disconnect clears the error, its kind and the toast', async () => {
    const d = await open({ replBridgeError: '/login', replBridgeErrorKind: 'auth', replBridgeExplicit: true })
    try {
      await d.press(UP)
      await d.press('\r')
      expect(d.done).toEqual(['Remote Control disconnected.'])
      expect(d.state()).toMatchObject({ replBridgeEnabled: false, replBridgeExplicit: false, replBridgeError: undefined, replBridgeErrorKind: undefined })
      expect(d.state().notifications.current).toBeNull()
    } finally { d.close() }
  })

  test('a live session keeps the URL text and the QR row, without a hint', async () => {
    const d = await open({ replBridgeConnected: true, replBridgeConnectUrl: 'https://example.invalid/c' })
    try {
      const text = d.text()
      expect(text).toContain('This session is available via Remote Control at https://example.invalid/c.')
      expect(text).toContain('Show QR code')
      expect(text).not.toContain("isn't connected")
    } finally { d.close() }
  })
})
