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

describe('session id', () => {
  it('shows the whole id, so selecting or copying it gives a value claude --resume accepts', async () => {
    const react = await import('react')
    const { createElement } = react
    // Run from the repo root, bun compiles the page's JSX with the root tsconfig's classic runtime.
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { SessionIdValue } = await import('./SidePanel')
    const id = '1189c0de-0000-4000-8000-00000000a690'
    const out = renderToStaticMarkup(createElement(SessionIdValue, { id, t: (key => key) as T }))
    expect(out).toContain(id)
    expect(out).not.toContain('…')
    expect(out).toContain('aria-label="copy"')
  })
})
