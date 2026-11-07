import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetStateForTests } from '../../bootstrap/state.js'
import type { LogOption } from '../../types/logs.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import * as storage from '../../utils/sessionStorage.js'
import { call } from './branch.js'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  resetStateForTests()
  storage.resetProjectForTesting()
})
afterEach(async () => {
  await storage.flushSessionStorage()
  storage.resetProjectForTesting()
  resetStateForTests()
  if (saved === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = saved
})

test('/branch after /rewind leaves the rewound messages out of the branch', async () => {
  const first = createUserMessage({ content: 'first msg' })
  const firstReply = createAssistantMessage({ content: 'ok1' })
  const second = createUserMessage({ content: 'second msg' })
  const secondReply = createAssistantMessage({ content: 'ok2' })
  await storage.recordTranscript([first, firstReply, second, secondReply])
  // Rewound to before "first msg", then a new prompt.
  const redo = createUserMessage({ content: 'redo' })
  const redoReply = createAssistantMessage({ content: 'ok3' })
  await storage.recordTranscript([redo, redoReply])
  await storage.flushSessionStorage()

  let log: LogOption | undefined
  await call(
    () => {},
    {
      messages: [redo, redoReply],
      resume: async (_id: string, l: LogOption) => {
        log = l
      },
    } as unknown as Parameters<typeof call>[1],
    '',
  )
  expect(log).toBeDefined()
  const reread = await storage.loadTranscriptFromFile(log!.fullPath!)
  const texts = reread.messages.flatMap(m =>
    m.type === 'user' || m.type === 'assistant'
      ? [
          typeof m.message.content === 'string'
            ? m.message.content
            : m.message.content.map(b => ('text' in b ? b.text : b.type)).join(''),
        ]
      : [],
  )
  expect(texts).toEqual(['redo', 'ok3'])
})
