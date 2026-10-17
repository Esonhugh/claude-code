import { expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { useState } from 'react'
import { render, type Key } from '../ink.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
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
      expected: { value: string; offset: number; mode: 'INSERT' | 'NORMAL' },
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
