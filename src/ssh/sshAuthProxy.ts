import { chmodSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  getOpenAIAuthInfo,
} from '../utils/auth.js'
import { getAuthHeaders } from '../utils/http.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { checkAndRefreshOpenAITokenIfNeeded } from '../services/openai-oauth/refresh.js'

const DEFAULT_UPSTREAM = 'https://api.anthropic.com'
const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com/v1'
const CHATGPT_UPSTREAM = 'https://chatgpt.com/backend-api/codex'
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'chatgpt-account-id',
  'cookie',
  'origin',
  'referer',
])
const RESPONSE_HEADERS_TO_STRIP = new Set(['set-cookie', 'set-cookie2'])

type SSHProxyProvider = 'anthropic' | 'openai'
type SSHProxyAuthKind = 'oauth' | 'api-key'

export type SSHProxyAuth = {
  kind: SSHProxyAuthKind
  headers: Record<string, string>
}

export type SSHProxyRouting = {
  provider: SSHProxyProvider
  authKind: SSHProxyAuthKind
  openAIAuthMode?: 'chatgpt' | 'platform'
}

function normalizeOpenAIBaseURL(value: string): string {
  const normalized = value.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function validateUpstream(value: string): string {
  let upstream: URL
  try {
    upstream = new URL(value)
  } catch {
    throw new Error(`Invalid SSH auth proxy upstream: ${value}`)
  }
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error(
      `Unsupported SSH auth proxy upstream protocol: ${upstream.protocol}`,
    )
  }
  if (
    upstream.protocol === 'http:' &&
    upstream.hostname !== 'localhost' &&
    upstream.hostname !== '127.0.0.1' &&
    upstream.hostname !== '[::1]'
  ) {
    throw new Error('SSH auth proxy requires HTTPS for non-loopback upstreams')
  }
  upstream.search = ''
  upstream.hash = ''
  return upstream.toString().replace(/\/$/, '')
}

export function resolveSSHAuthProxyOptions(): {
  provider: SSHProxyProvider
  upstream: string
  getAuth: () => Promise<SSHProxyAuth>
} {
  const provider = getAPIProvider()
  if (provider === 'openai') {
    const initialAuth = getOpenAIAuthInfo()
    return {
      provider,
      upstream: initialAuth?.isChatGPT
        ? CHATGPT_UPSTREAM
        : normalizeOpenAIBaseURL(
            process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_UPSTREAM,
          ),
      getAuth: async () => {
        await checkAndRefreshOpenAITokenIfNeeded()
        getOpenAIAuthInfo.cache.clear?.()
        const auth = getOpenAIAuthInfo()
        if (!auth) {
          throw new Error(
            'No OpenAI credentials found. Run /login in an interactive session to sign in with OpenAI.',
          )
        }
        return {
          kind: auth.isChatGPT ? 'oauth' : 'api-key',
          headers: auth.isChatGPT
            ? {
                authorization: `Bearer ${auth.accessToken}`,
                accept: 'text/event-stream',
                'accept-language': 'en-US,en;q=0.9',
                referer: 'https://chatgpt.com/',
                origin: 'https://chatgpt.com',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent':
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                ...(auth.accountId
                  ? { 'chatgpt-account-id': auth.accountId }
                  : {}),
              }
            : { authorization: `Bearer ${auth.accessToken}` },
        }
      },
    }
  }
  if (provider !== 'firstParty') {
    throw new Error(
      `claude ssh does not support the ${provider} provider; use Anthropic OAuth, OpenAI, ANTHROPIC_API_KEY, or an Anthropic-compatible ANTHROPIC_BASE_URL gateway`,
    )
  }

  const upstream = validateUpstream(
    process.env.ANTHROPIC_BASE_URL ?? DEFAULT_UPSTREAM,
  )
  return {
    provider: 'anthropic',
    upstream,
    getAuth: async () => {
      if (process.env.ANTHROPIC_AUTH_TOKEN) {
        return {
          kind: 'api-key',
          headers: {
            authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
          },
        }
      }
      if (process.env.ANTHROPIC_API_KEY) {
        return {
          kind: 'api-key',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY },
        }
      }

      await checkAndRefreshOAuthTokenIfNeeded()
      const auth = getAuthHeaders()
      if (auth.error) throw new Error(auth.error)
      return {
        kind: getClaudeAIOAuthTokens()?.accessToken ? 'oauth' : 'api-key',
        headers: auth.headers,
      }
    },
  }
}

