import { afterEach, expect, mock, test } from 'bun:test'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'

const recorded: QueueOperationMessage[] = []
const actual = { ...(await import('./sessionStorage.js')) }
mock.module('./sessionStorage.js', () => ({
  ...actual,
  recordQueueOperation: async (op: QueueOperationMessage) => { recorded.push(op) },
}))
const { clearCommandQueue, enqueue, setQueueRecordRewriter } = await import('./messageQueueManager.js')

afterEach(() => {
  setQueueRecordRewriter(undefined)
  clearCommandQueue()
  recorded.length = 0
})

test('a queue record keeps the rewriter text and records stay in order while one waits', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const origins: unknown[] = []
  setQueueRecordRewriter((text, origin) => {
    origins.push(origin)
    return text === 'first' ? gate.then(() => 'FIRST') : undefined
  })
  enqueue({ value: 'first', mode: 'prompt', origin: { kind: 'human' } })
  enqueue({ value: 'second', mode: 'prompt' })
  await Promise.resolve()
  expect(recorded).toEqual([])
  release()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(recorded.map(op => op.content)).toEqual(['FIRST', 'second'])
  expect(origins).toEqual([{ kind: 'human' }, undefined])
})

test('a failed rewrite keeps the record as made', async () => {
  setQueueRecordRewriter(() => Promise.reject(new Error('hook failed')))
  enqueue({ value: 'kept', mode: 'prompt' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(recorded.map(op => op.content)).toEqual(['kept'])
})
