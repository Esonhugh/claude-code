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
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    done()
  }
}

async function runChunk(
  chunk: string | Buffer[] | ((stdin: Input) => Promise<void>),
  expectedValue?: string,
  resolveChange?: (
    value: string,
  ) => string | { value: string; cursorOffset: number; accepted?: boolean },
  initialValue = '',
) {
  const stdin = new Input()
  const stdout = new Output()
  const submitted: string[] = []
  const exitMessages: Array<{ show: boolean; key?: string }> = []
  const cleared: string[] = []
  const changes: string[] = []
  const store = createStore(getDefaultAppState())
  let currentValue = initialValue

  function Probe() {
    const [value, setValue] = useState(initialValue)
    currentValue = value
    const [offset, setOffset] = useState(initialValue.length)
    const input = useTextInput({
      value,
      onChange: next => {
        changes.push(next)
        const resolved = resolveChange?.(next) ?? next
        setValue(typeof resolved === 'string' ? resolved : resolved.value)
        return resolved
      },
      onSubmit: next => submitted.push(next),
      onExitMessage: (show, key) => exitMessages.push({ show, key }),
      onClearInput: () => cleared.push(currentValue),
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 80,
      externalOffset: offset,
      onOffsetChange: setOffset,
    })
    useInput(input.onInput)
    return <Text>{value}</Text>
  }

  const instance = await render(
    <AppStoreContext value={store}>
      <Probe />
    </AppStoreContext>,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  if (typeof chunk === 'function') await chunk(stdin)
  else if (typeof chunk === 'string') stdin.push(chunk)
  else for (const part of chunk) stdin.push(part)
  for (let index = 0; index < 6; index++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  const deadline = Date.now() + 2000
  while (
    expectedValue !== undefined &&
    currentValue !== expectedValue &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setImmediate(resolve))
  }
  if (expectedValue !== undefined) expect(currentValue).toBe(expectedValue)
  else await new Promise(resolve => setImmediate(resolve))
  instance.unmount()
  instance.cleanup()
  return {
    submitted,
    exitMessages,
    cleared,
    changes,
    notification: store.getState().notifications.current,
    value: currentValue,
  }
}

test('PageUp does not move the composer cursor before Ctrl-U', async () => {
  const result = await runChunk('\u001b[5~\x15xyz', 'xyz', undefined, '/diff')

  expect(result.value).toBe('xyz')
})

test('submits Chinese text received with Enter in one stdin chunk', async () => {
  expect((await runChunk('中文\r')).submitted).toEqual(['中文'])
})

test('applies backspace before submitting a Chinese same-chunk edit', async () => {
  expect((await runChunk('中文\x7f\r')).submitted).toEqual(['中'])
})

test('starts a fresh draft after Enter within the same stdin chunk', async () => {
  expect((await runChunk('a\rb', 'b')).submitted).toEqual(['a'])
})

test('does not submit a same-chunk edit rejected by the controlled input', async () => {
  const result = await runChunk('?\r', '', value =>
    value.includes('?')
      ? { value: value.replaceAll('?', ''), cursorOffset: 0, accepted: false }
      : value,
  )

  expect(result.submitted).toEqual([])
})

test('uses the controlled cursor after a same-chunk edit is expanded', async () => {
  const result = await runChunk('a\x7f\r', 'X', value =>
    value === 'a' ? { value: 'XY', cursorOffset: 2 } : value,
  )

  expect(result.submitted).toEqual(['X'])
})

test('submits a same-chunk edit transformed by the controlled input', async () => {
  const result = await runChunk('a\r', 'A', value => ({
    value: value.toUpperCase(),
    cursorOffset: value.length,
  }))

  expect(result.submitted).toEqual(['A'])
})

test('Ctrl-C clears a preceding same-chunk edit instead of entering empty-input exit state', async () => {
  const result = await runChunk('abc\x03', '')

  expect(result.changes).toEqual(['abc', ''])
  expect(result.exitMessages).toEqual([])
})

test('Escape observes a preceding same-chunk edit', async () => {
  const result = await runChunk('abc\x1b[27u', 'abc')

  expect(result.cleared).toEqual([])
  expect(result.notification).toMatchObject({ text: 'Esc again to clear' })
})

test('double Escape clears the latest same-chunk controlled value', async () => {
  const result = await runChunk(
    '?\x1b[27u\x1b[27u',
    '',
    value => (value === '?' ? 'converted' : value),
  )

  expect(result.changes).toEqual(['?', ''])
  expect(result.cleared).toEqual([''])
})

test('Ctrl-D does not enter empty-input exit state after a same-chunk edit', async () => {
  const result = await runChunk('abc\x04', 'abc')

  expect(result.exitMessages).toEqual([])
})

test('Ctrl-D enters empty-input exit state after a same-chunk deletion', async () => {
  const result = await runChunk('\x7f\x04', '', undefined, 'a')

  expect(result.exitMessages).toContainEqual({ show: true, key: 'Ctrl-D' })
})

test('inserts split UTF-8 Chinese bytes without replacement characters', async () => {
  const bytes = Buffer.from('中文')
  expect(
    (
      await runChunk(
        [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)],
        '中文',
      )
    ).submitted,
  ).toEqual([])
})

test('recovers text from an unterminated bracketed paste', async () => {
  expect((await runChunk('\x1b[200~中文', '中文')).submitted).toEqual([])
})

test('returns to ordinary input after an unterminated bracketed paste recovery', async () => {
  expect(
    (
      await runChunk(async stdin => {
        stdin.push('\x1b[200~中文')
        await new Promise(resolve => setTimeout(resolve, 1100))
        stdin.push('继续\r')
      }, '中文继续')
    ).submitted,
  ).toEqual(['中文继续'])
})

test('paste recovery expires despite a continuing input stream', async () => {
  expect(
    (
      await runChunk(async stdin => {
        stdin.push('\x1b[200~开')
        await new Promise(resolve => setTimeout(resolve, 550))
        for (const part of ['始', '输', '入', '流']) {
          stdin.push(part)
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        stdin.push('\r')
        await new Promise(resolve => setTimeout(resolve, 100))
      }, '开始输入流')
    ).submitted,
  ).toEqual(['开始输入流'])
})

test('keeps delayed paste control bytes literal before returning to ordinary input', async () => {
  expect(
    (
      await runChunk(async stdin => {
        stdin.push('\x1b[200~中文')
        await new Promise(resolve => setTimeout(resolve, 600))
        stdin.push('\r\t后续')
        await new Promise(resolve => setTimeout(resolve, 600))
        stdin.push('完成\r')
      }, '中文\n\t后续完成')
    ).submitted,
  ).toEqual(['中文\n\t后续完成'])
})