export type SSHAuthProxy = SSHProxyRouting & {
  socketPath: string
  stop: () => void
}

type ProxyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type StartSSHAuthProxyOptions = {
  socketPath: string
  provider?: SSHProxyProvider
  upstream?: string
  getAuth?: () => SSHProxyAuth | Promise<SSHProxyAuth>
  fetch?: ProxyFetch
}

function requestHeaders(
  req: IncomingMessage,
  authHeaders: Record<string, string>,
  upstream: URL,
): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const normalized = name.toLowerCase()
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      AUTH_HEADERS.has(normalized) ||
      normalized === 'host'
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value)
  }
  headers.set('host', upstream.host)
  return headers
}

async function readRequestBody(
  req: IncomingMessage,
): Promise<ArrayBuffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const declaredLength = Number(req.headers['content-length'])
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BODY_BYTES
  ) {
    throw new RequestBodyTooLargeError()
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError()
    }
    chunks.push(buffer)
  }
  return chunks.length > 0
    ? Uint8Array.from(Buffer.concat(chunks, size)).buffer
    : undefined
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`SSH auth proxy request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`)
  }
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<
    Pick<StartSSHAuthProxyOptions, 'provider' | 'upstream' | 'getAuth' | 'fetch'>
  >,
): Promise<void> {
  try {
    const requested = new URL(req.url || '/', 'http://unix-socket')
    const allowedRoute =
      req.method === 'POST' &&
      (opts.provider === 'openai'
        ? requested.pathname === '/responses'
        : requested.pathname === '/v1/messages' ||
          requested.pathname === '/v1/messages/count_tokens')
    if (!allowedRoute) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`Unsupported SSH ${opts.provider} proxy route`)
      return
    }
    const upstreamBase = new URL(`${opts.upstream.replace(/\/$/, '')}/`)
    const upstream = new URL(
      `${requested.pathname.replace(/^\//, '')}${requested.search}`,
      upstreamBase,
    )
    const body = await readRequestBody(req)
    const auth = await opts.getAuth()
    const response = await opts.fetch(upstream, {
      method: req.method,
      headers: requestHeaders(req, auth.headers, upstream),
      body,
      redirect: 'manual',
    })

    res.statusCode = response.status
    res.statusMessage = response.statusText
    response.headers.forEach((value, name) => {
      const normalized = name.toLowerCase()
      if (
        !HOP_BY_HOP_HEADERS.has(normalized) &&
        !RESPONSE_HEADERS_TO_STRIP.has(normalized)
      ) {
        res.setHeader(name, value)
      }
    })
    if (!response.body) {
      res.end()
      return
    }
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(value)) {
        await new Promise<void>(resolve => res.once('drain', resolve))
      }
    }
    res.end()
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = error instanceof RequestBodyTooLargeError ? 413 : 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    res.end(
      `SSH auth proxy error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function startSSHAuthProxy(
  options: StartSSHAuthProxyOptions,
): Promise<SSHAuthProxy> {
  const defaults = options.getAuth
    ? undefined
    : resolveSSHAuthProxyOptions()
  const provider = options.provider ?? defaults?.provider ?? 'anthropic'
  const getAuth = options.getAuth ?? defaults!.getAuth
  const initialAuth = await getAuth()
  const openAIAuthMode =
    provider === 'openai'
      ? initialAuth.kind === 'oauth'
        ? 'chatgpt'
        : 'platform'
      : undefined
  const upstream = validateUpstream(
    options.upstream ??
      (provider === 'openai' && openAIAuthMode === 'chatgpt'
        ? CHATGPT_UPSTREAM
        : defaults?.upstream) ??
      (provider === 'openai' ? DEFAULT_OPENAI_UPSTREAM : DEFAULT_UPSTREAM),
  )
  const fetchImpl = options.fetch ?? globalThis.fetch

  await mkdir(dirname(options.socketPath), { recursive: true })
  rmSync(options.socketPath, { force: true })

  const server = createServer((req, res) => {
    void proxyRequest(req, res, {
      provider,
      upstream,
      getAuth,
      fetch: fetchImpl,
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.socketPath)
  })
  chmodSync(options.socketPath, 0o600)

  let stopped = false
  return {
    socketPath: options.socketPath,
    provider,
    authKind: initialAuth.kind,
    ...(openAIAuthMode ? { openAIAuthMode } : {}),
    stop: () => {
      if (stopped) return
      stopped = true
      server.close()
      rmSync(options.socketPath, { force: true })
    },
  }
}
