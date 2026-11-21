import { afterEach, expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { render, useInput } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { enqueue, enqueuePollEvent, resetCommandQueue } from '../utils/messageQueueManager.js'
import { CancelRequestHandler } from './useCancelRequest.js'

class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 100
  rows = 30
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { callback() }
}

afterEach(() => resetCommandQueue())

/** An idle prompt (no turn to cancel) with the cancel handler above a later key handler, as PromptInput is. */
async function idlePrompt() {
  const seen: string[] = []
  let popped = 0
  function Later() {
    useInput((input, key) => {
      if (key.escape) seen.push('escape')
      else if (key.ctrl && input === 'c') seen.push('ctrl+c')
    })
    return null
  }
  const stdin = new Input()
  const instance = await render(
    <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
      <KeybindingSetup>
        <CancelRequestHandler
          setToolUseConfirmQueue={() => {}}
          onCancel={() => {}}
          onAgentsKilled={() => {}}
          isMessageSelectorVisible={false}
          screen="prompt"
          popCommandFromQueue={() => void popped++}
          inputMode="prompt"
          inputValue=""
        />
        <Later />
      </KeybindingSetup>
    </AppStoreContext.Provider>,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: new Output() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
  )
  await new Promise(resolve => setTimeout(resolve, 50))
  return {
    seen,
    popped: () => popped,
    async press(bytes: string) { stdin.push(bytes); await new Promise(resolve => setTimeout(resolve, 200)) },
    close() { instance.unmount(); instance.cleanup() },
  }
}

test('a queued eval outcome leaves Ctrl-C and Esc to the idle prompt (official 2.1.329)', async () => {
  void enqueuePollEvent({ kind: 'repl-eval', element: '<event kind="repl-eval" eval="1" status="settled">\n<error>Interrupted</error>\n</event>', startsTurn: false })
  const h = await idlePrompt()
  try {
    await h.press('\u0003')
    await h.press('\u001b')
    expect(h.seen).toEqual(['ctrl+c', 'escape'])
    expect(h.popped()).toBe(0)
  } finally { h.close() }
})

test('a queued prompt is still pulled back by Esc', async () => {
  enqueue({ value: 'queued prompt', mode: 'prompt' })
  const h = await idlePrompt()
  try {
    await h.press('\u001b')
    expect(h.seen).toEqual([])
    expect(h.popped()).toBe(1)
  } finally { h.close() }
})
