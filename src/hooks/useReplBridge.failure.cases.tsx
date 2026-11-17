import { expect, mock, test } from 'bun:test'
import React, { useLayoutEffect, useRef, useState } from 'react'
import { PassThrough } from 'node:stream'
import type { InitBridgeOptions } from '../bridge/initReplBridge.js'
import type { ReplBridgeHandle } from '../bridge/replBridge.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'

// Run by useReplBridge.failure.test.ts in a BRIDGE_MODE child.
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals

// The 10s auto-disable and 5min auth poll, shrunk so the cases run in ms.
const realSetTimeout = globalThis.setTimeout
const SHRUNK: Record<number, number> = { 10_000: 40, 300_000: 80 }
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(fn, ms !== undefined && SHRUNK[ms] !== undefined ? SHRUNK[ms] : ms, ...rest)) as typeof setTimeout

type Init = (opts: InitBridgeOptions) => Promise<ReplBridgeHandle | null>
let init: Init = async () => null
let initCalls = 0
let lastOpts: InitBridgeOptions | undefined
mock.module('../bridge/initReplBridge.js', () => ({
  initReplBridge: (opts: InitBridgeOptions) => {
    initCalls++
    lastOpts = opts
    return init(opts)
  },
}))
const realEnvLess = await import('../bridge/envLessBridgeConfig.js')
mock.module('../bridge/envLessBridgeConfig.js', () => ({ ...realEnvLess, shouldShowAppUpgradeMessage: async () => false }))
const realEnabled = await import('../bridge/bridgeEnabled.js')
mock.module('../bridge/bridgeEnabled.js', () => ({ ...realEnabled, isBridgeEnabled: () => true }))

let credential: { accessToken: string; accountUuid?: string } | undefined
let account: { accountUuid?: string } | undefined
const realRevive = await import('../bridge/bridgeAuthRevive.js')
mock.module('../bridge/bridgeAuthRevive.js', () => ({
  ...realRevive,
  readBridgeCredential: async () => credential,
  accountOfCurrentLogin: () => account,
}))

const { render } = await import('../ink.js')
const { AppStateProvider, useAppState, useAppStateStore } = await import('../state/AppState.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { useReplBridge } = await import('./useReplBridge.js')

function fakeHandle(): ReplBridgeHandle {
  const noop = () => {}
  return {
    bridgeSessionId: 'cse_test', environmentId: '', sessionIngressUrl: 'https://example.invalid',
    writeMessages: noop, writeSdkMessages: noop, sendControlRequest: noop, sendControlResponse: noop,
    sendControlCancelRequest: noop, sendResult: noop, teardown: async () => {},
  } as unknown as ReplBridgeHandle
}

type Mounted = {
  state: () => AppState
  set: (patch: Partial<AppState>) => void
  messages: () => Message[]
  /** replBridgeEnabled as of the last commit, which is what the hook's effect sees. */
  committedEnabled: () => boolean
  unmount: () => void
}

async function mount(patch: Partial<AppState> = {}): Promise<Mounted> {
  let store: ReturnType<typeof useAppStateStore> | undefined
  let rows: Message[] = []
  let committedEnabled = false
  function Harness(): React.ReactNode {
    const [messages, setMessages] = useState<Message[]>([])
    rows = messages
    const abortRef = useRef<AbortController | null>(null)
    const s = useAppStateStore()
    useLayoutEffect(() => { store = s }, [s])
    const enabled = useAppState(state => state.replBridgeEnabled)
    useLayoutEffect(() => { committedEnabled = enabled }, [enabled])
    useReplBridge(messages, setMessages, abortRef, [], 'test-model')
    return null
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 20, isTTY: false })
  stdout.resume()
  const instance = await render(
    <AppStateProvider initialState={{ ...getDefaultAppState(), replBridgeEnabled: true, ...patch }}>
      <Harness />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    },
  )
  return {
    state: () => store!.getState(),
    set: p => store!.setState(prev => ({ ...prev, ...p })),
    messages: () => rows,
    committedEnabled: () => committedEnabled,
    unmount: () => { instance.unmount(); instance.cleanup() },
  }
}

