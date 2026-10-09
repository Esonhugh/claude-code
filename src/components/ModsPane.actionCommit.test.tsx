import { expect, test } from 'bun:test'
import React, { useLayoutEffect } from 'react'
import { Readable, Writable } from 'node:stream'
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { ModUiPane } from '../services/mods/ui.js'
import { ModsPane } from './ModsPane.js'

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 160
  rows = 50
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}

test('drawn empty diff action is registered at commit and targets the current drawing before passive effects', async () => {
  const stdin = new Input(), stdout = new Output(), owner = {}
  const calls: number[] = []
  const available: boolean[] = []
  const errors: unknown[] = []
  function Host({ drawing }: { drawing?: number }) {
    const bindings = useOptionalKeybindingContext()
    useLayoutEffect(() => {
      bindings!.registerActiveContext('Global')
      available.push(bindings!.invokeAction('app:cycleDiffBase'))
      return () => { bindings!.unregisterActiveContext('Global') }
    }, [drawing, bindings])
    if (drawing === undefined) return null
    const pane: ModUiPane = {
      id: 'diff', title: 'Diff', plugin: 'fixture', owner, visible: true, shown: true,
      placement: 'dock', focused: false, closeOnEscape: false, holdToasts: true,
      scrollOffset: 0, bodyRows: 44, bodyColumns: 71, revision: drawing, contentRows: 44, drawing,
      tree: { type: 'Box', children: [
        { type: 'Button', props: { key: 'base', label: '', plain: true, action: 'app:cycleDiffBase' }, press: { plugin: 'fixture', handle: drawing } },
      ] },
    }
    return <ModsPane pane={pane} canFocus onFocus={async () => ({})}
      onInteract={async (_pane, lease) => { calls.push(lease) }} onScroll={async () => {}}
      onClose={async () => {}} onError={error => errors.push(error)} />
  }
  const store = createStore(getDefaultAppState())
  const draw = (drawing?: number) => <AppStoreContext value={store}><KeybindingSetup><Host drawing={drawing} /></KeybindingSetup></AppStoreContext>
  const instance = await render(draw(), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
  try {
    await instance.rerender(draw(7))
    await instance.rerender(draw(8))
    await instance.rerender(draw())
    expect(available).toEqual([false, true, true, false])
    expect(calls).toEqual([7, 8])
    expect(errors).toEqual([])
  } finally {
    instance.unmount()
    instance.cleanup()
    stdin.destroy()
    stdout.destroy()
  }
})
