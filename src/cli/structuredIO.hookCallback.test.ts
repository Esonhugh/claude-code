import { expect, spyOn, test } from 'bun:test'
import type { HookInput } from '../entrypoints/agentSdkTypes.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { StructuredIO } = await import('./structuredIO.js')

const input = { hook_event_name: 'PreToolUse' } as HookInput

// Sends one hook_callback and lets `answer` play the SDK host.
async function callHost(
  onFailure: 'block' | undefined,
  answer: (io: InstanceType<typeof StructuredIO>, requestId: string) => void,
  signal = new AbortController().signal,
) {
  const io = new StructuredIO({ async *[Symbol.asyncIterator]() {} })
  const write = spyOn(io, 'write').mockResolvedValue(undefined)
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const outbound = io.outbound[Symbol.asyncIterator]()
    const pending = io
      .createHookCallback('cb1', undefined, onFailure)
      .callback(input, 'tool-id', signal)
    const sent = (await outbound.next()).value as { request_id: string }
    answer(io, sent.request_id)
    return await pending
  } finally {
    write.mockRestore()
    error.mockRestore()
  }
}
const hostError = (io: InstanceType<typeof StructuredIO>, requestId: string) =>
  io.injectControlResponse({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: 'HOOK_BOOM' },
  })

// Official 2.1.329: a failed SDK hook callback blocks when its matcher says so.
test('a host error fails the callback when onFailure is block', async () => {
  await expect(callHost('block', hostError)).rejects.toThrow(
    'Hook callback cb1 failed: the SDK host replied with an error or an invalid answer.',
  )
})

test('a host error stays "no opinion" without onFailure', async () => {
  expect(await callHost(undefined, hostError)).toEqual({})
})

test('an unanswered callback rejects once its signal aborts', async () => {
  for (const onFailure of [undefined, 'block'] as const) {
    const controller = new AbortController()
    await expect(
      callHost(onFailure, () => controller.abort(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  }
})
