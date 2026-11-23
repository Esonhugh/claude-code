import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import React, { createRef } from 'react'
import stripAnsi from 'strip-ansi'

const configDir = mkdtempSync(join(tmpdir(), 'messages-show-all-test-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const { ThemeProvider, render } = await import('../ink.js')
const { default: ScrollBox } = await import('../ink/components/ScrollBox.js')
type ScrollBoxHandle = import('../ink/components/ScrollBox.js').ScrollBoxHandle
const { AppStoreContext, getDefaultAppState } = await import('../state/AppState.js')
const { createStore } = await import('../state/store.js')
const { createUserMessage } = await import('../utils/messages.js')
const { Messages } = await import('./Messages.js')

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

class Output extends Writable {
  columns = 80
  rows = 200
  isTTY = false
  output = ''

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

const messages = Array.from({ length: 40 }, (_, i) => createUserMessage({ content: `prompt ${i}` }))

async function transcript(virtual: boolean): Promise<string> {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const list = (
    <Messages
      messages={messages}
      tools={[]}
      commands={[]}
      verbose={false}
      toolJSX={null}
      toolUseConfirmQueue={[]}
      inProgressToolUseIDs={new Set()}
      isMessageSelectorVisible={false}
      conversationId="test"
      screen="transcript"
      streamingToolUses={[]}
      showAllInTranscript
      hideLogo
      isLoading={false}
      scrollRef={virtual ? scrollRef : undefined}
    />
  )
  const instance = await render(
    <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
      <ThemeProvider>
        {virtual ? (
          <ScrollBox ref={scrollRef} width={80} height={200} flexDirection="column" stickyScroll>
            {list}
          </ScrollBox>
        ) : (
          list
        )}
      </ThemeProvider>
    </AppStoreContext.Provider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
  )
  try {
    const deadline = performance.now() + 10_000
    while (!stripAnsi(stdout.output).includes('prompt 39') && performance.now() < deadline) await Bun.sleep(10)
    return stripAnsi(stdout.output)
  } finally {
    instance.unmount()
    instance.cleanup()
    stdout.destroy()
  }
}

test('ctrl+e in the capped transcript offers to hide the earlier messages again', async () => {
  const text = await transcript(false)
  expect(text).toContain('prompt 39')
  expect(text).toContain('to hide 10 previous messages')
})

test('the fullscreen transcript hides nothing, so ctrl+e (Code Mode scripts) draws no hide divider', async () => {
  const text = await transcript(true)
  expect(text).toContain('prompt 39')
  expect(text).not.toContain('previous messages')
})
