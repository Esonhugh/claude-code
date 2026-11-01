import { expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const realSideQuestion = await import('../../utils/sideQuestion.js')
mock.module('../../utils/sideQuestion.js', () => ({
  ...realSideQuestion,
  runSideQuestion: async ({ question }: { question: string }) => ({ response: `answer to ${question}` }),
}))
const realForkedAgent = await import('../../utils/forkedAgent.js')
mock.module('../../utils/forkedAgent.js', () => ({
  ...realForkedAgent,
  getLastCacheSafeParams: () => ({ systemPrompt: [], userContext: {}, systemContext: {} }),
}))

const { render } = await import('../../ink.js')
const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
const { AppStateProvider } = await import('../../state/AppState.js')
const { call } = await import('./btw.js')
const { forkNameFromDirective } = await import('../../tools/AgentTool/spawnForkFromDirective.js')

async function ask(question: string) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const context = { messages: [], options: {} } as never
  const node = await call(() => {}, context, question)
  const instance = await render(
    <AppStateProvider><KeybindingSetup>{node}</KeybindingSetup></AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  await new Promise(resolve => setTimeout(resolve, 100))
  const lines = stripAnsi(output).split('\n')
  instance.unmount()
  return lines.slice(lines.findLastIndex(line => line.includes('/btw')) - 3).join('\n')
}

test('/btw offers copy and fork like 2.1.311, and keeps earlier side questions', async () => {
  const first = await ask('first question')
  expect(first).toContain('answer to first question')
  expect(first).toContain('↑/↓ to scroll · c to copy · f to fork · Esc to close')

  const second = await ask('second question')
  expect(second).toContain('/btw first question')
  expect(second).toContain('⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close')
})

test('a fork is named after the first words of its directive', () => {
  expect(forkNameFromDirective('What does parseArgs() do here?')).toBe('what-does-parseargs')
  expect(forkNameFromDirective('???')).toBe('fork')
})
