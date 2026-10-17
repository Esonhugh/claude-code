import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import React, { useLayoutEffect } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, Text, ThemeProvider } from '../ink.js'
import instances from '../ink/instances.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { getTheme } from '../utils/theme.js'
import { PinnedNotifications } from '../components/PromptInput/PinnedNotifications.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { useNotifications, type Notification } from './notifications.js'

const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_STATE_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']
let saved: (string | undefined)[] = []
let directory: string
beforeEach(async () => {
  saved = envKeys.map(key => process.env[key])
  directory = await realpath(await mkdtemp(join(tmpdir(), 'notifications-pinned-')))
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(directory, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(directory, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  for (const key of envKeys.slice(6)) delete process.env[key]
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache()
  envKeys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  })
  await rm(directory, { recursive: true, force: true })
})

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
async function mount() {
  const store = createStore(getDefaultAppState())
  let controls: ReturnType<typeof useNotifications> | undefined
  function Probe() {
    const notifications = useNotifications()
    useLayoutEffect(() => { controls = notifications }, [notifications])
    return null
  }
  const instance = await render(<AppStoreContext value={store}><Probe /></AppStoreContext>, {
    stdin: new Input() as never, stdout: new Output() as never,
    patchConsole: false, exitOnCtrlC: false,
  })
  expect(controls).toBeDefined()
  return { store, controls: controls!, cleanup() {
    for (const notification of [store.getState().notifications.current, ...store.getState().notifications.queue])
      if (notification) controls!.removeNotification(notification.key)
    instance.unmount(); instance.cleanup()
  } }
}

test('default state has a separate empty pinned notification list', () => {
  expect(getDefaultAppState().notifications).toEqual({ current: null, queue: [], pinned: [] })
})

// Official 2.1.289 yo() adds pinned entries before the immediate/queue branches.
test('pinned immediate notice does not preempt or schedule a toast timer', async () => {
  const { store, controls, cleanup } = await mount()
  const transient: Notification = { key: 'toast', text: 'temporary', priority: 'low', timeoutMs: 60000 }
  controls.addNotification(transient)
  const timeout = spyOn(globalThis, 'setTimeout')
  try {
    const pinned = { key: 'status', text: 'persistent', priority: 'immediate' as const, pinned: true }
    controls.addNotification(pinned)
    expect(store.getState().notifications).toEqual({ current: transient, queue: [], pinned: [pinned] })
    expect(timeout).not.toHaveBeenCalled()
  } finally { timeout.mockRestore(); cleanup() }
})

test('duplicate pinned key is a no-op even with fold and invalidates', async () => {
  const { store, controls, cleanup } = await mount()
  try {
    const first = { key: 'status', text: 'first', priority: 'low' as const, pinned: true }
    controls.addNotification(first)
    const before = store.getState()
    const fold = () => { throw new Error('pinned duplicates must not fold') }
    controls.addNotification({ ...first, text: 'second', fold, invalidates: ['status'] })
    expect(store.getState()).toBe(before)
    expect(store.getState().notifications.pinned).toEqual([first])
  } finally { cleanup() }
})

test('status removal preserves the toast timer and remove/add changes pinned order', async () => {
  const { store, controls, cleanup } = await mount()
  const status = { key: 'status-a', text: 'a', priority: 'low' as const, pinned: true }
  const other = { ...status, key: 'status-b', text: 'b' }
  try {
    controls.addNotification(status); controls.addNotification(other)
    controls.addNotification({ key: 'toast', text: 'temporary', priority: 'low', timeoutMs: 60000 })
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      controls.removeNotification('status-a')
      expect(clear).not.toHaveBeenCalled()
      controls.addNotification({ ...status, text: 'updated' })
      expect(store.getState().notifications.pinned).toEqual([other, { ...status, text: 'updated' }])
      expect(store.getState().notifications.current?.key).toBe('toast')
      const state = store.getState()
      controls.removeNotification('missing')
      expect(store.getState()).toBe(state)
    } finally { clear.mockRestore() }
  } finally { cleanup() }
})

