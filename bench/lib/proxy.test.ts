import { expect, test } from 'bun:test'
import { makeTracker, sseParser, summarizeRequest, wsFrameParser } from './proxy.mjs'

test('request summary records model and effort, never the body', () => {
  const body = JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: [1, 2], tools: [{}], instructions: 'abc', reasoning: { effort: 'low' }, secret: 'do-not-log' })
  const o = summarizeRequest('chatgpt.com', '/backend-api/codex/responses?x=1', body)
  expect(o).toEqual({ host: 'chatgpt.com', path: '/backend-api/codex/responses', model: 'gpt-6.1-sol', stream: true, n_msgs: 2, n_tools: 1, sys_chars: 3, effort: 'low' })
})

test('Anthropic SSE: usage from message_start merged with message_delta', () => {
  const rec: Record<string, unknown> = { t0: Date.now() }
  const feed = sseParser(makeTracker(rec))
  feed(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":5,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n'))
  feed(Buffer.from('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'))
  expect(rec.usage).toEqual({ input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 42 })
  expect(rec.model_resp).toBe('claude-sonnet-5-5')
  expect(typeof rec.ttft_ms).toBe('number')
})

test('WebSocket frames: masked client frame decoded', () => {
  const texts: string[] = []
  const parse = wsFrameParser((t: string) => texts.push(t))
  const payload = Buffer.from('{"type":"response.create"}')
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
  parse(frame.subarray(0, 3))
  parse(frame.subarray(3))
  expect(texts).toEqual(['{"type":"response.create"}'])
})

test('OpenAI response.completed carries the usage', () => {
  const rec: Record<string, unknown> = { t0: Date.now() }
  makeTracker(rec)({ type: 'response.completed', response: { model: 'gpt-6.1-sol', status: 'completed', usage: { input_tokens: 10 } } })
  expect(rec.usage).toEqual({ input_tokens: 10 })
})
