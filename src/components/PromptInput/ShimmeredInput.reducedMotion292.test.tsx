import { expect, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { ThemeProvider, render } from '../../ink.js'
import instances from '../../ink/instances.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { ClockContext, type Clock } from '../../ink/components/ClockContext.js'
import { HighlightedInput } from './ShimmeredInput.js'

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
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
}
function colors(stdout: Output): string[] {
  const ink = instances.get(stdout as never) as unknown as { rootNode: DOMElement }
  expect(ink).toBeDefined()
  const result: string[] = []
  function walk(node: DOMNode) {
    if (node.nodeName === '#text') return
    if (node.textStyles?.color) result.push(node.textStyles.color)
    node.childNodes.forEach(walk)
  }
  walk(ink.rootNode)
  return result
}

// Official 2.1.292 HighlightedInput uses the live reduced-motion setting,
// null clock interval, and -100 glimmer index while animation is disabled.
test('reduced motion keeps input colors static and releases the clock across live setting changes', async () => {
  const stdin = new Input(), stdout = new Output()
  const initial = getDefaultAppState()
  const store = createStore({ ...initial, settings: { ...initial.settings, prefersReducedMotion: true } })
  const subscribers = new Set<() => void>()
  let time = 0
  const clock: Clock = {
    now: () => time, setTickInterval() {},
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) },
    subscribe(listener, keepAlive) {
      expect(keepAlive).toBe(true)
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
  }
  const instance = await render(<AppStoreContext value={store}><ThemeProvider initialState="dark"><ClockContext value={clock}>
    <HighlightedInput text="abcdefghij" highlights={[{ start: 0, end: 10, color: 'warning', shimmerColor: 'warningShimmer', priority: 1 }]} />
  </ClockContext></ThemeProvider></AppStoreContext>, { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false })
  try {
    await settle()
    expect(subscribers.size).toBe(0)
    expect(colors(stdout)).not.toContain('rgb(255,223,57)')
    store.setState(previous => ({ ...previous, settings: { ...previous.settings, prefersReducedMotion: false } }))
    await settle()
    expect(subscribers.size).toBe(1)
    time = 550
    for (const listener of subscribers) listener()
    await settle()
    expect(colors(stdout)).toContain('rgb(255,223,57)')
    store.setState(previous => ({ ...previous, settings: { ...previous.settings, prefersReducedMotion: true } }))
    await settle()
    expect(subscribers.size).toBe(0)
    expect(colors(stdout)).not.toContain('rgb(255,223,57)')
    store.setState(previous => ({ ...previous, settings: { ...previous.settings, prefersReducedMotion: false } }))
    await settle()
    expect(subscribers.size).toBe(1)
    time = 600
    for (const listener of subscribers) listener()
    await settle()
    expect(colors(stdout)).toContain('rgb(255,223,57)')
  } finally {
    instance.unmount(); instance.cleanup()
  }
  expect(subscribers.size).toBe(0)
})

test('ordinary colored input never holds an animation subscription', async () => {
  const stdin = new Input(), stdout = new Output()
  const initial = getDefaultAppState()
  const subscribers = new Set<() => void>()
  const clock: Clock = {
    now: () => 550, setTickInterval() {},
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) },
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener) } },
  }
  const instance = await render(<AppStoreContext value={createStore(initial)}><ThemeProvider initialState="dark"><ClockContext value={clock}>
    <HighlightedInput text="plain" highlights={[{ start: 0, end: 5, color: 'warning', priority: 1 }]} />
  </ClockContext></ThemeProvider></AppStoreContext>, { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false })
  try { await settle(); expect(subscribers.size).toBe(0); expect(colors(stdout)).not.toContain('rgb(255,223,57)') }
  finally { instance.unmount(); instance.cleanup() }
  expect(subscribers.size).toBe(0)
})
