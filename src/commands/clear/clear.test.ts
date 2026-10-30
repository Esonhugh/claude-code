import { expect, mock, test } from 'bun:test'

const titles: Array<[string, string]> = []
const order: string[] = []
const sessionStorage = await import('../../utils/sessionStorage.js')
const conversation = await import('./conversation.js')
mock.module('../../utils/sessionStorage.js', () => ({
  ...sessionStorage,
  getTranscriptPath: () => '/tmp/old.jsonl',
  saveCustomTitle: async (sessionId: string, title: string) => {
    titles.push([sessionId, title])
    order.push('title')
  },
}))
mock.module('./conversation.js', () => ({
  ...conversation,
  clearConversation: async () => {
    order.push('clear')
  },
}))

const { getSessionId } = await import('../../bootstrap/state.js')
const { call } = await import('./clear.js')
const clear = (await import('./index.js')).default

test('/clear <name> names the session being left before starting a new one, like 2.1.311', async () => {
  const oldSession = getSessionId()
  expect(await call('  Foo Bar ', {} as never)).toEqual({ type: 'text', value: '' })
  expect(titles).toEqual([[oldSession, 'Foo Bar']])
  expect(order).toEqual(['title', 'clear'])

  await call('', {} as never)
  expect(titles).toHaveLength(1)
  expect(clear.argumentHint).toBe('[name]')
  expect(clear.supportsNonInteractive).toBe(true)
})
