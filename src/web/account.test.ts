import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import type { AccountBackend, AccountStatus, AuthProvider, WebSettings } from './account.js'
import { isValidBaseUrl } from './account.js'
import { keyTail } from './accountBackend.js'
import { startWebServer } from './webServer.js'

const TOKEN = 'account-test-token'
const SECRET = 'sk-ant-api03-THIS_IS_THE_SECRET_PART_0123456789abcdef'

/** In-memory stand-in for the credential store and settings. */
function fakeBackend() {
  const state = {
    stored: {} as Partial<Record<AuthProvider, string>>,
    base: { anthropic: '', openai: '' } as Record<AuthProvider, string>,
    provider: 'anthropic' as AuthProvider,
    kind: null as AccountStatus['kind'],
    settings: {
      uiName: '',
      features: {
        autoCompact: true,
        gitInstructions: false,
        memoryExtraction: false,
        agentSummary: true,
        promptSuggestions: true,
      },
    } as WebSettings,
    submitted: [] as string[],
    cancelled: 0,
    finish: undefined as undefined | ((err?: Error) => void),
  }
  const backend: AccountBackend = {
    status: async () => ({
      kind: state.kind,
      provider: state.provider,
      source: state.kind === 'apikey' ? '/login managed key' : undefined,
      keys: (['anthropic', 'openai'] as const).map(provider => ({
        provider,
        base_url: state.base[provider],
        ...(state.stored[provider] && { source: 'stored', tail: keyTail(state.stored[provider]!) }),
      })),
    }),
    useApiKey: async (provider, key) => {
      if (key) state.stored[provider] = key
      state.provider = provider
      state.kind = 'apikey'
    },
    setBaseUrl: async (provider, url) => {
      state.base[provider] = url
    },
    startOAuth: provider => {
      let resolve!: () => void
      let reject!: (err: Error) => void
      const done = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      state.finish = err => {
        if (err) return reject(err)
        state.provider = provider
        state.kind = provider === 'openai' ? 'chatgpt' : 'claude'
        resolve()
      }
      return {
        urls: Promise.resolve({ url: 'http://localhost:1/callback', manualUrl: 'https://login.example/manual' }),
        done,
        submit: code => {
          if (!code.includes('#')) throw new Error('bad code')
          state.submitted.push(code)
        },
        cancel: () => {
          state.cancelled++
        },
      }
    },
    removeApiKey: async provider => {
      delete state.stored[provider]
      if (state.kind === 'apikey' && state.provider === provider) state.kind = null
    },
    logout: async () => {
      state.kind = null
      state.stored = {}
    },
    readSettings: async () => structuredClone(state.settings),
    writeSettings: async ({ uiName, features }) => {
      if (uiName !== undefined) state.settings.uiName = uiName
      Object.assign(state.settings.features, features)
    },
    usage: async () => ({ rate_limits: null }),
  }
  return { state, backend }
}

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(stops.splice(0).map(stop => stop()))
})

async function start(allowLocalNetwork = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'web-account-')))
  const fake = fakeBackend()
  const manager = new SessionManager({ spawn: () => { throw new Error('no sessions here') } })
  const server = startWebServer(
    {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      cookieKey: Buffer.alloc(32, 2),
      workspace: dir,
      uploadsDir: join(dir, 'uploads'),
      configDir: dir,
      allowLocalNetwork,
      account: fake.backend,
    },
    manager,
    new Map(),
    createServerLogger({ write: () => {} }),
  )
  stops.push(async () => server.stop(true))
  const origin = `http://127.0.0.1:${server.port}`
  const signed = await fetch(`${origin}/?token=${TOKEN}`, { redirect: 'manual' })
  const cookie = (signed.headers.get('set-cookie') ?? '').split(';')[0]!
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  return { ...fake, origin, cookie, call }
}

