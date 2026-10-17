import { expect, test } from 'bun:test'
import { McpJsonConfigSchema, McpServerConfigSchema } from './types.js'
import { ensureTransport } from './utils.js'

// Official 2.1.292 accepts type ["http","streamable-http"] and transforms it to "http".
test('config schema accepts type "streamable-http" as "http"', () => {
  const config = { type: 'streamable-http', url: 'https://owned.invalid/mcp', headers: { 'X-Owned': '1' } }
  const result = McpServerConfigSchema().safeParse(config)
  expect(result.success).toBe(true)
  expect(result.data).toEqual({ ...config, type: 'http' })
  const json = McpJsonConfigSchema().safeParse({ mcpServers: { owned: config } })
  expect(json.success).toBe(true)
  expect(json.data?.mcpServers.owned?.type).toBe('http')
})

test('mcp add --transport accepts streamable-http as http', () => {
  expect(ensureTransport('streamable-http')).toBe('http')
  expect(ensureTransport('http')).toBe('http')
  expect(ensureTransport(undefined)).toBe('stdio')
  expect(() => ensureTransport('websocket')).toThrow(
    'Invalid transport type: websocket. Must be one of: stdio, sse, http (or streamable-http)',
  )
})
