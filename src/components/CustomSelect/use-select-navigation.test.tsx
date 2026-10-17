import { expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import render from '../../ink/root.js'
import { useSelectNavigation } from './use-select-navigation.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

async function captureInitialFocus<T>(
  values: T[],
  focusValue: T,
  initialFocusValue: T,
): Promise<T | undefined> {
  let focusedValue: T | undefined

  function Capture() {
    focusedValue = useSelectNavigation({
      options: values.map(value => ({ label: String(value), value })),
      focusValue,
      initialFocusValue,
    }).focusedValue
    return null
  }

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const instance = await render(<Capture />, {
    stdout: stdout as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    return focusedValue
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('preserves explicit falsy focus values during initialization', async () => {
  expect(await captureInitialFocus([1, 0], 0, 1)).toBe(0)
  expect(await captureInitialFocus(['fallback', ''], '', 'fallback')).toBe('')
})
