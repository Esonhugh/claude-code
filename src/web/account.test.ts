import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import type { AccountBackend, AccountStatus, AuthProvider, WebSettings } from './account.js'
import { isValidBaseUrl } from './account.js'
import { setOauthTokenFromFd } from '../bootstrap/state.js'
import { getGlobalConfig } from '../utils/config.js'
import { keyTail, localAccountBackend } from './accountBackend.js'
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
    oauth: [] as AuthProvider[],
    settings: {
      uiName: '',
      features: {
        autoCompact: true,
        gitInstructions: false,
        memoryExtraction: false,
        agentSummary: true,
        promptSuggestions: true,
      },
      daybreak: 'off',
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
      oauth: state.oauth,
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
    useOAuth: async provider => {
      state.provider = provider
      state.kind = provider === 'openai' ? 'chatgpt' : 'claude'
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
    writeSettings: async ({ uiName, features, daybreak }) => {
      if (uiName !== undefined) state.settings.uiName = uiName
      if (daybreak !== undefined) state.settings.daybreak = daybreak
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

  it('switches to a saved OAuth sign-in without a new login, and refuses when there is none', async () => {
    const { call, state } = await start()
    expect((await call('/api/account/oauth/use', 'POST', { provider: 'openai' })).status).toBe(400)
    expect(state.kind).toBeNull()
    state.oauth = ['openai']
    const res = await call('/api/account/oauth/use', 'POST', { provider: 'openai' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as AccountStatus).kind).toBe('chatgpt')
    expect(state.finish).toBeUndefined()
    expect((await call('/api/account/oauth/use', 'POST', { provider: 'gemini' })).status).toBe(400)
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
    expect((await call('/api/settings', 'PATCH', { daybreak: 'red' })).status).toBe(200)
    expect(state.settings.daybreak).toBe('red')
    expect((await call('/api/settings', 'PATCH', { daybreak: 'green' })).status).toBe(400)
  })
})

describe('keyTail', () => {
  it('keeps only the last four characters of a full-length key', () => {
    expect(keyTail('sk-ant-api03-abcdefghijklmnop')).toBe('mnop')
    expect(keyTail('short')).toBeUndefined()
  })
})

describe('local account status', () => {
  const NAMES = [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_REMOTE',
    'CLAUDE_CODE_ENTRYPOINT',
    'HOME',
    'OPENAI_API_KEY',
    'OPENAI_AUTH_TOKEN',
  ]
  // Under NODE_ENV=test an active Anthropic key does not show in status; parked ones do.
  const prior = Object.fromEntries(NAMES.map(n => [n, process.env[n]]))
  const clean = () => {
    for (const n of NAMES) delete process.env[n]
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), 'web-acct-home-')))
    process.env.CLAUDE_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'web-acct-status-')))
    setOauthTokenFromFd(null)
  }
  afterEach(() => {
    for (const n of NAMES) {
      if (prior[n] === undefined) delete process.env[n]
      else process.env[n] = prior[n]
    }
    setOauthTokenFromFd(null)
  })

  it('is signed in wherever `claude auth status` is logged in', async () => {
    const status = () => localAccountBackend().status()
    clean()
    expect((await status()).kind).toBeNull()

    // A token the host hands the CLI (a CCR token file or descriptor).
    clean()
    setOauthTokenFromFd('host-provided-test-value')
    expect(await status()).toMatchObject({ kind: 'claude', provider: 'anthropic' })

    clean()
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token-test-value'
    expect(await status()).toMatchObject({ kind: 'apikey', source: 'ANTHROPIC_AUTH_TOKEN' })

    clean()
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(await status()).toMatchObject({ kind: 'apikey', source: 'bedrock' })
  })

  // Status reads run on the OpenAI side: under NODE_ENV=test the Anthropic OAuth
  // status path demands an env credential.
  it('lists saved OAuth sign-ins and switches between them without a new login', async () => {
    clean()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const backend = localAccountBackend()
    expect((await backend.status()).oauth).toEqual([])
    mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true })
    writeFileSync(
      join(process.env.HOME!, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'chatgpt-access-test', refresh_token: 'chatgpt-refresh-test' } }),
    )
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'claude-access-test',
          refreshToken: 'claude-refresh-test',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:inference', 'user:profile'],
        },
      }),
    )
    expect((await backend.status()).oauth).toEqual(['anthropic', 'openai'])
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key-test-0123456789'
    await backend.useOAuth('anthropic')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    process.env.OPENAI_API_KEY = 'sk-proj-env-key-test-0123456789'
    await backend.useOAuth('openai')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(await backend.status()).toMatchObject({ kind: 'chatgpt', provider: 'openai' })
  })

  it('does not offer an expired Claude sign-in that cannot refresh', async () => {
    clean()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access-test', refreshToken: null, expiresAt: Date.now() - 1000, scopes: ['user:inference'] } }),
    )
    const backend = localAccountBackend()
    expect((await backend.status()).oauth).toEqual([])
    await expect(backend.useOAuth('anthropic')).rejects.toThrow('No saved sign-in')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  })

  it('keeps the sign-in or key it switches away from, and switches back without a new login', async () => {
    clean()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const home = process.env.HOME!
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    const chatgpt = { auth_mode: 'chatgpt', tokens: { access_token: 'chatgpt-access-test', refresh_token: 'chatgpt-refresh-test' } }
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(chatgpt))
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'claude-access-test', refreshToken: 'claude-refresh-test', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'] },
      }),
    )
    const claudeStored = () => JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken
    const codex = () => (existsSync(join(home, '.codex', 'auth.json')) ? JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) : undefined)
    const backend = localAccountBackend()
    const view = async () => {
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      const s = await backend.status()
      return { oauth: s.oauth, keys: s.keys.filter(k => k.source).map(k => k.provider) }
    }

    // Claude sign-in → new Anthropic key: the sign-in is parked, not deleted.
    await backend.useApiKey('anthropic', 'sk-ant-api03-firstkey0123456789')
    expect(claudeStored()).toBeUndefined()
    expect(getGlobalConfig().primaryApiKey).toBeDefined()
    expect((await view()).oauth).toEqual(['anthropic', 'openai'])

    // Back to the Claude sign-in: same tokens, key parked.
    await backend.useOAuth('anthropic')
    expect(claudeStored()).toBe('claude-access-test')
    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
    expect(await view()).toEqual({ oauth: ['anthropic', 'openai'], keys: ['anthropic'] })

    // And to the saved key again without typing it.
    await backend.useApiKey('anthropic', undefined)
    expect(claudeStored()).toBeUndefined()
    expect(getGlobalConfig().primaryApiKey).toBeDefined()

    // ChatGPT sign-in → OpenAI key → ChatGPT → saved key.
    await backend.useApiKey('openai', 'sk-proj-firstkey0123456789')
    expect(codex()).toEqual({ OPENAI_API_KEY: 'sk-proj-firstkey0123456789' })
    expect((await view()).oauth).toEqual(['anthropic', 'openai'])
    await backend.useOAuth('openai')
    expect(codex()).toEqual(chatgpt)
    await backend.useApiKey('openai', undefined)
    expect(codex()).toEqual({ OPENAI_API_KEY: 'sk-proj-firstkey0123456789' })

    // Signing out drops only the active one.
    await backend.logout()
    expect(codex()).toBeUndefined()
    expect((await view()).oauth).toEqual(['anthropic', 'openai'])
  })
})
