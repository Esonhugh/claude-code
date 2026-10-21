import { describe, expect, test } from 'bun:test'
import { WebFetchTool } from './WebFetchTool.js'

type Rules = { allow?: string[]; deny?: string[]; ask?: string[] }

function context(rules: Rules) {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: { userSettings: rules.allow ?? [] },
        alwaysDenyRules: { userSettings: rules.deny ?? [] },
        alwaysAskRules: { userSettings: rules.ask ?? [] },
        additionalWorkingDirectories: new Map(),
        isBypassPermissionsModeAvailable: false,
      },
    }),
  } as never
}

async function check(url: string, rules: Rules = {}) {
  return WebFetchTool.checkPermissions(
    { url, prompt: 'summarize' },
    context(rules),
  )
}

describe('WebFetchTool domain permission rules', () => {
  test('preapproved hosts are allowed when no rule matches', async () => {
    const result = await check('https://docs.python.org/3/')
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toEqual({
      type: 'other',
      reason: 'Preapproved host',
    })
  })

  test('explicit deny rule beats the preapproved host list', async () => {
    const result = await check('https://docs.python.org/3/', {
      deny: ['WebFetch(domain:docs.python.org)'],
    })
    expect(result.behavior).toBe('deny')
  })

  test('explicit ask rule beats the preapproved host list', async () => {
    const result = await check('https://docs.python.org/3/', {
      ask: ['WebFetch(domain:docs.python.org)'],
    })
    expect(result.behavior).toBe('ask')
  })

  test('wildcard deny rule blocks a preapproved subdomain', async () => {
    const result = await check('https://docs.python.org/3/', {
      deny: ['WebFetch(domain:*.python.org)'],
    })
    expect(result.behavior).toBe('deny')
  })

  test('wildcard allow rule matches subdomains at any depth', async () => {
    const rules = { allow: ['WebFetch(domain:*.example.com)'] }
    expect((await check('https://api.example.com/x', rules)).behavior).toBe(
      'allow',
    )
    expect((await check('https://a.b.example.com/x', rules)).behavior).toBe(
      'allow',
    )
  })

  test('wildcard rule does not match the bare domain or look-alike hosts', async () => {
    const rules = { allow: ['WebFetch(domain:*.example.com)'] }
    expect((await check('https://example.com/', rules)).behavior).toBe('ask')
    expect((await check('https://evilexample.com/', rules)).behavior).toBe(
      'ask',
    )
    expect(
      (await check('https://example.com.evil.net/', rules)).behavior,
    ).toBe('ask')
  })

  test('wildcard deny and ask rules match subdomains', async () => {
    expect(
      (
        await check('https://cdn.example.com/', {
          deny: ['WebFetch(domain:*.example.com)'],
          allow: ['WebFetch(domain:cdn.example.com)'],
        })
      ).behavior,
    ).toBe('deny')
    expect(
      (
        await check('https://cdn.example.com/', {
          ask: ['WebFetch(domain:*.example.com)'],
          allow: ['WebFetch(domain:cdn.example.com)'],
        })
      ).behavior,
    ).toBe('ask')
  })

  test('wildcard inside a label matches only that label', async () => {
    const rules = { allow: ['WebFetch(domain:api-*.example.com)'] }
    expect(
      (await check('https://api-eu.example.com/', rules)).behavior,
    ).toBe('allow')
    expect(
      (await check('https://api-eu.x.example.com/', rules)).behavior,
    ).toBe('ask')
  })

  test('domain:* matches every host', async () => {
    const result = await check('https://anything.test/', {
      deny: ['WebFetch(domain:*)'],
    })
    expect(result.behavior).toBe('deny')
  })

  test('domain rules compare hosts case-insensitively and ignore a trailing dot', async () => {
    const result = await check('https://docs.example.com/', {
      allow: ['WebFetch(domain:Docs.Example.COM.)'],
    })
    expect(result.behavior).toBe('allow')
  })
})
