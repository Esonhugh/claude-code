import { expect, spyOn, test } from 'bun:test'
import type { HookInput } from '../entrypoints/agentSdkTypes.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { StructuredIO } = await import('./structuredIO.js')

const hookInput = { hook_event_name: 'PreToolUse' } as HookInput

async function runCallback(answer: 'abort' | 'error') {
  const logged: unknown[][] = []
  const error = spyOn(console, 'error').mockImplementation((...args) => {
    logged.push(args)
  })
  const requestId = Promise.withResolvers<string>()
  const done = Promise.withResolvers<void>()
  const io = new StructuredIO({
    async *[Symbol.asyncIterator]() {
      if (answer === 'error') {
        yield `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: await requestId.promise, error: 'CB_BOOM' },
        })}\n`
      }
      await done.promise
    },
  })
  const sent: string[] = []
  void (async () => {
    for await (const message of io.outbound) {
      sent.push(message.type)
      if (message.type === 'control_request') requestId.resolve(message.request_id)
    }
  })()
  void (async () => {
    for await (const _ of io.structuredInput) {
      // drain
    }
  })()
  const timeout = new AbortController()
  try {
    const pending = io.createHookCallback('cb1', 1).callback(hookInput, null, timeout.signal)
    await requestId.promise
    if (answer === 'abort') timeout.abort()
    return { output: await pending, logged, sent }
  } finally {
    done.resolve()
    error.mockRestore()
  }
}

test('a timed-out hook callback is cancelled without writing to stderr, like 2.1.329', async () => {
  const { output, logged, sent } = await runCallback('abort')
  expect(output).toEqual({})
  expect(sent).toEqual(['control_request', 'control_cancel_request'])
  expect(logged).toEqual([])
})

test('a hook callback the host answers with an error is still reported', async () => {
  const { output, logged } = await runCallback('error')
  expect(output).toEqual({})
  expect(logged.map(args => args[0])).toEqual(['Error in hook callback cb1:'])
  expect(String(logged[0]![1])).toContain('CB_BOOM')
})