async function until(check: () => boolean, label: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => realSetTimeout(resolve, 5))
  }
}
const pause = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms))

/** The toast's visible text: title plus " · detail". */
function toastText(state: AppState): string | undefined {
  const current = [state.notifications.current, ...state.notifications.queue].find(n => n?.key === 'bridge-failed')
  if (!current) return undefined
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text((node as { props?: { children?: unknown } }).props?.children)
  }
  return 'jsx' in current ? text(current.jsx) : current.text
}

const lines = (m: Mounted) =>
  m.messages().flatMap(row => (row.type === 'system' && typeof row.content === 'string' && row.content.startsWith('Remote Control disconnected') ? [row.content] : []))

function reset(): void {
  init = async () => null
  initCalls = 0
  lastOpts = undefined
  credential = undefined
  account = undefined
}

test('a failure after connecting says "disconnected"; the 10s timer keeps error and kind', async () => {
  reset()
  init = async () => fakeHandle()
  const m = await mount()
  try {
    await until(() => m.state().replBridgeConnected, 'connected')
    lastOpts!.onStateChange!('failed', 'this session was ended or archived from another device or app (code 4090)', 'ended_elsewhere')
    await until(() => m.state().replBridgeError !== undefined, 'error')
    expect(toastText(m.state())).toBe('Remote Control disconnected · this session was ended or archived from another device or app (code 4090)')
    expect(m.state().replBridgeErrorKind).toBe('ended_elsewhere')
    // ended_elsewhere: no "run /remote-control" hint.
    await until(() => lines(m).length > 0, 'line')
    expect(lines(m)).toEqual(['Remote Control disconnected — this session was ended or archived from another device or app (code 4090)'])
    await until(() => !m.state().replBridgeEnabled, 'auto-disable')
    expect(m.state().replBridgeError).toBe('this session was ended or archived from another device or app (code 4090)')
    expect(m.state().replBridgeErrorKind).toBe('ended_elsewhere')
    expect(toastText(m.state())).toBeDefined()
  } finally { m.unmount() }
})

test('a failure before any handle says "failed"; an empty detail falls back to /remote-control', async () => {
  reset()
  init = async opts => { opts.onStateChange!('failed', '', 'terminal'); return null }
  const m = await mount()
  try {
    await until(() => toastText(m.state()) !== undefined && lines(m).length > 0, 'toast')
    expect(toastText(m.state())).toBe('Remote Control failed · /remote-control')
    expect(lines(m)).toEqual(['Remote Control disconnected — run /remote-control to reconnect'])
  } finally { m.unmount() }
})

test('an auth failure gets the /login line, and the kind defaults to terminal', async () => {
  reset()
  init = async opts => { opts.onStateChange!('failed', 'Session creation failed — see debug log'); return null }
  const m = await mount()
  try {
    await until(() => m.state().replBridgeError !== undefined && lines(m).length > 0, 'error')
    expect(m.state().replBridgeErrorKind).toBe('terminal')
    expect(lines(m)).toEqual(['Remote Control disconnected — Session creation failed — see debug log — run /remote-control to reconnect'])
  } finally { m.unmount() }
  reset()
  init = async opts => { opts.onStateChange!('failed', 'auth token expired (code 401)', 'auth'); return null }
  const a = await mount()
  try {
    await until(() => a.state().replBridgeError !== undefined && lines(a).length > 0, 'error')
    expect(a.state().replBridgeErrorKind).toBe('auth')
    expect(lines(a)).toEqual(['Remote Control disconnected — auth token expired (code 401) — run /login to restore Remote Control'])
  } finally { a.unmount() }
})

