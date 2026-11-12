import { expect, mock, test } from 'bun:test'
import type { CacheSafeParams } from '../forkedAgent.js'

const actual = await import('../../services/compact/compact.js')
let forkContextMessages: CacheSafeParams['forkContextMessages'] | undefined
mock.module('../../services/compact/compact.js', () => ({
  ...actual,
  compactConversation: async (_messages: unknown, _context: unknown, params: CacheSafeParams) => {
    forkContextMessages = params.forkContextMessages
    return {} as Awaited<ReturnType<typeof actual.compactConversation>>
  },
}))
const { compactTeammateHistory } = await import('./inProcessRunner.js')
const { createUserMessage } = await import('../messages.js')
const { FileStateCache } = await import('../fileStateCache.js')

test("a teammate's compaction summarizes its own history, not an empty conversation", async () => {
  const history = [createUserMessage({ content: 'teammate work so far' })]
  await compactTeammateHistory(history, { readFileState: new FileStateCache(10, 1024) } as never)
  expect(forkContextMessages).toEqual(history)
})
