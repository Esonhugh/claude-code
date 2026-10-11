import { expect, spyOn, test } from 'bun:test'
import { StructuredIO } from './structuredIO.js'
import { captureLaunchInitialize } from '../entrypoints/sdk/launchInitialize.js'

test('replayed launch input skips whitespace-only lines and retains initialize and Unicode user data', async () => {
  const initialize = { type: 'control_request', request_id: 'init', request: { subtype: 'initialize', plugins: [] } }
  const user = { type: 'user', session_id: '', message: { role: 'user', content: '尾部消息' }, parent_tool_use_id: null }
  async function* source() {
    yield '\n \r\n\t\n' + JSON.stringify(initialize) + '\n'
    yield '\n  \n' + JSON.stringify(user) // EOF without newline remains a valid SDK message.
  }
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected process.exit') })
  try {
    const capture = captureLaunchInitialize(source())
    expect((await capture.ready).kind).toBe('applied')
    const io = new StructuredIO(capture.input)
    const messages: unknown[] = []
    for await (const message of io.structuredInput) messages.push(message)
    expect(messages).toEqual([initialize, user])
    expect(exit).not.toHaveBeenCalled()
  } finally { exit.mockRestore() }
})