test('init returning null with no reason: explicit asks for /login, otherwise switches off silently', async () => {
  reset()
  const explicit = await mount({ replBridgeExplicit: true })
  try {
    await until(() => explicit.state().replBridgeError !== undefined && lines(explicit).length > 0, 'error')
    expect(explicit.state().replBridgeError).toBe('/login')
    expect(explicit.state().replBridgeErrorKind).toBe('auth')
    expect(toastText(explicit.state())).toBe('Remote Control failed · /login')
    expect(lines(explicit)).toEqual(['Remote Control disconnected — /login'])
  } finally { explicit.unmount() }
  reset()
  const auto = await mount()
  try {
    await until(() => !auto.state().replBridgeEnabled, 'disabled')
    expect(auto.state().replBridgeError).toBeUndefined()
    expect(toastText(auto.state())).toBeUndefined()
    expect(lines(auto)).toEqual([])
  } finally { auto.unmount() }
})

test('ready clears the error and the toast', async () => {
  reset()
  init = async () => fakeHandle()
  const m = await mount()
  try {
    await until(() => m.state().replBridgeConnected, 'connected')
    lastOpts!.onStateChange!('failed', 'connection to server lost', 'terminal')
    await until(() => toastText(m.state()) !== undefined, 'toast')
    lastOpts!.onStateChange!('ready')
    await until(() => m.state().replBridgeError === undefined, 'cleared')
    expect(m.state().replBridgeErrorKind).toBeUndefined()
    expect(toastText(m.state())).toBeUndefined()
  } finally { m.unmount() }
})

test('turning it off inside the 10s window clears the error and the toast', async () => {
  reset()
  init = async opts => { opts.onStateChange!('failed', 'Transport closed: code 4500', 'terminal'); return null }
  const m = await mount()
  try {
    await until(() => toastText(m.state()) !== undefined, 'toast')
    m.set({ replBridgeEnabled: false })
    await until(() => m.state().replBridgeError === undefined, 'cleared')
    expect(toastText(m.state())).toBeUndefined()
  } finally { m.unmount() }
})

test('an outbound-only mirror only drops connected: no toast, no line, no error', async () => {
  reset()
  init = async () => fakeHandle()
  const m = await mount({ replBridgeOutboundOnly: true })
  try {
    await until(() => m.state().replBridgeConnected, 'connected')
    lastOpts!.onStateChange!('failed', 'connection to server lost', 'terminal')
    await until(() => !m.state().replBridgeConnected, 'disconnected')
    await pause(60)
    expect(toastText(m.state())).toBeUndefined()
    expect(lines(m)).toEqual([])
    expect(m.state().replBridgeError).toBeUndefined()
    expect(m.state().replBridgeEnabled).toBe(true)
  } finally { m.unmount() }
})

test('an outbound-only mirror whose init throws switches off silently', async () => {
  reset()
  init = async () => { throw new Error('mirror boom') }
  const m = await mount({ replBridgeOutboundOnly: true })
  try {
    await until(() => !m.state().replBridgeEnabled, 'disabled')
    await pause(60)
    expect(m.state().replBridgeError).toBeUndefined()
    expect(toastText(m.state())).toBeUndefined()
    expect(lines(m)).toEqual([])
  } finally { m.unmount() }
})

test('three failed inits trip the fuse, which writes its own line', async () => {
  reset()
  init = async () => { throw new Error('boom') }
  const m = await mount()
  try {
    for (let i = 1; i <= 3; i++) {
      // Re-enable only after the disable is committed; flipping it back first leaves the effect unrun.
      await until(() => initCalls === i && !m.committedEnabled() && m.state().replBridgeError === 'boom', `failure ${i}`)
      m.set({ replBridgeEnabled: true })
    }
    await until(() => m.state().replBridgeError === 'disabled after repeated failures · restart to retry', 'fuse')
    expect(initCalls).toBe(3)
    expect(m.state().replBridgeEnabled).toBe(false)
    expect(m.state().replBridgeErrorKind).toBe('terminal')
    await until(() => lines(m).at(-1)?.includes('repeated failures') === true, 'fuse line')
    expect(lines(m).at(-1)).toBe('Remote Control disconnected — disabled after repeated failures · restart to retry')
  } finally { m.unmount() }
})

