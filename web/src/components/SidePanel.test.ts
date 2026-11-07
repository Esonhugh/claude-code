import { describe, expect, it } from 'bun:test'
import { accountText, connectionRows, peerAddress } from './SidePanel'
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

describe('connectionRows', () => {
  it('keeps the base URL and proxy rows of get_status and drops the ones Status already shows', () => {
    const status = {
      sections: [
        {
          title: 'Session',
          rows: [
            { label: 'Version', value: '2.1.296' },
            { label: 'Anthropic base URL', value: 'https://gw.example.com' },
            { label: 'Proxy', value: 'http://127.0.0.1:8080' },
          ],
        },
        { title: 'Environment', rows: [{ label: 'Model', value: 'Opus' }] },
        { title: 'System Diagnostics', rows: [{ value: 'ok' }] },
      ],
    }
    expect(connectionRows(status)).toEqual([
      ['Anthropic base URL', 'https://gw.example.com'],
      ['Proxy', 'http://127.0.0.1:8080'],
    ])
  })

  it('is empty before get_status answers or when the answer is malformed', () => {
    expect(connectionRows(undefined)).toEqual([])
    expect(connectionRows({ sections: 'x' })).toEqual([])
  })
})

describe('peerAddress', () => {
  it('takes the uds: messaging address from the Session rows of get_status', () => {
    const status = {
      sections: [
        {
          title: 'Session',
          rows: [
            { label: 'Session ID', value: 'abc' },
            { label: 'Peer address', value: 'uds:/tmp/claude-1000/messaging/123.sock' },
          ],
        },
      ],
    }
    expect(peerAddress(status)).toBe('uds:/tmp/claude-1000/messaging/123.sock')
  })

  it('is undefined without a socket or before get_status answers', () => {
    const status = { sections: [{ title: 'Session', rows: [{ label: 'Peer address', value: 'Not available' }] }] }
    expect(peerAddress(status)).toBeUndefined()
    expect(peerAddress(undefined)).toBeUndefined()
  })
})

describe('Status compact button', () => {
  const render = async (contextPercent: number | undefined, busy = false) => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { SidePanel } = await import('./SidePanel')
    const { initialState } = await import('../protocol')
    const chat = { ...initialState, contextPercent, busy, mode: 'live' } as never
    return renderToStaticMarkup(
      react.createElement(SidePanel, {
        t: (key => key) as T,
        open: true,
        tab: 'status',
        setTab: () => {},
        sessionId: 's1',
        chat,
        title: 'chat',
        models: [],
        statusText: 'idle',
        agentsView: { kind: 'tree' },
        setAgentsView: () => {},
        setWorkflowId: () => {},
        onOpenFile: () => {},
        onStopTask: () => {},
        onSendTask: async () => {},
        agentInput: { tools: {} as never, models: [] } as never,
        onRequest: async () => ({}),
        onModsRequest: async () => ({}),
        onModCanvas: () => {},
        onCompact: () => {},
        onClose: () => {},
      }),
    )
  }

  it('shows /compact by itself once the context is 60% full', async () => {
    expect(await render(59)).not.toContain('compactNow')
    expect(await render(60)).toContain('compactNow')
    expect(await render(undefined)).not.toContain('compactNow')
  })

  it('keeps the button but disables it while a turn runs', async () => {
    expect(await render(80, true)).toMatch(/<button[^>]*disabled[^>]*>compactNow/)
  })
})

describe('usageRows', () => {
  it('shows the weekly limit next to the 5-hour one', async () => {
    const { usageRows } = await import('./SidePanel')
    const { initialState } = await import('../protocol')
    const chat = { ...initialState, mode: 'readonly' } as never
    const { rows } = usageRows(((key: string) => key) as T, chat, {
      subscription_type: 'plus',
      rate_limits: {
        five_hour: { utilization: 2, resets_at: '2026-11-03T17:44:56.000Z' },
        seven_day: { utilization: 94, resets_at: '2026-11-04T15:58:17.000Z' },
      },
    })
    expect(rows.map(([label]) => label)).toEqual(expect.arrayContaining(['quota5hLabel', 'quotaWeekLabel']))
  })
})
