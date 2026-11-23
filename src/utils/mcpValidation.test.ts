import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'

const tokenEstimation = await import('../services/tokenEstimation.js')
const countTokens = spyOn(tokenEstimation, 'countMessagesTokensWithAPI')
const { mcpContentNeedsTruncation } = await import('./mcpValidation.js')

const previousLimit = process.env.MAX_MCP_OUTPUT_TOKENS
process.env.MAX_MCP_OUTPUT_TOKENS = '100'

afterEach(() => countTokens.mockReset())
afterAll(() => {
  countTokens.mockRestore()
  if (previousLimit === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS
  else process.env.MAX_MCP_OUTPUT_TOKENS = previousLimit
})

// 5000 characters is about 1250 tokens, 300 characters about 75.
const overLimit = 'x'.repeat(5000)
const underLimit = 'x'.repeat(300)

// Official 2.1.329 still saves the oversized result when count_tokens answers HTTP 500.
test('a failed token count falls back to the size estimate', async () => {
  countTokens.mockResolvedValue(null)
  expect(await mcpContentNeedsTruncation(overLimit)).toBe(true)
  expect(await mcpContentNeedsTruncation(underLimit)).toBe(false)

  countTokens.mockRejectedValue(new Error('count_tokens failed'))
  expect(await mcpContentNeedsTruncation(overLimit)).toBe(true)
  expect(await mcpContentNeedsTruncation(underLimit)).toBe(false)
})

test('the counted tokens decide when the count succeeds', async () => {
  countTokens.mockResolvedValue(90)
  expect(await mcpContentNeedsTruncation(overLimit)).toBe(false)
  countTokens.mockResolvedValue(101)
  expect(await mcpContentNeedsTruncation(underLimit)).toBe(true)
})
