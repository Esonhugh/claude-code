import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

export type AuthProvider = 'anthropic' | 'openai'

/** A key the server can use; the page only ever sees its last four characters. */
export type KeyInfo = {
  provider: AuthProvider
  /** Effective base URL, or '' for the provider's default. */
  base_url: string
  /** Where the key comes from; absent when none is configured. */
  source?: string
  tail?: string
}

export type AccountStatus = {
  /** null when nothing new sessions could authenticate with is configured. */
  kind: 'claude' | 'chatgpt' | 'apikey' | null
  provider: AuthProvider
  name?: string
  plan?: string
  source?: string
  keys: KeyInfo[]
  /** Providers with a saved OAuth sign-in that can be switched to without a new login. */
  oauth: AuthProvider[]
}

export const FEATURE_KEYS = [
  'autoCompact',
  'gitInstructions',
  'memoryExtraction',
  'agentSummary',
  'promptSuggestions',
] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export const DAYBREAK = ['off', 'blue', 'red'] as const

export type WebSettings = {
  uiName: string
  features: Record<FeatureKey, boolean>
  /** The OpenAI Daybreak access program (`/daybreak`); off is standard access. */
  daybreak: (typeof DAYBREAK)[number]
}

export type OAuthFlow = {
  /** The browser URL (loopback callback) and the manual-code URL. */
  urls: Promise<{ url: string; manualUrl: string }>
  done: Promise<void>
  /** A pasted `code#state` (Claude) or redirect URL (ChatGPT). */
  submit: (code: string) => void
  cancel: () => void
}

/**
 * What the account and settings endpoints need from this machine. The real
 * one (accountBackend.ts) calls what `/login`, `/logout` and `/config` use;
 * tests pass a fake.
 */
export type AccountBackend = {
  status: () => Promise<AccountStatus>
  /** Makes `provider`'s key the auth for new sessions; saves `key` first when given. */
  useApiKey: (provider: AuthProvider, key: string | undefined) => Promise<void>
  /** Removes the stored key (and an env key) for `provider`. */
  removeApiKey: (provider: AuthProvider) => Promise<void>
  /** '' removes the override. */
  setBaseUrl: (provider: AuthProvider, url: string) => Promise<void>
  startOAuth: (provider: AuthProvider) => OAuthFlow
  /** Makes `provider`'s saved OAuth sign-in the auth for new sessions; throws when there is none. */
  useOAuth: (provider: AuthProvider) => Promise<void>
  logout: () => Promise<void>
  readSettings: () => Promise<WebSettings>
  writeSettings: (
    patch: Partial<{ uiName: string; features: Partial<Record<FeatureKey, boolean>>; daybreak: WebSettings['daybreak'] }>,
  ) => Promise<void>
  usage: () => Promise<object>
}

/** '' or an http(s) URL without credentials, query or fragment. */
export function isValidBaseUrl(value: string): boolean {
  if (value === '') return true
  if (value.length > 2048 || /\s/.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
}

const providerSchema = z.enum(['anthropic', 'openai'])

const apiKeyBodySchema = lazySchema(() =>
  z.object({
    provider: providerSchema,
    // Same charset `saveApiKey` accepts; empty keeps the stored key.
    key: z
      .string()
      .trim()
      .max(512)
      .regex(/^[A-Za-z0-9_-]*$/)
      .optional(),
    base_url: z.string().trim().refine(isValidBaseUrl).optional(),
  }),
)

const oauthBodySchema = lazySchema(() => z.object({ provider: providerSchema }))
const codeBodySchema = lazySchema(() =>
  z.object({ code: z.string().trim().min(1).max(4096) }),
)
const settingsBodySchema = lazySchema(() =>
  z.object({
    uiName: z.string().trim().max(32).optional(),
    features: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()).optional(),
    daybreak: z.enum(DAYBREAK).optional(),
  }),
)

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

const errorResponse = (status: number, message: string) =>
  Response.json({ error: message }, { status })

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * `/api/account*`, `/api/settings` and `/api/usage`. The caller has already
 * checked the cookie, Host and Origin. Keys go in, never out: responses carry
 * only `AccountStatus`, which carries a key's last four characters at most.
 *
 *   GET    /api/account               → status, pending OAuth login, last error
 *   POST   /api/account/api-key       { provider, key?, base_url? }
 *   DELETE /api/account/api-key       { provider }
 *   POST   /api/account/oauth         { provider } → { url, manual_url }
 *   POST   /api/account/oauth/code    { code }  (manual fallback)
 *   POST   /api/account/oauth/use     { provider }  switch to the saved sign-in
 *   DELETE /api/account/oauth         cancel the pending login
 *   POST   /api/account/logout
 *   GET    /api/settings              → { uiName, features, daybreak, allow_local_network }
 *   PATCH  /api/settings              { uiName?, features?, daybreak? }
 *   GET    /api/usage                 → the `get_usage` shape for this machine
 */
