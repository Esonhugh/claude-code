import { expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { useState } from 'react'
import { render, type Key } from '../ink.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { VimMode } from '../types/textInputTypes.js'
import { useVimInput } from './useVimInput.js'

class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    done()
  }
}

async function mountInput(initialValue: string, initialOffset: number) {
  const changes: Array<[string, number]> = []
  let currentValue = initialValue
  let input: ReturnType<typeof useVimInput>

  function Probe() {
    const [value, setValue] = useState(initialValue)
    const [offset, setOffset] = useState(initialOffset)
    currentValue = value
    input = useVimInput({
      value,
      onChange: (next, cursor) => {
        changes.push([next, cursor])
        setValue(next)
      },
      onSubmit: () => {},
      onExitMessage: () => {},
      onClearInput: () => {},
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 80,
      externalOffset: offset,
      onOffsetChange: setOffset,
    })
    return null
  }

  const instance = await render(
    <AppStoreContext value={createStore(getDefaultAppState())}>
      <Probe />
    </AppStoreContext>,
    {
      stdout: new Output() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  )
  return {
    changes,
    async press(
      text: string,
      key: Partial<Key>,
      expected: { value: string; offset: number; mode: VimMode },
    ) {
      input.onInput(text, key as Key)
      const snapshot = () => ({
        value: currentValue,
        offset: input.offset,
        mode: input.mode,
      })
      const deadline = Date.now() + 2000
      while (
        (currentValue !== expected.value ||
          input.offset !== expected.offset ||
          input.mode !== expected.mode) &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(snapshot()).toEqual(expected)
    },
    get visualAnchor() {
      return input.visualAnchor
    },
    close() {
      instance.unmount()
      instance.cleanup()
    },
  }
}

test('NORMAL x and dot-repeat pass the current cursor to onChange', async () => {
  const h = await mountInput('abcd', 2)
  try {
    await h.press(
      '',
      { escape: true },
      { value: 'abcd', offset: 1, mode: 'NORMAL' },
    )
    await h.press('x', {}, { value: 'acd', offset: 1, mode: 'NORMAL' })
    expect(h.changes).toEqual([['acd', 1]])

    await h.press('.', {}, { value: 'ad', offset: 1, mode: 'NORMAL' })
    expect(h.changes).toEqual([
      ['acd', 1],
      ['ad', 1],
    ])

    await h.press('.', {}, { value: 'a', offset: 0, mode: 'NORMAL' })
    expect(h.changes).toEqual([
      ['acd', 1],
      ['ad', 1],
      ['a', 1],
    ])
  } finally {
    h.close()
  }
})

test('insert dot-repeat passes the resulting cursor to onChange', async () => {
  const h = await mountInput('ab', 1)
  try {
    await h.press('X', {}, { value: 'aXb', offset: 2, mode: 'INSERT' })
    expect(h.changes).toEqual([['aXb', 2]])
    await h.press(
      '',
      { escape: true },
      { value: 'aXb', offset: 1, mode: 'NORMAL' },
    )
    await h.press('.', {}, { value: 'aXXb', offset: 2, mode: 'NORMAL' })
    expect(h.changes).toEqual([
      ['aXb', 2],
      ['aXXb', 2],
    ])
  } finally {
    h.close()
  }
})

async function normalAt(value: string, offset: number) {
  const h = await mountInput(value, offset + 1)
  await h.press('', { escape: true }, { value, offset, mode: 'NORMAL' })
  return h
}

test('% jumps between matching brackets and works as an operator motion', async () => {
  const h = await normalAt('f(a[b]c) z', 0)
  try {
    await h.press('%', {}, { value: 'f(a[b]c) z', offset: 7, mode: 'NORMAL' })
    await h.press('%', {}, { value: 'f(a[b]c) z', offset: 1, mode: 'NORMAL' })
    await h.press('d', {}, { value: 'f(a[b]c) z', offset: 1, mode: 'NORMAL' })
    await h.press('%', {}, { value: 'f z', offset: 1, mode: 'NORMAL' })
    await h.press('%', {}, { value: 'f z', offset: 1, mode: 'NORMAL' })
  } finally {
    h.close()
  }
})

test('visual mode selects with motions and deletes the inclusive range', async () => {
  const h = await normalAt('hello world', 0)
  try {
    await h.press('v', {}, { value: 'hello world', offset: 0, mode: 'VISUAL' })
    expect(h.visualAnchor).toBe(0)
    await h.press('e', {}, { value: 'hello world', offset: 4, mode: 'VISUAL' })
    await h.press('d', {}, { value: ' world', offset: 0, mode: 'NORMAL' })
    expect(h.visualAnchor).toBeNull()
    await h.press('P', {}, { value: 'hello world', offset: 4, mode: 'NORMAL' })
  } finally {
    h.close()
  }
})

test('visual mode o swaps ends, U uppercases, and Esc leaves the text alone', async () => {
  const h = await normalAt('abc def', 4)
  try {
    await h.press('v', {}, { value: 'abc def', offset: 4, mode: 'VISUAL' })
    await h.press('l', {}, { value: 'abc def', offset: 5, mode: 'VISUAL' })
    await h.press('o', {}, { value: 'abc def', offset: 4, mode: 'VISUAL' })
    expect(h.visualAnchor).toBe(5)
    await h.press('U', {}, { value: 'abc DEf', offset: 4, mode: 'NORMAL' })
    await h.press('v', {}, { value: 'abc DEf', offset: 4, mode: 'VISUAL' })
    await h.press('', { escape: true }, { value: 'abc DEf', offset: 4, mode: 'NORMAL' })
  } finally {
    h.close()
  }
})

test('visual line mode yanks whole lines and V toggles back to NORMAL', async () => {
  const h = await normalAt('one\ntwo\nthree', 5)
  try {
    await h.press('V', {}, { value: 'one\ntwo\nthree', offset: 5, mode: 'VISUAL LINE' })
    await h.press('y', {}, { value: 'one\ntwo\nthree', offset: 4, mode: 'NORMAL' })
    await h.press('p', {}, { value: 'one\ntwo\ntwo\nthree', offset: 8, mode: 'NORMAL' })
    await h.press('V', {}, { value: 'one\ntwo\ntwo\nthree', offset: 8, mode: 'VISUAL LINE' })
    await h.press('V', {}, { value: 'one\ntwo\ntwo\nthree', offset: 8, mode: 'NORMAL' })
  } finally {
    h.close()
  }
})

test('visual line delete of the last line lands on the previous first non-blank', async () => {
  const h = await normalAt('  one\ntwo', 7)
  try {
    await h.press('V', {}, { value: '  one\ntwo', offset: 7, mode: 'VISUAL LINE' })
    await h.press('d', {}, { value: '  one', offset: 2, mode: 'NORMAL' })
  } finally {
    h.close()
  }
})

test('visual text objects select a range and c changes it in INSERT', async () => {
  const h = await normalAt('say "hi there" now', 6)
  try {
    await h.press('v', {}, { value: 'say "hi there" now', offset: 6, mode: 'VISUAL' })
    await h.press('i', {}, { value: 'say "hi there" now', offset: 6, mode: 'VISUAL' })
    await h.press('"', {}, { value: 'say "hi there" now', offset: 12, mode: 'VISUAL' })
    expect(h.visualAnchor).toBe(5)
    await h.press('c', {}, { value: 'say "" now', offset: 5, mode: 'INSERT' })
    expect(h.visualAnchor).toBeNull()
  } finally {
    h.close()
  }
})
