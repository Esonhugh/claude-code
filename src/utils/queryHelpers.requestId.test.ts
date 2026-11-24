import { expect, test } from 'bun:test'

import { createAssistantAPIErrorMessage, createAssistantMessage } from './messages.js'
import { normalizeMessage } from './queryHelpers.js'

test('SDK assistant messages carry request_id and timestamp like SDK 0.3.311', () => {
  const message = { ...createAssistantMessage({ content: 'hi' }), requestId: 'req_011abc' }
  const [sdk] = [...normalizeMessage(message)]
  expect(sdk).toMatchObject({ type: 'assistant', request_id: 'req_011abc', timestamp: message.timestamp })
  const [plain] = [...normalizeMessage(createAssistantMessage({ content: 'hi' }))]
  expect(plain).not.toHaveProperty('request_id')
})

test('the assistant row of an API error says so and carries its status, type and code (official 2.1.329)', () => {
  const message = {
    ...createAssistantAPIErrorMessage({ content: 'API Error: 400 fake 400', error: 'invalid_request' }),
    apiErrorStatus: 400,
    apiErrorType: 'invalid_request_error',
    apiErrorCode: 'some_code',
  }
  const [sdk] = [...normalizeMessage(message)]
  expect(sdk).toMatchObject({
    type: 'assistant',
    is_api_error_message: true,
    api_error_status: 400,
    api_error_type: 'invalid_request_error',
    api_error_code: 'some_code',
  })
  const [refused] = [...normalizeMessage({ ...message, refusedMessageId: 'msg_1' })]
  expect(refused).toMatchObject({ refused_message_id: 'msg_1' })
  const [plain] = [...normalizeMessage(createAssistantMessage({ content: 'hi' }))]
  for (const key of ['is_api_error_message', 'api_error_status', 'api_error_type', 'api_error_code', 'refused_message_id'])
    expect(plain).not.toHaveProperty(key)
})

// Official 2.1.329: thinking_display rides on the assistant frame of a streamed
// thinking block, never on one whose block is anything else.
test('the assistant frame of a streamed thinking block carries the request display', () => {
  const thinking = {
    ...createAssistantMessage({ content: [{ type: 'thinking', thinking: 'hm', signature: 's' }] as never }),
    thinkingDisplay: 'summarized',
  }
  const [sdk] = [...normalizeMessage(thinking)]
  expect(sdk).toMatchObject({ type: 'assistant', thinking_display: 'summarized' })
  const text = { ...createAssistantMessage({ content: 'hi' }), thinkingDisplay: 'summarized' }
  const [plain] = [...normalizeMessage(text)]
  expect(plain).not.toHaveProperty('thinking_display')
  const [bare] = [...normalizeMessage({ ...thinking, thinkingDisplay: undefined })]
  expect(bare).not.toHaveProperty('thinking_display')
})
