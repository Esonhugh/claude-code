import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { render } from '../../ink.js'
import type { AdvisorBlock } from '../../utils/advisor.js'
import { AdvisorMessage } from './AdvisorMessage.js'

async function frameOf(block: AdvisorBlock, verbose = false): Promise<string> {
  const stdin = new PassThrough()
  let frame = ''
  const stdout = new Writable({ write(chunk, _encoding, callback) { frame += chunk.toString(); callback() } })
  Object.assign(stdout, { columns: 100, rows: 24, isTTY: false })
  Object.assign(stdin, { isTTY: false, setRawMode() {}, ref() {}, unref() {} })
  const app = await render(
    <AdvisorMessage block={block} addMargin={false} resolvedToolUseIDs={new Set(['t1'])} erroredToolUseIDs={new Set()}
      shouldAnimate={false} verbose={verbose} advisorModel="claude-opus-4-6" />,
    { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false },
  )
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    return frame
  } finally { app.unmount(); stdin.destroy(); stdout.destroy() }
}

const result = (content: object) =>
  ({ type: 'advisor_tool_result', tool_use_id: 't1', content }) as AdvisorBlock

test('advisor transcript states', async () => {
  const advising = await frameOf({ type: 'server_tool_use', id: 't1', name: 'advisor', input: {} })
  expect(advising).toContain('Advising')
  expect(advising).toContain('using Opus 4.6')

  const reviewed = await frameOf(result({ type: 'advisor_result', text: 'Check the lockfile first.' }))
  expect(reviewed).toContain('Advisor has reviewed the conversation and will apply the feedback')
  expect(reviewed).toContain('ctrl+o')
  expect(reviewed).not.toContain('Check the lockfile first.')
  expect(await frameOf(result({ type: 'advisor_result', text: 'Check the lockfile first.' }), true)).toContain('Check the lockfile first.')

  const redacted = await frameOf(result({ type: 'advisor_redacted_result', encrypted_content: 'x' }))
  expect(redacted).toContain('Advisor has reviewed the conversation')
  expect(redacted).not.toContain('ctrl+o')

  expect(await frameOf(result({ type: 'advisor_tool_result_error', error_code: 'overloaded' }))).toContain('Advisor unavailable (overloaded)')
  expect(await frameOf(result({ type: 'advisor_tool_result_error', error_code: 'model_not_found' }))).toContain('Advisor unavailable (unknown)')
})

test('advisor refusals read as declined', async () => {
  const declined = result({ type: 'advisor_result', text: 'Not something I can help with.', stop_reason: 'refusal' })
  const collapsed = await frameOf(declined)
  expect(collapsed).toContain('Advisor declined to advise on this request')
  expect(collapsed).toContain('ctrl+o')
  expect(collapsed).not.toContain('Not something I can help with.')
  expect(await frameOf(declined, true)).toContain('Not something I can help with.')
  const silent = await frameOf(result({ type: 'advisor_redacted_result', encrypted_content: 'x', stop_reason: 'refusal' }))
  expect(silent).toContain('Advisor declined to advise on this request')
  expect(silent).not.toContain('ctrl+o')
})

test('unknown advisor content renders nothing', async () => {
  expect((await frameOf(result({ type: 'advisor_future_result' }))).trim()).toBe('')
})
