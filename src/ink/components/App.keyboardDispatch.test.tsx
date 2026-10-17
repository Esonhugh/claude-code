import { expect, test } from 'bun:test'
import React, { useRef } from 'react'
import { Readable, Writable } from 'node:stream'
import { Box, render, useInput } from '../../ink.js'
import type { DOMElement } from '../dom.js'
import { KeyboardEvent } from '../events/keyboard-event.js'
import { dispatcher } from '../reconciler.js'

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

async function mount(consume: boolean) {
  const stdin = new Input(), stdout = new Output()
  const dom: string[] = [], legacy: string[] = []
  function Host() {
    const element = useRef<DOMElement>(null)
    useInput((_input, _key, event) => {
      if (event.input !== 'a') return
      const keydown = new KeyboardEvent(event.keypress)
      event.markKeyboardDispatched()
      dispatcher.dispatchDiscrete(element.current!, keydown)
      if (keydown.defaultPrevented) event.stopImmediatePropagation()
    }, { capture: true })
    useInput(input => { legacy.push(input) })
    return <Box ref={element} tabIndex={0} autoFocus onKeyDown={event => {
      dom.push(event.key)
      if (consume && event.key === 'a') event.preventDefault()
    }} />
  }
  const instance = await render(<Host />, {
    stdin: stdin as never, stdout: stdout as never, stderr: stdout as never,
    patchConsole: false, exitOnCtrlC: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  return { dom, legacy,
    async send(text: string) {
      const count = dom.length
      stdin.push(text)
      const deadline = Date.now() + 1000
      while (dom.length === count && Date.now() < deadline)
        await new Promise(resolve => setImmediate(resolve))
      expect(dom.length).toBeGreaterThan(count)
    },
    close() { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy() },
  }
}

test('actual App delivers an early unhandled DOM key once and still lets the legacy editor receive it', async () => {
  const h = await mount(false)
  try {
    await h.send('a')
    await h.send('b')
    expect(h.dom).toEqual(['a', 'b'])
    expect(h.legacy).toEqual(['a', 'b'])
  } finally { h.close() }
})

test('a consumed early DOM key stays out of the legacy editor and the following key dispatches normally', async () => {
  const h = await mount(true)
  try {
    await h.send('a')
    await h.send('b')
    expect(h.dom).toEqual(['a', 'b'])
    expect(h.legacy).toEqual(['b'])
  } finally { h.close() }
})
