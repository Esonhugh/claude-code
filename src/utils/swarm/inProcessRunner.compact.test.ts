import { expect, mock, test } from 'bun:test'
import type { CacheSafeParams } from '../forkedAgent.js'

const actual = await import('../../services/compact/compact.js')
let forkContextMessages: CacheSafeParams['forkContextMessages'] | undefined
mock.module('../../services/compact/compact.js', () => ({
  ...actual,
  compactConversation: async (_messages: unknown, _context: unknown, params: CacheSafeParams) => {
    forkContextMessages = params.forkContextMessages
    return { attachments: [
      { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['Goal', 'WebFetch'], addedLines: ['Goal', 'WebFetch'], removedNames: [] } },
      { type: 'attachment', attachment: { type: 'plan_mode' } },
    ] } as unknown as Awaited<ReturnType<typeof actual.compactConversation>>
  },
}))
const { compactTeammateHistory } = await import('./inProcessRunner.js')
const { createUserMessage } = await import('../messages.js')
const { FileStateCache } = await import('../fileStateCache.js')

test("a teammate's compaction summarizes its own history and re-announces only the tools it was told", async () => {
  const told = { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch'], addedLines: ['WebFetch'], removedNames: [] } }
  const history = [createUserMessage({ content: 'teammate work so far' }), told] as never[]
  const { WebFetchTool } = await import('../../tools/WebFetchTool/WebFetchTool.js')
  const context = { readFileState: new FileStateCache(10, 1024), options: { tools: [WebFetchTool, { name: 'Goal' }] } }
  const result = await compactTeammateHistory(history, context as never)
  expect(forkContextMessages).toEqual(history)
  // Compaction announced Goal from the base tool pool; the teammate never had it.
  expect(result.attachments.map(message => message.attachment) as unknown[]).toEqual([
    { type: 'deferred_tools_delta', addedNames: ['WebFetch'], addedLines: expect.any(Array), removedNames: [] },
    { type: 'plan_mode' },
  ])
})
