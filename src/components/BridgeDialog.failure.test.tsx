import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import type { AppState } from '../state/AppStateStore.js'

// saveGlobalConfig writes here, not to the real ~/.claude.json.
const home = mkdtempSync(join(tmpdir(), 'cc-bridge-dialog-'))
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

const { render } = await import('../ink.js')
const { KeybindingSetup } = await import('../keybindings/KeybindingProviderSetup.js')
const { AppStateProvider, useAppStateStore } = await import('../state/AppState.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { getGlobalConfig, saveGlobalConfig } = await import('../utils/config.js')
const { BridgeDialog } = await import('./BridgeDialog.js')

const toast = { key: 'bridge-failed', text: 'Remote Control failed', priority: 'immediate' as const }

async function open(patch: Partial<AppState>) {
  const stdout = Object.assign(new PassThrough(), { columns: 160, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let store: ReturnType<typeof useAppStateStore> | undefined
  let closed = 0
  function Capture(): null { store = useAppStateStore(); return null }
  const initial = { ...getDefaultAppState(), notifications: { current: toast, queue: [], pinned: [] }, ...patch }
  const instance = await render(
    <AppStateProvider initialState={initial}>
      <KeybindingSetup>
        <Capture />
        <BridgeDialog onDone={() => { closed++ }} />
      </KeybindingSetup>
    </AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  await settle()
  return {
    text: () => stripAnsi(output),
    state: () => store!.getState(),
    closed: () => closed,
    press: async (key: string) => { stdin.write(key); await settle() },
    close: () => instance.unmount(),
  }
}

const authFailed: Partial<AppState> = {
  replBridgeEnabled: false, replBridgeExplicit: true, replBridgeError: '/login', replBridgeErrorKind: 'auth',
}

describe('BridgeDialog while Remote Control has failed (official 2.1.325)', () => {
  test('an auth failure offers r to reconnect and the retry footer', async () => {
    const d = await open(authFailed)
    try {
      expect(d.text()).toContain('Run /remote-control to retry')
      expect(d.text()).toContain('d to dismiss · r to reconnect · Enter/Esc to close')
      await d.press('r')
      expect(d.closed()).toBe(1)
      expect(d.state()).toMatchObject({ replBridgeEnabled: true, replBridgeExplicit: true, replBridgeError: undefined, replBridgeErrorKind: undefined })
      expect(d.state().notifications.current).toBeNull()
    } finally { d.close() }
  })

  test('a terminal failure has no r, and r does nothing', async () => {
    const d = await open({ ...authFailed, replBridgeError: 'connection to server lost', replBridgeErrorKind: 'terminal' })
    try {
      expect(d.text()).toContain('d to dismiss · Enter/Esc to close')
      expect(d.text()).not.toContain('r to reconnect')
      await d.press('r')
      expect(d.closed()).toBe(0)
      expect(d.state().replBridgeEnabled).toBe(false)
    } finally { d.close() }
  })

  test('ended elsewhere and the fuse show no retry footer', async () => {
    for (const patch of [
      { replBridgeError: 'session ended', replBridgeErrorKind: 'ended_elsewhere' as const },
      { replBridgeError: 'disabled after repeated failures · restart to retry', replBridgeErrorKind: 'terminal' as const },
    ]) {
      const d = await open({ ...authFailed, ...patch })
      try {
        expect(d.text()).not.toContain('Run /remote-control to retry')
      } finally { d.close() }
    }
  })

  test('d dismisses the failure without turning startup Remote Control off', async () => {
    saveGlobalConfig(current => ({ ...current, remoteControlAtStartup: true }))
    const d = await open({ ...authFailed, replBridgeEnabled: true })
    try {
      await d.press('d')
      expect(d.closed()).toBe(1)
      expect(d.state()).toMatchObject({ replBridgeEnabled: false, replBridgeError: undefined, replBridgeErrorKind: undefined })
      expect(d.state().notifications.current).toBeNull()
      expect(getGlobalConfig().remoteControlAtStartup).toBe(true)
    } finally { d.close() }
  })

  test('d on a healthy explicit session disconnects and turns startup off', async () => {
    saveGlobalConfig(current => ({ ...current, remoteControlAtStartup: true }))
    const d = await open({ replBridgeEnabled: true, replBridgeExplicit: true, replBridgeConnected: true, replBridgeConnectUrl: 'https://example.invalid/c' })
    try {
      expect(d.text()).toContain('d to disconnect · space for QR code · Enter/Esc to close')
      await d.press('d')
      expect(d.state().replBridgeEnabled).toBe(false)
      expect(getGlobalConfig().remoteControlAtStartup).toBe(false)
    } finally { d.close() }
  })
})