export function createAccountApi(
  backend: AccountBackend,
  { allowLocalNetwork }: { allowLocalNetwork: boolean },
): (req: Request, url: URL) => Promise<Response | undefined> {
  let pending:
    | { provider: AuthProvider; url: string; manualUrl: string; flow: OAuthFlow }
    | undefined
  let lastError: string | undefined

  const account = async () =>
    Response.json({
      ...(await backend.status()),
      pending: pending && {
        provider: pending.provider,
        url: pending.url,
        manual_url: pending.manualUrl,
      },
      ...(lastError !== undefined && { error: lastError }),
    })

  const cancelPending = () => {
    pending?.flow.cancel()
    pending = undefined
  }

  async function startOAuth(provider: AuthProvider): Promise<Response> {
    cancelPending()
    lastError = undefined
    const flow = backend.startOAuth(provider)
    flow.done.then(
      () => {
        if (pending?.flow === flow) pending = undefined
      },
      err => {
        if (pending?.flow !== flow) return
        pending = undefined
        lastError = messageOf(err)
      },
    )
    try {
      const { url, manualUrl } = await flow.urls
      pending = { provider, url, manualUrl, flow }
      return Response.json({ url, manual_url: manualUrl })
    } catch (err) {
      flow.cancel()
      return errorResponse(502, messageOf(err))
    }
  }

  return async (req, url) => {
    const { pathname } = url
    const method = req.method
    if (pathname === '/api/account' && method === 'GET') return account()
    if (pathname === '/api/account/api-key' && method === 'POST') {
      const parsed = apiKeyBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid API key or base URL')
      const { provider, key, base_url: baseUrl } = parsed.data
      if (!key && !(await backend.status()).keys.some(k => k.provider === provider && k.source)) {
        return errorResponse(400, 'Enter an API key')
      }
      try {
        cancelPending()
        await backend.useApiKey(provider, key || undefined)
        if (baseUrl !== undefined) await backend.setBaseUrl(provider, baseUrl)
        lastError = undefined
      } catch (err) {
        return errorResponse(500, messageOf(err))
      }
      return account()
    }
    if (pathname === '/api/account/api-key' && method === 'DELETE') {
      const parsed = oauthBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid provider')
      try {
        await backend.removeApiKey(parsed.data.provider)
      } catch (err) {
        return errorResponse(500, messageOf(err))
      }
      return account()
    }
    if (pathname === '/api/account/oauth' && method === 'POST') {
      const parsed = oauthBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid provider')
      return startOAuth(parsed.data.provider)
    }
    if (pathname === '/api/account/oauth/use' && method === 'POST') {
      const parsed = oauthBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid provider')
      if (!(await backend.status()).oauth.includes(parsed.data.provider)) {
        return errorResponse(400, 'No saved sign-in for this provider')
      }
      try {
        cancelPending()
        await backend.useOAuth(parsed.data.provider)
        lastError = undefined
      } catch (err) {
        return errorResponse(500, messageOf(err))
      }
      return account()
    }
    if (pathname === '/api/account/oauth' && method === 'DELETE') {
      cancelPending()
      return new Response(null, { status: 204 })
    }
    if (pathname === '/api/account/oauth/code' && method === 'POST') {
      const parsed = codeBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid code')
      if (!pending) return errorResponse(409, 'No login in progress')
      try {
        pending.flow.submit(parsed.data.code)
      } catch (err) {
        return errorResponse(400, messageOf(err))
      }
      return new Response(null, { status: 202 })
    }
    if (pathname === '/api/account/logout' && method === 'POST') {
      cancelPending()
      try {
        await backend.logout()
      } catch (err) {
        return errorResponse(500, messageOf(err))
      }
      lastError = undefined
      return account()
    }
    if (pathname === '/api/settings' && method === 'GET') {
      return Response.json({
        ...(await backend.readSettings()),
        allow_local_network: allowLocalNetwork,
      })
    }
    if (pathname === '/api/settings' && method === 'PATCH') {
      const parsed = settingsBodySchema().safeParse(await readJson(req))
      if (!parsed.success) return errorResponse(400, 'Invalid settings')
      try {
        await backend.writeSettings(parsed.data)
      } catch (err) {
        return errorResponse(500, messageOf(err))
      }
      return Response.json({
        ...(await backend.readSettings()),
        allow_local_network: allowLocalNetwork,
      })
    }
    if (pathname === '/api/usage' && method === 'GET') {
      return Response.json(await backend.usage())
    }
    return undefined
  }
}
