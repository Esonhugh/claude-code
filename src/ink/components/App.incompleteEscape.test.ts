import { expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import App from './App.js'
import type { InputEvent } from '../events/input-event.js'
import { createSelectionState } from '../selection.js'
import { resetTerminalFocusState } from '../terminal-focus-state.js'

function fixture() {
  const stdin = new Readable({ read() {} })
  const stdout = new Writable({ write(_chunk, _encoding, done) { done() } })
  const app = new App({ children: null, stdin: stdin as never, stdout: stdout as never,
    stderr: stdout as never, exitOnCtrlC: false, onExit() {}, terminalColumns: 80, terminalRows: 24,
    selection: createSelectionState(), onSelectionChange() {},
    onClickAt() { return 'handled' }, onHoverAt() {}, getHyperlinkAt() { return undefined }, onOpenHyperlink() {},
    onMultiClick() {}, onSelectionDrag() {}, dispatchKeyboardEvent() {},
  })
  const inputs: { input: string; escape: boolean; wheelUp: boolean }[] = []
  app.internal_eventEmitter.on('input', (event: InputEvent) => {
    inputs.push({ input: event.input, escape: event.key.escape, wheelUp: event.key.wheelUp })
  })
  return { app, inputs, close() {
    if (app.incompleteEscapeTimer) clearTimeout(app.incompleteEscapeTimer)
    stdin.destroy(); stdout.destroy(); resetTerminalFocusState()
  } }
}

test('a render that blocks past the escape timeout does not split a wheel sequence that arrived meanwhile', async () => {
  const h = fixture()
  try {
    h.app.processInput('\x1b[<64;20;')
    // The rest reaches stdin while a render holds the loop past the 50ms escape timeout.
    setTimeout(() => h.app.processInput('20M'), 60)
    const until = performance.now() + 80
    while (performance.now() < until) { /* block like a slow render */ }
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(h.inputs).toEqual([{ input: '', escape: false, wheelUp: true }])
  } finally { h.close() }
})

test('a lone Escape still flushes after the timeout', async () => {
  const h = fixture()
  try {
    h.app.processInput('\x1b')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(h.inputs.map(input => input.escape)).toEqual([true])
  } finally { h.close() }
})
