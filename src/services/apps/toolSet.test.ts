import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import type { ScopedMcpServerConfig } from '../mcp/types.js'
import {
  getHostOwnedCodexAppsKind,
  isHostOwnedCodexAppsConfig,
} from './trust.js'
import {
  createCodexAppsOAuthFetch,
  createCodexAppsTransport,
  getCodexAppsProxyFetchOptions,
  isAllowedCodexAppsRequestUrl,
} from './transport.js'
import { shouldUseSharedMcpAuth } from '../mcp/client.js'
import { withCodexAppsToolSet } from './toolSet.js'
import {
  CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
  CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME,
  CODEX_APPS_SERVER_NAME,
} from './types.js'

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalAppsDisabled = process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
const originalProxyEnv = {
  https_proxy: process.env.https_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
}

afterEach(() => {
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalAppsDisabled === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
  } else {
    process.env.CLAUDE_CODE_DISABLE_CODEX_APPS = originalAppsDisabled
  }
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getOpenAIAuthInfo.cache.clear?.()
})

describe('Codex Apps ToolSet eligibility', () => {
  it('is absent outside the OpenAI provider', () => {
    delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
    delete process.env.CLAUDE_CODE_USE_OPENAI
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      isChatGPT: true,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })

  it('rejects OpenAI API-key authentication', () => {
    delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'api-key',
      isChatGPT: false,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })

  it('installs a trusted host-owned config only for ChatGPT OAuth', () => {
    delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      accountId: 'account-123',
      isChatGPT: true,
    })
    const untrusted: ScopedMcpServerConfig = {
      type: 'http',
      url: 'https://example.com/mcp',
      scope: 'project',
    }
    assert.equal(isHostOwnedCodexAppsConfig(untrusted), false)

    const configs = withCodexAppsToolSet({
      [CODEX_APPS_SERVER_NAME]: untrusted,
      [CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]: untrusted,
    })
    assert.equal(
      isHostOwnedCodexAppsConfig(configs[CODEX_APPS_SERVER_NAME]!),
      true,
    )
    assert.equal(
      isHostOwnedCodexAppsConfig(
        configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]!,
      ),
      true,
    )
    assert.equal(
      getHostOwnedCodexAppsKind(configs[CODEX_APPS_SERVER_NAME]!),
      'connectors',
    )
    assert.equal(
      getHostOwnedCodexAppsKind(
        configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]!,
      ),
      'plugins',
    )
    assert.equal(
      configs[CODEX_APPS_SERVER_NAME]?.type === 'http' &&
        configs[CODEX_APPS_SERVER_NAME].url,
      'https://chatgpt.com/backend-api/wham/apps',
    )
    assert.equal(
      configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]?.type === 'http' &&
        configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME].url,
      CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
    )
    assert.equal(
      shouldUseSharedMcpAuth(configs[CODEX_APPS_SERVER_NAME]!),
      false,
    )
    assert.equal(
      shouldUseSharedMcpAuth(
        configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]!,
      ),
      false,
    )
    assert.equal(shouldUseSharedMcpAuth(untrusted), true)
  })

  it('is enabled by default when ChatGPT OAuth is present', () => {
    delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      isChatGPT: true,
    })
    const configs = withCodexAppsToolSet({})
    assert.equal(
      isHostOwnedCodexAppsConfig(configs[CODEX_APPS_SERVER_NAME]!),
      true,
    )
    assert.equal(
      isHostOwnedCodexAppsConfig(
        configs[CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME]!,
      ),
      true,
    )
  })

  it('is disabled only when CLAUDE_CODE_DISABLE_CODEX_APPS=1', () => {
    process.env.CLAUDE_CODE_DISABLE_CODEX_APPS = '1'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      isChatGPT: true,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })
})

describe('Codex Apps transport origin boundary', () => {
  it('accepts only the two fixed ChatGPT Apps endpoints', () => {
    assert.equal(
      isAllowedCodexAppsRequestUrl(
        'https://chatgpt.com/backend-api/wham/apps?session=1',
      ),
      true,
    )
    assert.equal(
      isAllowedCodexAppsRequestUrl(
        'https://chatgpt.com/backend-api/ps/mcp?session=1',
      ),
      true,
    )
    assert.equal(
      isAllowedCodexAppsRequestUrl(
        'https://example.com/backend-api/wham/apps',
      ),
      false,
    )
    assert.equal(
      isAllowedCodexAppsRequestUrl('https://chatgpt.com/redirect'),
      false,
    )
  })

  it('refreshes OAuth and retries exactly once after a 401', async () => {
    const authRequests: boolean[] = []
    const requests: Array<{
      authorization: string | null
      accountId: string | null
    }> = []
    const fetchWithOAuth = createCodexAppsOAuthFetch({
      resolveAuth: async ({ forceRefresh = false } = {}) => {
        authRequests.push(forceRefresh)
        return {
          accessToken: forceRefresh ? 'refreshed-token' : 'oauth-token',
          accountId: 'account-123',
          isChatGPT: true,
        }
      },
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          authorization: headers.get('authorization'),
          accountId: headers.get('chatgpt-account-id'),
        })
        return new Response(null, { status: requests.length === 1 ? 401 : 200 })
      },
      userAgent: () => 'claude-code/test',
    })

    const response = await fetchWithOAuth(CODEX_APPS_PLUGIN_RUNTIME_MCP_URL)

    assert.equal(response.status, 200)
    assert.deepEqual(authRequests, [false, true])
    assert.deepEqual(requests, [
      { authorization: 'Bearer oauth-token', accountId: 'account-123' },
      { authorization: 'Bearer refreshed-token', accountId: 'account-123' },
    ])
  })

  it('uses https_proxy for both Codex Apps clients', () => {
    process.env.https_proxy = 'http://127.0.0.1:7890'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7891'
    process.env.http_proxy = 'http://127.0.0.1:7892'

    const options = getCodexAppsProxyFetchOptions()
    if (typeof Bun !== 'undefined') {
      assert.equal(options.proxy, 'http://127.0.0.1:7890')
    } else {
      assert.ok(options.dispatcher)
    }

    const connectorTransport = createCodexAppsTransport({
      type: 'http',
      url: 'https://chatgpt.com/backend-api/wham/apps',
      scope: 'dynamic',
    })
    const pluginTransport = createCodexAppsTransport({
      type: 'http',
      url: CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
      scope: 'dynamic',
    })
    assert.deepEqual(
      (connectorTransport as unknown as { _requestInit: object })._requestInit,
      options,
    )
    assert.deepEqual(
      (pluginTransport as unknown as { _requestInit: object })._requestInit,
      options,
    )
  })

  it('uses the default direct fetch path when no proxy is configured', () => {
    delete process.env.https_proxy
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.HTTP_PROXY

    const options = getCodexAppsProxyFetchOptions()
    assert.equal('proxy' in options, false)
    assert.equal('dispatcher' in options, false)
    assert.equal('unix' in options, false)
  })

  it('supports uppercase HTTPS_PROXY when lowercase is absent', () => {
    delete process.env.https_proxy
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8890'
    delete process.env.http_proxy
    delete process.env.HTTP_PROXY

    const options = getCodexAppsProxyFetchOptions()
    if (typeof Bun !== 'undefined') {
      assert.equal(options.proxy, 'http://127.0.0.1:8890')
    } else {
      assert.ok(options.dispatcher)
    }
  })
})
