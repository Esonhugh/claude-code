import { describe, expect, it } from 'bun:test'
import { accountText } from './SidePanel'
import type { T } from './ui'

describe('accountText', () => {
  const t = (key => key) as T

  it('names the key source in words instead of the raw env var', () => {
    expect(accountText(t, { apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('keyFromEnv')
    expect(accountText(t, { account: { apiKeySource: '/login managed key' } })).toBe('keyFromLogin')
    expect(accountText(t, { account: { apiKeySource: 'apiKeyHelper' } })).toBe('API key · apiKeyHelper')
  })

  it('shows plan and email for a sign-in, the provider for cloud platforms', () => {
    expect(accountText(t, { account: { email: 'a@b.c', subscriptionType: 'max' } })).toBe('max · a@b.c')
    expect(accountText(t, { account: { apiProvider: 'bedrock', apiKeySource: 'none' } })).toBe('Amazon Bedrock')
    expect(accountText(t, { account: { apiKeySource: 'none' } })).toBeUndefined()
  })
})
