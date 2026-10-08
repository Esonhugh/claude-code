import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { render } from '../ink.js'
import instances from '../ink/instances.js'
import { getFocusManager } from '../ink/focus.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import type { ModUiPane } from '../services/mods/ui.js'
import { ModsPane, type ModsPaneFocusHandle } from './ModsPane.js'
import { createModUi } from '../services/mods/ui.js'
import { ModsAbovePrompt } from './ModsAbovePrompt.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 120
  rows = 34
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}

test('Band navigation applies the acknowledged plugin and key to the real DOM input owner', async () => {
  const stdin = new Input(), stdout = new Output()
  const controls = React.createRef<ModsPaneFocusHandle>()
  const receipts: { plugin: string; element: string }[] = []
  const pressed: string[] = [], errors: unknown[] = []
  const initial: ModUiPane = {
    id: 'band', title: '', plugin: 'host', owner: {}, visible: true, shown: true,
    placement: 'inline', focused: true, closeOnEscape: false, holdToasts: false,
    scrollOffset: 0, bodyRows: 5, bodyColumns: 115, contentRows: 2, revision: 0, drawing: 1,
    tree: { type: 'Box', children: ['a', 'b'].map(plugin => ({
      type: 'Button', props: { key: 'shared', label: `CONTROL-${plugin}`, plain: true }, press: { plugin, handle: 1 },
    })) },
  }
  // This is a host receipt fixture, not a Worker or binary acceptance test.
  function Host() {
    const [pane, setPane] = useState(initial)
    return <ModsPane pane={pane} chrome="band" canFocus focusRef={controls}
      onCollapse={() => {}} onScroll={async () => {}}
      onFocus={async (_pane, element, _origin, options) => {
        const plugin = options?.plugin
        if (!plugin || !element) return { focused: false }
        const landing = { plugin, element }
        receipts.push(landing)
        setPane(current => ({ ...current, focused: true, focusedElement: element, focusedPlugin: plugin }))
        return { ...landing, focused: true }
      }}
      onInteract={async (_pane, _drawing, callback) => { pressed.push(callback.plugin) }}
      onError={error => errors.push(error)} />
  }
  const instance = await render(<Host />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const active = () => getFocusManager(root).activeElement
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  try {
    await waitFor(() => controls.current?.hasElement('a', 'shared') === true && controls.current.hasElement('b', 'shared'))
    await controls.current!.next(false)
    expect(receipts.at(-1)).toEqual({ plugin: 'a', element: 'shared' })
    expect(textOf(active()!)).toBe('CONTROL-a')
    await controls.current!.next(false)
    expect(receipts.at(-1)).toEqual({ plugin: 'b', element: 'shared' })
    expect(textOf(active()!)).toBe('CONTROL-b')
    stdin.push('\r')
    await waitFor(() => pressed.length === 1)
    expect(pressed).toEqual(['b'])
    expect(errors).toEqual([])
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy() }
})

test('Band navigation preserves distinct same-plugin duplicate-key slots after an unchanged acknowledgement', async () => {
  const stdin = new Input(), stdout = new Output()
  const controls = React.createRef<ModsPaneFocusHandle>()
  const receipts: { plugin: string; element: string }[] = []
  const pressed: number[] = [], errors: unknown[] = []
  const initial: ModUiPane = {
    id: 'band', title: '', plugin: 'host', owner: {}, visible: true, shown: true,
    placement: 'inline', focused: true, closeOnEscape: false, holdToasts: false,
    scrollOffset: 0, bodyRows: 5, bodyColumns: 115, contentRows: 2, revision: 0, drawing: 1,
    tree: { type: 'Box', children: [1, 2].map(handle => ({
      type: 'Button', props: { key: 'shared', label: `CONTROL-${handle}`, plain: true }, press: { plugin: 'fixture', handle },
    })) },
  }
  // This is a host receipt fixture, not a Worker or binary acceptance test.
  function Host() {
    const [pane, setPane] = useState(initial)
    return <ModsPane pane={pane} chrome="band" canFocus focusRef={controls}
      onCollapse={() => {}} onScroll={async () => {}}
      onFocus={async (_pane, element, _origin, options) => {
        const plugin = options?.plugin
        if (!plugin || !element) return { focused: false }
        const landing = { plugin, element }
        receipts.push(landing)
        setPane(current => ({ ...current, focused: true, focusedElement: element, focusedPlugin: plugin }))
        return { ...landing, focused: true }
      }}
      onInteract={async (_pane, _drawing, callback) => { pressed.push(callback.handle) }}
      onError={error => errors.push(error)} />
  }
  const instance = await render(<Host />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const active = () => getFocusManager(root).activeElement
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  try {
    await waitFor(() => controls.current?.hasElement('fixture', 'shared') === true && textOf(root).includes('CONTROL-1') && textOf(root).includes('CONTROL-2'))
    await controls.current!.next(false)
    expect(receipts.at(-1)).toEqual({ plugin: 'fixture', element: 'shared' })
    expect(textOf(active()!)).toBe('CONTROL-1')
    for (const [bytes, slot] of [['\t', 2], ['\x1b[Z', 1], ['\x1b[B', 2], ['\x1b[A', 1]] as const) {
      stdin.push(bytes)
      await waitFor(() => active() != null && textOf(active()!) === `CONTROL-${slot}`)
      expect(receipts.at(-1)).toEqual({ plugin: 'fixture', element: 'shared' })
    }
    await controls.current!.next(false)
    expect(receipts.at(-1)).toEqual({ plugin: 'fixture', element: 'shared' })
    expect(textOf(active()!)).toBe('CONTROL-2')
    stdin.push('\r')
    await waitFor(() => pressed.length === 1)
    expect(pressed).toEqual([2])
    expect(errors).toEqual([])
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy() }
})

test('canonical Band navigation retains duplicate-key slots only when the real focus core accepts the move', async () => {
  const stdin = new Input(), stdout = new Output()
  let withheld = false
  let focusRequests = 0
  const pressed: number[] = [], errors: unknown[] = []
  const ui = createModUi({
    pluginOf: () => 'fixture',
    dispatch: async (_owner, event, input, core) => {
      if (event === 'ui.focus') {
        focusRequests++
        if (withheld) return {}
      }
      return core(input)
    },
    draw: async () => ({ type: 'Box', children: [1, 2].map(handle => ({
      type: 'Button', props: { key: 'shared', label: `CONTROL-${handle}`, plain: true }, press: { plugin: 'fixture', handle },
    })) }),
    invokeDrawing: async (_owner, _drawing, handle) => { pressed.push(handle) },
    releaseDrawing: async () => {},
  })
  const store = createStore(getDefaultAppState())
  const instance = await render(<AppStoreContext value={store}><KeybindingSetup>
    <ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus onError={error => errors.push(error)} />
  </KeybindingSetup></AppStoreContext>, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const active = () => getFocusManager(root).activeElement
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  const activate = async (slot: number, expectedRequests: number) => {
    stdin.push('\x18\t')
    await waitFor(() => focusRequests === expectedRequests && active() != null && textOf(active()!) === `CONTROL-${slot}`)
    const previous = pressed.length
    stdin.push('\r')
    await waitFor(() => pressed.length === previous + 1)
    expect(pressed.at(-1)).toBe(slot)
  }
  try {
    await waitFor(() => textOf(root).includes('CONTROL-1') && textOf(root).includes('CONTROL-2'))
    await activate(1, 1)
    withheld = true
    await activate(1, 2)
    withheld = false
    await activate(2, 3)
    await activate(1, 4)
    expect(pressed).toEqual([1, 1, 2, 1])
    expect(errors).toEqual([])
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy() }
})

test('withholding a different key preserves the second duplicate-key control and its callback', async () => {
  const stdin = new Input(), stdout = new Output()
  let withheld = false
  let focusRequests = 0
  const requestedKeys: unknown[] = []
  const pressed: number[] = [], errors: unknown[] = []
  const ui = createModUi({
    pluginOf: () => 'fixture',
    dispatch: async (_owner, event, input, core) => {
      if (event === 'ui.focus') {
        focusRequests++; requestedKeys.push(input.element)
        if (withheld) return {}
      }
      return core(input)
    },
    draw: async () => ({ type: 'Box', children: [1, 2, 3].map(handle => ({
      type: 'Button', props: { key: handle === 3 ? 'tail' : 'shared', label: `CONTROL-${handle}`, plain: true }, press: { plugin: 'fixture', handle },
    })) }),
    invokeDrawing: async (_owner, _drawing, handle) => { pressed.push(handle) },
    releaseDrawing: async () => {},
  })
  const store = createStore(getDefaultAppState())
  const instance = await render(<AppStoreContext value={store}><KeybindingSetup>
    <ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus onError={error => errors.push(error)} />
  </KeybindingSetup></AppStoreContext>, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const active = () => getFocusManager(root).activeElement
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  const activate = async (slot: number, expectedRequests: number) => {
    stdin.push('\x18\t')
    await waitFor(() => focusRequests === expectedRequests && active() != null && textOf(active()!) === `CONTROL-${slot}`)
    const previous = pressed.length
    stdin.push('\r')
    await waitFor(() => pressed.length === previous + 1)
    expect(pressed.at(-1)).toBe(slot)
  }
  try {
    await waitFor(() => textOf(root).includes('CONTROL-1') && textOf(root).includes('CONTROL-2'))
    await activate(1, 1)
    await activate(2, 2)
    withheld = true
    await activate(2, 3)
    expect(requestedKeys).toEqual(['shared', 'shared', 'tail'])
    expect(pressed).toEqual([1, 2, 2])
    expect(errors).toEqual([])
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy() }
})
