import {expect, test} from 'bun:test'
import React, {useLayoutEffect, useState} from 'react'
import {Readable, Writable} from 'node:stream'
import {render, useInput} from '../ink.js'
import {ModsPane} from './ModsPane.js'
import type {ModUiPane} from '../services/mods/ui.js'

class Output extends Writable {
  columns = 100
  rows = 30
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { callback() }
}
class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this }
  unref() { return this }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

test('focused pane gets Enter, arrows and Escape before a legacy composer consumes input', async () => {
  const stdout = new Output(), stdin = new Input()
  const pressed: string[] = [], legacy: string[] = [], scroll: number[] = []
  let returned = 0, committedFocused = true
  const owner = {}
  function Composer() {
    useInput((input, key, event) => {
      legacy.push(key.return ? 'return' : key.escape ? 'escape' : input)
      event.stopImmediatePropagation()
    })
    return null
  }
  function Probe() {
    const [focused, setFocused] = useState(true)
    useLayoutEffect(() => { committedFocused = focused }, [focused])
    const pane: ModUiPane = {
      id: 'diff', title: 'Diff', plugin: 'fixture', owner, visible: true, shown: true,
      placement: 'inline', focused, closeOnEscape: false, holdToasts: false,
      scrollOffset: 0, bodyRows: 10, bodyColumns: 100, revision: 0, contentRows: 20,
      drawing: 1, tree: {type: 'Button', props: {key: 'ask', label: 'Ask', autoFocus: true},
        press: {plugin: 'fixture', handle: 1}},
    }
    return <><Composer /><ModsPane pane={pane}
      onInteract={async (_pane, _drawing, _callback, _kind, element) => { pressed.push(element) }}
      onClose={async () => { throw Error('non-closing Escape must return focus') }}
      onFocus={async (_pane, element) => {
        if (element !== undefined) return {focused: true, element}
        returned++; setFocused(false); return {focused: false}
      }}
      onScroll={async (_pane, by) => { scroll.push(by) }} /></>
  }
  const instance = await render(<Probe />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  try {
    // Subscription barrier: an unhandled key must reach the composer once.
    stdin.push('z'); await until(() => legacy.length > 0)
    expect(legacy).toEqual(['z']); legacy.length = 0
    stdin.push('\r'); await until(() => pressed.length > 0)
    expect(pressed).toEqual(['ask']); expect(legacy).toEqual([])
    stdin.push('\u001b[B'); await until(() => scroll.length > 0)
    expect(scroll).toEqual([1]); expect(legacy).toEqual([])
    stdin.push('\u001b[27u'); await until(() => returned > 0 && !committedFocused)
    expect(returned).toBe(1); expect(legacy).toEqual([])
    stdin.push('\r'); await until(() => legacy.length > 0)
    expect(legacy).toEqual(['return']); expect(pressed).toEqual(['ask'])
  } finally { instance.unmount() }
})
