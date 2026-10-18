import { describe, expect, test } from 'bun:test'
import { ClaudeAuthProvider } from './auth.js'
import type { McpHTTPServerConfig } from './types.js'

async function authorize(
  config: McpHTTPServerConfig,
  stepUpScope?: string,
): Promise<string | null> {
  let opened: string | undefined
  const provider = new ClaudeAuthProvider(
    'scoped',
    config,
    'http://localhost:1/callback',
    true,
    url => {
      opened = url
    },
    true,
  )
  if (stepUpScope) provider.markStepUpPending(stepUpScope)
  await provider.redirectToAuthorization(
    new URL('https://as.example/authorize?scope=discovered&state=s'),
  )
  return new URL(opened!).searchParams.get('scope')
}

const http = (scopes?: string): McpHTTPServerConfig => ({
  type: 'http',
  url: 'https://mcp.example/mcp',
  ...(scopes && { oauth: { scopes } }),
})

describe('oauth.scopes', () => {
  test('configured scopes replace the discovered scope', async () => {
    expect(await authorize(http('read write'))).toBe('read write')
  })

  test('without configured scopes the discovered scope is kept', async () => {
    expect(await authorize(http())).toBe('discovered')
  })

  test('a pending step-up keeps the scope the server asked for', async () => {
    expect(await authorize(http('read'), 'admin')).toBe('discovered')
  })
})
