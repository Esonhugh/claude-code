import { afterEach, expect, test } from 'bun:test'
import { getProxyFetchOptions } from './proxy.js'

const keys = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// Official 2.1.292 fetch options take the target URL and skip the proxy for NO_PROXY hosts.
test('fetch options omit the proxy only for a target URL covered by NO_PROXY', () => {
  for (const key of keys) delete process.env[key]
  process.env.HTTPS_PROXY = 'http://proxy.test:3128'
  process.env.NO_PROXY = 'plugins.internal.test'
  expect(getProxyFetchOptions({ url: 'https://plugins.internal.test/p.zip' }).proxy).toBeUndefined()
  expect(getProxyFetchOptions({ url: 'https://public.test/p.zip' }).proxy).toBe('http://proxy.test:3128')
  expect(getProxyFetchOptions().proxy).toBe('http://proxy.test:3128')
})
