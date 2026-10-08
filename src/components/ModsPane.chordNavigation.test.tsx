import { expect, test } from 'bun:test'
import React, { useSyncExternalStore } from 'react'
import { Readable, Writable } from 'node:stream'
import { render } from '../ink.js'
import instances from '../ink/instances.js'
import { getFocusManager } from '../ink/focus.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { createModUi, type ModUiPresentation } from '../services/mods/ui.js'
import { ModsAbovePrompt } from './ModsAbovePrompt.js'
import { ModsPane } from './ModsPane.js'

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
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}

test('canonical focus chord settles before independent Tab visits the official source and empty base controls', async () => {
  const stdin = new Input()
  const stdout = new Output()
  const owner = {}
  const presentation: ModUiPresentation = {
    columns: 120, rows: 34, isFullscreen: true, composerEmpty: true,
    hasDialog: false, keyboardOwned: false,
  }
  const errors: unknown[] = []
  const ui = createModUi({
    pluginOf: () => 'fixture',
    dispatch: async (_owner, _event, input, core) => core(input),
    draw: async (_owner, input) => input.component === 'AbovePrompt'
      ? { type: 'Box', children: [] }
      : { type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Select', props: { key: 'source', value: 'current', options: [{ value: 'current' }, { value: 'turn' }] }, press: { plugin: 'fixture', handle: 1 } },
        { type: 'Button', props: { key: 'base', label: '', plain: true, action: 'app:cycleDiffBase' }, press: { plugin: 'fixture', handle: 2 } },
        { type: 'Button', props: { key: 'file:omega', label: 'OMEGA' }, press: { plugin: 'fixture', handle: 3 } },
      ] },
    invokeDrawing: async () => undefined,
    releaseDrawing: async () => {},
  })
  let bindings: ReturnType<typeof useOptionalKeybindingContext>
  function Host() {
    bindings = useOptionalKeybindingContext()
    const panes = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    return <>
      <ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus />
      {panes.map(pane => <ModsPane key={pane.id} pane={pane} canFocus
        onFocus={async (current, element, origin = { kind: 'person' }) => {
          const result = await ui.focus(current.owner, { requestId: current.id, element, origin }, presentation)
          const landing = ui.getSnapshot().find(row => row.id === current.id)
          return { ...result as object, focused: landing?.focused, element: landing?.focusedElement, revision: landing?.revision }
        }}
        onInteract={(current, drawing, callback, kind, element, value) => ui.interact(current.id, drawing, callback, kind, element, value)}
        onClose={current => ui.close(current.owner, current.id, { kind: 'person' })}
        onScroll={async () => {}}
        onError={error => errors.push(error)}
      />)}
    </>
  }
  const store = createStore(getDefaultAppState())
  await ui.open(owner, { id: 'diff' }, { kind: 'person' }, presentation)
  await ui.commit(owner)
  const instance = await render(<AppStoreContext value={store}><KeybindingSetup><Host /></KeybindingSetup></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, stderr: stdout as never,
    patchConsole: false, exitOnCtrlC: false,
  })
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const active = () => getFocusManager(root).activeElement
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  try {
    await waitFor(() => bindings !== undefined && ui.getSnapshot()[0]?.drawing !== undefined)
    stdin.push('\x18\t')
    await waitFor(() => ui.getSnapshot()[0]?.focused === true)
    expect(bindings?.pendingChord).toBeNull()
    expect(ui.getSnapshot()[0]?.focusedElement).toBeUndefined()
    await waitFor(() => active()?._eventHandlers?.onKeyDown !== undefined && textOf(active()!).includes('OMEGA'))
    for (const key of ['source', 'base', 'file:omega']) {
      stdin.push('\t')
      await waitFor(() => ui.getSnapshot()[0]?.focusedElement === key)
      await waitFor(() => active() !== null && active() !== undefined &&
        (key === 'source' ? textOf(active()!).includes('current') && !textOf(active()!).includes('OMEGA')
          : key === 'base' ? textOf(active()!) === '' : textOf(active()!).includes('OMEGA')))
      expect(bindings?.pendingChord).toBeNull()
    }
    stdin.push('\x18\t')
    await waitFor(() => ui.getSnapshot()[0]?.focused === false && active() === null)
    expect(bindings?.pendingChord).toBeNull()
    expect(errors).toEqual([])
  } finally {
    instance.unmount()
    instance.cleanup()
    await ui.release(owner)
    stdin.destroy()
    stdout.destroy()
  }
})
