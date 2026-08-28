import { afterEach, describe, expect, test } from 'bun:test'
import { fileSuffixForOauthConfig, getOauthConfig } from './oauth.js'

const originalEnv = {
  USE_LOCAL_OAUTH: process.env.USE_LOCAL_OAUTH,
  CLAUDE_LOCAL_OAUTH_API_BASE: process.env.CLAUDE_LOCAL_OAUTH_API_BASE,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('OAuth configuration', () => {
  test('uses the explicitly enabled local OAuth endpoint', () => {
    process.env.USE_LOCAL_OAUTH = '1'
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE = 'http://127.0.0.1:8765/'

    expect(getOauthConfig().BASE_API_URL).toBe('http://127.0.0.1:8765')
    expect(fileSuffixForOauthConfig()).toBe('-local-oauth')
  })

  test('defaults to production without the local opt-in', () => {
    delete process.env.USE_LOCAL_OAUTH
    delete process.env.CLAUDE_LOCAL_OAUTH_API_BASE

    expect(getOauthConfig().BASE_API_URL).toBe('https://api.anthropic.com')
    expect(fileSuffixForOauthConfig()).toBe('')
  })
})
