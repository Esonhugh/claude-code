import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { isOfficialMcpUrl, prefetchOfficialMcpUrls, resetOfficialMcpUrlsForTesting } from './officialRegistry.js'

const saved = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
const get = spyOn(axios, 'get').mockResolvedValue({
  data: { servers: [{ server: { remotes: [{ url: 'https://mcp.example.com/sse/?v=1' }] } }] },
} as never)

afterEach(() => {
  get.mockClear()
  resetOfficialMcpUrlsForTesting()
  if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = saved
})
afterAll(() => get.mockRestore())

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
