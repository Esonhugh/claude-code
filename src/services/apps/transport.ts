import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { OPENAI_OAUTH_ORIGINATOR } from '../openai-oauth/client.js'
import { requireCodexAppsOAuth } from './auth.js'
import type { CodexAppsMcpConfig } from './types.js'
import {
  CODEX_APPS_MCP_URL,
  CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
} from './types.js'

export function getCodexAppsProxyFetchOptions(): ReturnType<
  typeof getProxyFetchOptions
> {
  // Keep this on the shared fetch path used by the OpenAI Responses API. Bun
  // receives `proxy`; Node receives an undici `dispatcher` with NO_PROXY,
  // custom CA and mTLS handling.
  return getProxyFetchOptions()
}

const CODEX_APPS_MCP_URLS = [
  CODEX_APPS_MCP_URL,
  CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
]

export function isAllowedCodexAppsRequestUrl(value: string | URL): boolean {
  try {
    const url = new URL(value)
    return CODEX_APPS_MCP_URLS.some(value => {
      const allowed = new URL(value)
      return url.origin === allowed.origin && url.pathname === allowed.pathname
    })
  } catch {
    return false
  }
}

const requestWithOAuth = async (
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
  forceRefresh: boolean,
): Promise<Response> => {
  const requestUrl = input instanceof Request ? input.url : input
  if (!isAllowedCodexAppsRequestUrl(requestUrl)) {
    throw new Error('Refusing to send Codex Apps OAuth to an untrusted URL')
  }
  const auth = await requireCodexAppsOAuth({ forceRefresh })
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${auth.accessToken}`)
  headers.set('User-Agent', getMCPUserAgent())
  headers.set('X-OpenAI-Product-Sku', 'codex')
  headers.set('originator', OPENAI_OAUTH_ORIGINATOR)
  headers.set('Origin', 'https://chatgpt.com')
  headers.set('Referer', 'https://chatgpt.com/')
  if (auth.accountId) headers.set('chatgpt-account-id', auth.accountId)
  else headers.delete('chatgpt-account-id')

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return fetch(input, {
    ...init,
    ...getCodexAppsProxyFetchOptions(),
    redirect: 'manual',
    headers,
  })
}

const fetchWithCodexAppsOAuth: FetchLike = async (input, init) => {
  const response = await requestWithOAuth(input, init, false)
  if (response.status !== 401) return response

  // The Apps transport is account-scoped. Refresh through the shared Codex
  // auth store, then retry exactly once with the newly resolved identity.
  return requestWithOAuth(input, init, true)
}

export function createCodexAppsTransport(
  config: CodexAppsMcpConfig,
): StreamableHTTPClientTransport {
  const options: StreamableHTTPClientTransportOptions = {
    fetch: fetchWithCodexAppsOAuth,
    requestInit: {
      ...getCodexAppsProxyFetchOptions(),
    },
  }
  return new StreamableHTTPClientTransport(new URL(config.url), options)
}
