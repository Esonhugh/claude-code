import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { render } from '../../../ink.js'
import { TOOL_CALL_INTERRUPTED_MESSAGE } from '../../../utils/messages.js'
import { UserToolErrorMessage } from './UserToolErrorMessage.js'

test('a tool call the session ended on reads as interrupted', async () => {
  const stdin = new PassThrough()
  let frame = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frame += chunk.toString()
      callback()
    },
  })
  Object.assign(stdout, { columns: 100, rows: 24, isTTY: false })
  Object.assign(stdin, { isTTY: false, setRawMode() {}, ref() {}, unref() {} })
  const app = await render(
    <UserToolErrorMessage
      progressMessagesForMessage={[]}
      tools={[]}
      param={{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: TOOL_CALL_INTERRUPTED_MESSAGE,
      }}
      verbose={false}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(frame).toContain('Interrupted')
    expect(frame).not.toContain('Tool call interrupted')
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})
