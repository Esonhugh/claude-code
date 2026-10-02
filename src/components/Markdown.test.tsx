import { Writable } from 'node:stream'
import { expect, spyOn, test } from 'bun:test'
import { marked } from 'marked'
import React from 'react'
import stripAnsi from 'strip-ansi'
import render from '../ink/root.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { enableConfigs } from '../utils/config.js'
import { ThemeProvider } from './design-system/ThemeProvider.js'
import { Markdown, StreamingMarkdown } from './Markdown.js'

enableConfigs()

class Output extends Writable {
  columns = 120
  rows = 1000
  isTTY = false
  output = ''

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

function fixture(children: React.ReactNode) {
  const state = getDefaultAppState()
  const store = createStore({
    ...state,
    settings: { ...state.settings, syntaxHighlightingDisabled: true },
  })
  return (
    <ThemeProvider initialState="dark">
      <AppStoreContext.Provider value={store}>
        {children}
      </AppStoreContext.Provider>
    </ThemeProvider>
  )
}

test('streaming a completed block does not re-lex the accumulated prefix', async () => {
  const stdout = new Output()
  const lexer = spyOn(marked, 'lexer')
  const prefix = Array.from(
    { length: 40 },
    (_, index) => `Completed **block ${index}**.\n\n`,
  ).join('')
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    instance = await render(
      fixture(<StreamingMarkdown>{prefix + 'Current tail'}</StreamingMarkdown>),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    )
    await waitFor(() => stripAnsi(stdout.output).includes('Current tail'))
    lexer.mockClear()
    stdout.output = ''
    instance.rerender(
      fixture(
        <StreamingMarkdown>
          {prefix + 'Current tail complete.\n\nNext tail'}
        </StreamingMarkdown>,
      ),
    )
    await waitFor(() => stripAnsi(stdout.output).includes('Next tail'))
    expect(lexer.mock.calls.length).toBeGreaterThan(0)
    expect(
      lexer.mock.calls.every(
        ([text]) => !text.includes('Completed **block 0**'),
      ),
    ).toBe(true)
  } finally {
    lexer.mockRestore()
    instance?.unmount()
    instance?.cleanup()
    stdout.destroy()
  }
})

test.each([
  ['paragraphs', 'First **paragraph**.\n\n', 'Second *paragraph*.\n\n'],
  [
    'code and list',
    '```typescript\nconst n = 1\n```\n\n',
    '- first\n- second\n\n',
  ],
  ['table', '| A | B |\n| - | - |\n| 1 | 2 |\n\n', 'After table.\n\n'],
  [
    'reference definition',
    '[label][target]\n\n',
    '[target]: https://example.com\n\n',
  ],
  [
    'earlier reference definition',
    '[target]: https://example.com\n\n',
    '[label][target]\n\n',
  ],
])(
  'streamed %s preserve final Markdown output',
  async (_name, first, second) => {
    const streamed = new Output()
    const full = new Output()
    const instance = await render(
      fixture(<StreamingMarkdown>{first + 'Growing'}</StreamingMarkdown>),
      {
        stdout: streamed as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    )
    let reference: Awaited<ReturnType<typeof render>> | undefined
    try {
      await waitFor(() => stripAnsi(streamed.output).includes('Growing'))
      streamed.output = ''
      const text = first + second + 'Final tail'
      instance.rerender(fixture(<StreamingMarkdown>{text}</StreamingMarkdown>))
      await waitFor(() => stripAnsi(streamed.output).includes('Final tail'))
      reference = await render(fixture(<Markdown>{text}</Markdown>), {
        stdout: full as unknown as NodeJS.WriteStream,
        patchConsole: false,
      })
      await waitFor(() => stripAnsi(full.output).includes('Final tail'))
      expect(stripAnsi(streamed.output).trim()).toBe(
        stripAnsi(full.output).trim(),
      )
      streamed.output = ''
      instance.rerender(
        fixture(<StreamingMarkdown>Replacement **text**</StreamingMarkdown>),
      )
      await waitFor(() =>
        stripAnsi(streamed.output).includes('Replacement text'),
      )
      expect(stripAnsi(streamed.output)).not.toContain('Final tail')
    } finally {
      instance.unmount()
      instance.cleanup()
      reference?.unmount()
      reference?.cleanup()
      streamed.destroy()
      full.destroy()
    }
  },
)
