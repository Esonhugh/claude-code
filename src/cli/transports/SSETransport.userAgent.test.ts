import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { SSETransport } from './SSETransport.js'

const post = spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} } as never)

afterEach(() => {
  post.mockClear()
  resetSettingsCache()
})
afterAll(() => post.mockRestore())

test.each([
  [undefined, 'claude-code/2.1.327'],
  ['api-custom', 'claude-code/api-custom'],
])('SSETransport POST User-Agent follows ClaudeApiClientVersion %p', async (version, userAgent) => {
  setSessionSettingsCache({
    settings: version ? { versionNumber: { ClaudeApiClientVersion: version, ClaudeOAuthClientVersion: 'oauth-unused' } } : {},
    errors: [],
  })
  const transport = new SSETransport(
    new URL('https://ingress.example.test/v1/sessions/session-test/events/stream'),
    {},
    'session-test',
    undefined,
    undefined,
    () => ({ Authorization: 'Bearer test-session-token' }),
  )
  await transport.write({ type: 'keep_alive' } as never)
  expect(post).toHaveBeenCalledTimes(1)
  const [url, , config] = post.mock.calls[0] as unknown as [string, unknown, { headers: Record<string, string> }]
  expect(url).toBe('https://ingress.example.test/v1/sessions/session-test/events')
  expect(config.headers['User-Agent']).toBe(userAgent)
  expect(config.headers.Authorization).toBe('Bearer test-session-token')
})