describe('account endpoints', () => {
  it('saves a key but never sends it back, only its last four characters', async () => {
    const { call, state } = await start()
    const res = await call('/api/account/api-key', 'POST', {
      provider: 'anthropic',
      key: SECRET,
      base_url: 'https://gateway.example/anthropic',
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('SECRET_PART')
    const body = JSON.parse(text) as AccountStatus
    expect(body.kind).toBe('apikey')
    expect(body.keys[0]).toEqual({
      provider: 'anthropic',
      base_url: 'https://gateway.example/anthropic',
      source: 'stored',
      tail: 'cdef',
    })
    expect(state.stored.anthropic).toBe(SECRET)
    const again = await (await call('/api/account')).text()
    expect(again).not.toContain(SECRET)
    expect(again).toContain('"tail":"cdef"')
  })

  it('switches to a stored key without a new one, and refuses when there is none', async () => {
    const { call, state } = await start()
    expect((await call('/api/account/api-key', 'POST', { provider: 'openai' })).status).toBe(400)
    state.stored.openai = 'sk-proj-abcdefghijklmnop'
    const res = await call('/api/account/api-key', 'POST', { provider: 'openai', key: '' })
    expect(res.status).toBe(200)
    expect(state.provider).toBe('openai')
  })

  it('accepts only http(s) base URLs', async () => {
    const { call, state } = await start()
    for (const base_url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://x.example',
      'not a url',
      'https://user:pw@x.example',
      'https://x.example/?q=1',
    ]) {
      const res = await call('/api/account/api-key', 'POST', { provider: 'anthropic', key: 'sk-ant-xyz123456789', base_url })
      expect(res.status).toBe(400)
    }
    expect(state.stored.anthropic).toBeUndefined()
    expect(isValidBaseUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isValidBaseUrl('https://api.openai.com/v1')).toBe(true)
    expect(isValidBaseUrl('')).toBe(true)
  })

  it('rejects keys with characters the store does not accept', async () => {
    const { call, state } = await start()
    const res = await call('/api/account/api-key', 'POST', { provider: 'anthropic', key: 'sk-ant-"; rm -rf /' })
    expect(res.status).toBe(400)
    expect(state.stored.anthropic).toBeUndefined()
  })

  it('requires the session cookie', async () => {
    const { call, state } = await start()
    for (const [path, method] of [
      ['/api/account', 'GET'],
      ['/api/account/api-key', 'POST'],
      ['/api/account/logout', 'POST'],
      ['/api/settings', 'PATCH'],
      ['/api/usage', 'GET'],
    ] as const) {
      const res = await call(path, method, method === 'GET' ? undefined : { provider: 'anthropic', key: SECRET }, { cookie: '' })
      expect(res.status).toBe(401)
    }
    expect(state.stored.anthropic).toBeUndefined()
  })

  it('applies the Origin and Host checks', async () => {
    const { call, state } = await start()
    const body = { provider: 'anthropic', key: SECRET }
    expect((await call('/api/account/api-key', 'POST', body, { origin: 'http://attacker.example' })).status).toBe(403)
    expect((await call('/api/account/api-key', 'POST', body, { origin: '' })).status).toBe(403)
    expect((await call('/api/account/api-key', 'POST', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call('/api/account/logout', 'POST', {}, { host: 'attacker.example' })).status).toBe(403)
    expect((await call('/api/account', 'GET', undefined, { origin: 'http://attacker.example' })).status).toBe(403)
    expect(state.stored.anthropic).toBeUndefined()
  })

  it('runs an OAuth login with the manual code fallback', async () => {
    const { call, state } = await start()
    const started = await call('/api/account/oauth', 'POST', { provider: 'anthropic' })
    expect(await started.json()).toEqual({ url: 'http://localhost:1/callback', manual_url: 'https://login.example/manual' })
    expect(((await (await call('/api/account')).json()) as { pending?: unknown }).pending).toEqual({
      provider: 'anthropic',
      url: 'http://localhost:1/callback',
      manual_url: 'https://login.example/manual',
    })
    expect((await call('/api/account/oauth/code', 'POST', { code: 'nohash' })).status).toBe(400)
    expect((await call('/api/account/oauth/code', 'POST', { code: 'abc#state' })).status).toBe(202)
    expect(state.submitted).toEqual(['abc#state'])
    state.finish!()
    await Bun.sleep(10)
    const done = (await (await call('/api/account')).json()) as AccountStatus & { pending?: unknown }
    expect(done.kind).toBe('claude')
    expect(done.pending).toBeUndefined()
  })

  it('reports a failed login and cancels a pending one', async () => {
    const { call, state } = await start()
    await call('/api/account/oauth', 'POST', { provider: 'openai' })
    state.finish!(new Error('token endpoint returned status 400'))
    await Bun.sleep(10)
    const failed = (await (await call('/api/account')).json()) as { error?: string; pending?: unknown }
    expect(failed.error).toBe('token endpoint returned status 400')
    expect(failed.pending).toBeUndefined()
    await call('/api/account/oauth', 'POST', { provider: 'openai' })
    expect((await call('/api/account/oauth', 'DELETE')).status).toBe(204)
    expect(state.cancelled).toBe(1)
    expect((await call('/api/account/oauth/code', 'POST', { code: 'a#b' })).status).toBe(409)
    expect((await call('/api/account/oauth', 'POST', { provider: 'gemini' })).status).toBe(400)
  })

  it('logs out', async () => {
    const { call, state } = await start()
    state.kind = 'claude'
    const res = await call('/api/account/logout', 'POST', {})
    expect(((await res.json()) as AccountStatus).kind).toBeNull()
  })
})

describe('removing a key', () => {
  it('deletes the stored key and validates the provider', async () => {
    const { call, state } = await start()
    await call('/api/account/api-key', 'POST', { provider: 'anthropic', key: SECRET })
    const res = await call('/api/account/api-key', 'DELETE', { provider: 'anthropic' })
    const body = (await res.json()) as AccountStatus
    expect(body.kind).toBeNull()
    expect(body.keys[0]!.source).toBeUndefined()
    expect(state.stored.anthropic).toBeUndefined()
    expect((await call('/api/account/api-key', 'DELETE', { provider: 'x' })).status).toBe(400)
    expect((await call('/api/account/api-key', 'DELETE', { provider: 'openai' }, { origin: 'http://attacker.example' })).status).toBe(403)
  })
})

describe('settings endpoints', () => {
  it('reads and writes uiName and feature switches', async () => {
    const { call, state } = await start(true)
    const read = (await (await call('/api/settings')).json()) as WebSettings & { allow_local_network: boolean }
    expect(read.allow_local_network).toBe(true)
    expect(read.features.autoCompact).toBe(true)
    const res = await call('/api/settings', 'PATCH', { uiName: '  MyClaw ', features: { gitInstructions: true } })
    expect(res.status).toBe(200)
    expect(state.settings.uiName).toBe('MyClaw')
    expect(state.settings.features.gitInstructions).toBe(true)
    expect((await call('/api/settings', 'PATCH', { uiName: 'x'.repeat(33) })).status).toBe(400)
    expect((await call('/api/settings', 'PATCH', { features: { apiKeyHelper: true } })).status).toBe(400)
    expect((await call('/api/settings', 'PATCH', { features: { autoCompact: 'yes' } })).status).toBe(400)
  })
})

describe('keyTail', () => {
  it('keeps only the last four characters of a full-length key', () => {
    expect(keyTail('sk-ant-api03-abcdefghijklmnop')).toBe('mnop')
    expect(keyTail('short')).toBeUndefined()
  })
})
