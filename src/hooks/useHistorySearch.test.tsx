import { expect, mock, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { act, useState } from 'react'
import render from '../ink/root.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestReader = AsyncGenerator<never>

let startSearch: (() => void) | undefined
let reader: (TestReader & { return: ReturnType<typeof mock> }) | undefined

mock.module('../history.js', () => ({
  makeHistoryReader: () => {
    const candidate = {
      next: mock(async () => ({ done: true as const, value: undefined })),
      return: mock(async () => ({ done: true as const, value: undefined })),
      throw: mock(async (error: unknown) => { throw error }),
      [Symbol.asyncIterator]() {
        return this
      },
    } as TestReader & { return: ReturnType<typeof mock> }
    reader = candidate
    return candidate
  },
}))

mock.module('../keybindings/useKeybinding.js', () => ({
  useKeybinding: (action: string, handler: () => void) => {
    if (action === 'history:search') startSearch = handler
  },
  useKeybindings: () => {},
}))

mock.module('../ink.js', () => ({ useInput: () => {} }))

const { useHistorySearch } = await import('./useHistorySearch.js')

test('closes the history reader when the hook unmounts', async () => {
  function Probe() {
    const [isSearching, setIsSearching] = useState(false)
    useHistorySearch(
      () => {},
      '',
      () => {},
      () => {},
      0,
      () => {},
      'prompt',
      isSearching,
      setIsSearching,
      () => {},
      {},
    )
    return null
  }

  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  let instance!: Awaited<ReturnType<typeof render>>
  await act(async () => {
    instance = await render(React.createElement(Probe), {
      stdout: stdout as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
  })

  try {
    await act(async () => { startSearch?.() })
    expect(reader).toBeDefined()
    await act(async () => { instance.unmount() })
    expect(reader?.return).toHaveBeenCalledWith(undefined)
  } finally {
    instance.cleanup()
  }
})