test('auth pending: a fresh same-account sign-in turns Remote Control back on', async () => {
  reset()
  credential = { accessToken: 'rejected', accountUuid: 'acct-1' }
  account = { accountUuid: 'acct-1' }
  init = async opts => { opts.onStateChange!('failed', '/login', 'auth'); return null }
  const m = await mount({ replBridgeExplicit: true })
  try {
    await until(() => !m.state().replBridgeEnabled && m.state().replBridgeErrorKind === 'auth', 'auth pending')
    // Same token as the one that failed: polling keeps waiting.
    await pause(200)
    expect(m.state().replBridgeEnabled).toBe(false)
    expect(initCalls).toBe(1)
    init = async () => fakeHandle()
    credential = { accessToken: 'fresh', accountUuid: 'acct-1' }
    m.set({ authVersion: m.state().authVersion + 1 })
    await until(() => m.state().replBridgeConnected, 'revived and connected')
    expect(initCalls).toBe(2)
    expect(m.state().replBridgeError).toBeUndefined()
    expect(m.state().replBridgeErrorKind).toBeUndefined()
    expect(toastText(m.state())).toBeUndefined()
  } finally { m.unmount() }
})

test('auth pending: a sign-in to a different account disarms the watcher', async () => {
  reset()
  credential = { accessToken: 'rejected', accountUuid: 'acct-1' }
  account = { accountUuid: 'acct-1' }
  init = async opts => { opts.onStateChange!('failed', '/login', 'auth'); return null }
  const m = await mount({ replBridgeExplicit: true })
  try {
    await until(() => !m.state().replBridgeEnabled && m.state().replBridgeErrorKind === 'auth', 'auth pending')
    await pause(20)
    credential = { accessToken: 'other', accountUuid: 'acct-2' }
    m.set({ authVersion: m.state().authVersion + 1 })
    await pause(250)
    expect(m.state().replBridgeEnabled).toBe(false)
    expect(m.state().replBridgeError).toBe('/login')
    expect(initCalls).toBe(1)
  } finally { m.unmount() }
})

test('a terminal failure does not arm the watcher', async () => {
  reset()
  credential = { accessToken: 'tok', accountUuid: 'acct-1' }
  account = { accountUuid: 'acct-1' }
  init = async opts => { opts.onStateChange!('failed', 'connection to server lost', 'terminal'); return null }
  const m = await mount()
  try {
    await until(() => !m.state().replBridgeEnabled, 'auto-disable')
    credential = { accessToken: 'fresh', accountUuid: 'acct-1' }
    m.set({ authVersion: m.state().authVersion + 1 })
    await pause(250)
    expect(m.state().replBridgeEnabled).toBe(false)
    expect(initCalls).toBe(1)
  } finally { m.unmount() }
})

test('an init after an auth revive does not count toward the fuse and fails as auth', async () => {
  reset()
  credential = { accessToken: 'rejected', accountUuid: 'acct-1' }
  account = { accountUuid: 'acct-1' }
  init = async opts => { opts.onStateChange!('failed', '/login', 'auth'); return null }
  const m = await mount({ replBridgeExplicit: true })
  try {
    await until(() => !m.state().replBridgeEnabled && m.state().replBridgeErrorKind === 'auth', 'auth pending')
    init = async () => { throw new Error('still rejected') }
    credential = { accessToken: 'fresh', accountUuid: 'acct-1' }
    m.set({ authVersion: m.state().authVersion + 1 })
    await until(() => m.state().replBridgeError === 'still rejected', 'revived init failed')
    expect(m.state().replBridgeErrorKind).toBe('auth')
    await until(() => lines(m).at(-1)?.includes('still rejected') === true, 'line')
    expect(lines(m).at(-1)).toBe('Remote Control disconnected — still rejected — run /login to restore Remote Control')
  } finally { m.unmount() }
})
