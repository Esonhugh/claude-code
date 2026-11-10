import { expect, test } from 'bun:test'
import { tokenCountWithEstimation } from '../utils/tokens.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import {
  bytesPerTokenForModel,
  roughTokenCountEstimationForMessages,
} from './tokenEstimation.js'

test('newer models estimate 3 bytes per token, the 2.1.311 legacy set keeps 4', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-7']) {
    expect({ model, bytes: bytesPerTokenForModel(model) }).toEqual({ model, bytes: 3 })
  }
  for (const model of [
    'claude-3-5-sonnet-20241022',
    'claude-3-7-sonnet-latest',
    'claude-opus-4-1',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5',
    'us.anthropic.claude-opus-4-6-v1:0',
  ]) {
    expect({ model, bytes: bytesPerTokenForModel(model) }).toEqual({ model, bytes: 4 })
  }
  expect(bytesPerTokenForModel(undefined)).toBe(4)
})

test('message estimates use the given bytes per token', () => {
  const messages = [createUserMessage({ content: 'x'.repeat(300) })]
  expect(roughTokenCountEstimationForMessages(messages)).toBe(75)
  expect(roughTokenCountEstimationForMessages(messages, 3)).toBe(100)
  expect(tokenCountWithEstimation(messages, 3)).toBe(100)
})

test('a zero usage record from a gateway that omits usage is not an anchor', () => {
  const user = createUserMessage({ content: 'x'.repeat(300) })
  const reply = createAssistantMessage({ content: 'ok' })
  reply.message.model = 'claude-opus-5-5'
  reply.message.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as typeof reply.message.usage
  expect(tokenCountWithEstimation([user, reply], 3)).toBe(roughTokenCountEstimationForMessages([user, reply], 3))
  reply.message.usage = { input_tokens: 1000, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as typeof reply.message.usage
  expect(tokenCountWithEstimation([user, reply], 3)).toBe(1005)
})
