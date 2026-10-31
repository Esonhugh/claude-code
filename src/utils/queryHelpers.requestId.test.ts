import { expect, test } from 'bun:test'

import { createAssistantMessage } from './messages.js'
import { normalizeMessage } from './queryHelpers.js'

test('SDK assistant messages carry request_id and timestamp like SDK 0.3.311', () => {
  const message = { ...createAssistantMessage({ content: 'hi' }), requestId: 'req_011abc' }
  const [sdk] = [...normalizeMessage(message)]
  expect(sdk).toMatchObject({ type: 'assistant', request_id: 'req_011abc', timestamp: message.timestamp })
  const [plain] = [...normalizeMessage(createAssistantMessage({ content: 'hi' }))]
  expect(plain).not.toHaveProperty('request_id')
})