test('toast expiry, folding and immediate preemption retain pinned entries', async () => {
  const { store, controls, cleanup } = await mount()
  const status = { key: 'status', text: 'persistent', priority: 'low' as const, pinned: true }
  const timeout = spyOn(globalThis, 'setTimeout')
  try {
    controls.addNotification(status)
    controls.addNotification({ key: 'toast', text: 'one', priority: 'low', timeoutMs: 60000 })
    controls.addNotification({ key: 'toast', text: 'two', priority: 'low', timeoutMs: 60000,
      fold: (previous, incoming) => ({ ...incoming, text: `${'text' in previous ? previous.text : ''}+two` }) })
    expect(store.getState().notifications.pinned).toEqual([status])
    expect(store.getState().notifications.current).toMatchObject({ key: 'toast', text: 'one+two' })
    controls.addNotification({ key: 'urgent', text: 'urgent', priority: 'immediate', timeoutMs: 60000 })
    expect(store.getState().notifications.pinned).toEqual([status])
    expect(store.getState().notifications.queue).toMatchObject([{ key: 'toast', text: 'one+two' }])
    const calls = timeout.mock.calls as unknown as unknown[][]
    const call = calls.findLast(args => typeof args[3] === 'object' && args[3] !== null && 'key' in args[3] && args[3].key === 'urgent')!
    expect(call).toBeDefined()
    clearTimeout(timeout.mock.results[calls.indexOf(call)]!.value as ReturnType<typeof setTimeout>)
    ;(call[0] as (...args: unknown[]) => void)(...call.slice(2))
    expect(store.getState().notifications.pinned).toEqual([status])
    expect(store.getState().notifications.current).toMatchObject({ key: 'toast', text: 'one+two' })
    controls.removeNotification('toast')
    expect(store.getState().notifications).toEqual({ current: null, queue: [], pinned: [status] })
  } finally { timeout.mockRestore(); cleanup() }
})

function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
async function mountPinned(pinned: Notification[]) {
  const store = createStore({ ...getDefaultAppState(), notifications: { current: null, queue: [], pinned } })
  const stdout = new Output()
  const instance = await render(<AppStoreContext value={store}><ThemeProvider initialState="dark">
    <PinnedNotifications />
  </ThemeProvider></AppStoreContext>, { stdin: new Input() as never, stdout: stdout as never,
    patchConsole: false, exitOnCtrlC: false })
  const root = () => (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const notices = () => {
    const list: DOMElement[] = []
    const walk = (node: DOMNode) => {
      if (node.nodeName === '#text') return
      if (node.nodeName === 'ink-text') list.push(node)
      node.childNodes.forEach(walk)
    }
    walk(root())
    return list
  }
  return { store, root, notices, cleanup() { instance.unmount(); instance.cleanup() } }
}

test('pinned presenter sorts by priority without mutating insertion order and paints official styles', async () => {
  const low = { key: 'low', text: 'last', priority: 'low' as const, pinned: true }
  const high = { key: 'high', text: 'first', priority: 'high' as const, pinned: true }
  const jsx = { key: 'jsx', jsx: <Text bold>second</Text>, color: 'success' as const, wrap: true, priority: 'medium' as const, pinned: true }
  const pinned = [low, high, jsx]
  const { root, notices, store, cleanup } = await mountPinned(pinned)
  try {
    expect(notices().map(textOf)).toEqual(['⚠ first', '⚠ second', '⚠ last'])
    expect(store.getState().notifications.pinned).toBe(pinned)
    expect(pinned.map(n => n.key)).toEqual(['low', 'high', 'jsx'])
    expect(root().childNodes[0]!.style).toMatchObject({ paddingX: 2, flexDirection: 'column' })
    expect(notices()[0]!.style.textWrap).toBe('truncate')
    expect(notices()[0]!.textStyles).toMatchObject({ color: getTheme('dark').warning })
    expect(notices()[1]!.style.textWrap).toBe('wrap')
    expect(notices()[1]!.textStyles).toMatchObject({ color: getTheme('dark').success })
  } finally { cleanup() }
})

test('equal priority keeps insertion order and presenter updates when a status is cleared', async () => {
  const a = { key: 'a', text: 'a', priority: 'low' as const, pinned: true }
  const b = { ...a, key: 'b', text: 'b' }
  const { notices, store, cleanup } = await mountPinned([a, b])
  try {
    expect(notices().map(textOf)).toEqual(['⚠ a', '⚠ b'])
    store.setState(previous => ({ ...previous, notifications: { ...previous.notifications, pinned: [b] } }))
    const deadline = Date.now() + 1000
    while (notices().length !== 1 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(notices().map(textOf)).toEqual(['⚠ b'])
    store.setState(previous => ({ ...previous, notifications: { ...previous.notifications, pinned: [] } }))
    while (notices().length !== 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(notices()).toEqual([])
  } finally { cleanup() }
})
