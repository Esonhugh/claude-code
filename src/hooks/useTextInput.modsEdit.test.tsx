import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { Text, render, useInput } from '../ink.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { useTextInput } from './useTextInput.js'

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
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
async function editsFor(chunk: string, initial = '', history = false) {
  const stdin = new Input(), stdout = new Output()
  const records: unknown[] = [], submissions: string[] = []
  let current = initial
  function Probe() {
    const [value, setValue] = useState(initial)
    const [offset, setOffset] = useState(initial.length)
    current = value
    const state = useTextInput({
      value, externalOffset: offset, onOffsetChange: setOffset,
      onChange: next => { setValue(next); return next },
      onEdit: edit => records.push(structuredClone(edit)),
      onSubmit: text => submissions.push(text),
      onHistoryUp: history ? () => { setValue('from history'); setOffset(12) } : undefined,
      cursorChar: ' ', invert: text => text, themeText: text => text, columns: 80,
    })
    useInput(state.onInput)
    return <Text>{value}</Text>
  }
  const instance = await render(<AppStoreContext value={createStore(getDefaultAppState())}><Probe /></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })
  try {
    stdin.push(chunk)
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve))
    return { records, submissions, value: current }
  } finally { instance.unmount(); instance.cleanup() }
}

test('actual text input records UTF-16 typing and cursor moves in the same stdin chunk', async () => {
  const result = await editsFor('X\x1b[D', 'a😀b')
  expect(result.value).toBe('a😀bX')
  expect(result.records).toEqual([
    { before: {text: 'a😀b', cursor: 4}, after: {text: 'a😀bX', cursor: 5}, key: {key: 'X', shift: true} },
    { before: {text: 'a😀bX', cursor: 5}, after: {text: 'a😀bX', cursor: 4}, key: {key: 'left'} },
  ])
})

test('actual text input has no invented key for a text burst and excludes submit and app history', async () => {
  const result = await editsFor('中文\r')
  expect(result.records).toEqual([{before: {text: '', cursor: 0}, after: {text: '中文', cursor: 2}}])
  expect(result.submissions).toEqual(['中文'])
  const recalled = await editsFor('\x1b[A', '', true)
  expect(recalled.value).toBe('from history')
  expect(recalled.records).toEqual([])
})

test('actual text input records held modifiers and person clear without extra app events', async () => {
  const result = await editsFor('\x02\x03', 'ab')
  expect(result.records).toEqual([
    { before: {text: 'ab', cursor: 2}, after: {text: 'ab', cursor: 1}, key: {key: 'b', ctrl: true} },
    { before: {text: 'ab', cursor: 1}, after: {text: '', cursor: 0}, key: {key: 'c', ctrl: true} },
  ])
})
