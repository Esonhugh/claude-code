import { afterAll, expect, mock, test } from 'bun:test'

let analyzeArguments: unknown[] = []

mock.module('../../services/compact/microCompact.js', () => ({
  microcompactMessages: async (messages: unknown[]) => ({ messages }),
}))

mock.module('../../utils/analyzeContext.js', () => ({
  analyzeContextUsage: async (...args: unknown[]) => {
    analyzeArguments = args
    return { marker: true }
  },
}))

const { collectContextData } = await import('./context-noninteractive.js')

afterAll(() => mock.restore())

const context = {
  messages: [],
  getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
  options: {
    mainLoopModel: 'runtime-model',
    tools: [],
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
} as never

test('forwards summary detail and zero-column narrow width to the shared analyzer', async () => {
  const result = await collectContextData(context, {
    detail: 'summary',
    columns: 0,
  })

  expect(result).toEqual({ marker: true } as never)
  expect(analyzeArguments[5]).toBe(0)
  expect(analyzeArguments[9]).toEqual({ detail: 'summary', signal: undefined })
})

test('forwards cancellation to the shared analyzer', async () => {
  const controller = new AbortController()

  await collectContextData(context, { detail: 'full' }, controller.signal)

  expect(analyzeArguments[9]).toEqual({
    detail: 'full',
    signal: controller.signal,
  })
})

test('keeps existing calls on the full shared analyzer path', async () => {
  await collectContextData(context)

  expect(analyzeArguments[5]).toBeUndefined()
  expect(analyzeArguments[9]).toEqual({ detail: undefined, signal: undefined })
})
