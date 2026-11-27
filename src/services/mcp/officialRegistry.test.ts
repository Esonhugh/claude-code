import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { isOfficialMcpUrl, prefetchOfficialMcpUrls, resetOfficialMcpUrlsForTesting } from './officialRegistry.js'

const ENV_KEYS = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
for (const key of ENV_KEYS) delete process.env[key]
const get = spyOn(axios, 'get').mockResolvedValue({
  data: { servers: [{ server: { remotes: [{ url: 'https://mcp.example.com/sse/?v=1' }] } }] },
} as never)

afterEach(() => {
  get.mockClear()
  resetOfficialMcpUrlsForTesting()
  for (const key of ENV_KEYS) delete process.env[key]
})
afterAll(() => {
  get.mockRestore()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC the registry is fetched', async () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  await prefetchOfficialMcpUrls()
  expect(get).toHaveBeenCalledTimes(1)
  expect(isOfficialMcpUrl('https://mcp.example.com/sse')).toBe(true)
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0 still skips the registry fetch, like the privacy level', async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  await prefetchOfficialMcpUrls()
  expect(get).not.toHaveBeenCalled()
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 skips the registry fetch', async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  await prefetchOfficialMcpUrls()
  expect(get).not.toHaveBeenCalled()
  expect(isOfficialMcpUrl('https://mcp.example.com/sse')).toBe(false)
})

test.each([
  ['a gateway base URL', 'ANTHROPIC_BASE_URL', 'https://gateway.example.com'],
  ['the OpenAI provider', 'CLAUDE_CODE_USE_OPENAI', '1'],
  ['Bedrock', 'CLAUDE_CODE_USE_BEDROCK', '1'],
] as const)('%s skips the registry fetch', async (_label, key, value) => {
  process.env[key] = value
  await prefetchOfficialMcpUrls()
  expect(get).not.toHaveBeenCalled()
})
