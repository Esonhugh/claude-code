import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import type { ScopedMcpServerConfig } from '../mcp/types.js'
import { isHostOwnedCodexAppsConfig } from './trust.js'
import {
  getCodexAppsProxyFetchOptions,
  isAllowedCodexAppsRequestUrl,
} from './transport.js'
import { withCodexAppsToolSet } from './toolSet.js'

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalApps = process.env.CLAUDE_CODE_ENABLE_CODEX_APPS
const originalProxyEnv = {
  https_proxy: process.env.https_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
}

afterEach(() => {
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalApps === undefined) delete process.env.CLAUDE_CODE_ENABLE_CODEX_APPS
  else process.env.CLAUDE_CODE_ENABLE_CODEX_APPS = originalApps
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getOpenAIAuthInfo.cache.clear?.()
})

describe('Codex Apps ToolSet eligibility', () => {
  it('is absent outside the OpenAI provider', () => {
    process.env.CLAUDE_CODE_ENABLE_CODEX_APPS = '1'
    delete process.env.CLAUDE_CODE_USE_OPENAI
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      isChatGPT: true,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })

  it('rejects OpenAI API-key authentication', () => {
    process.env.CLAUDE_CODE_ENABLE_CODEX_APPS = '1'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'api-key',
      isChatGPT: false,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })

  it('installs a trusted host-owned config only for ChatGPT OAuth', () => {
    process.env.CLAUDE_CODE_ENABLE_CODEX_APPS = '1'
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

    const configs = withCodexAppsToolSet({ codex_apps: untrusted })
    assert.equal(isHostOwnedCodexAppsConfig(configs.codex_apps!), true)
    assert.equal(
      configs.codex_apps?.type === 'http' && configs.codex_apps.url,
      'https://chatgpt.com/backend-api/wham/apps',
    )
  })

  it('is disabled by default even when ChatGPT OAuth is present', () => {
    delete process.env.CLAUDE_CODE_ENABLE_CODEX_APPS
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'oauth-token',
      isChatGPT: true,
    })
    assert.deepEqual(withCodexAppsToolSet({}), {})
  })
})

describe('Codex Apps transport origin boundary', () => {
  it('accepts only the fixed ChatGPT Apps endpoint', () => {
    assert.equal(
      isAllowedCodexAppsRequestUrl(
        'https://chatgpt.com/backend-api/wham/apps?session=1',
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

  it('uses https_proxy with the same precedence as other HTTP API clients', () => {
    process.env.https_proxy = 'http://127.0.0.1:7890'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7891'
    process.env.http_proxy = 'http://127.0.0.1:7892'

    const options = getCodexAppsProxyFetchOptions()
    if (typeof Bun !== 'undefined') {
      assert.equal(options.proxy, 'http://127.0.0.1:7890')
    } else {
      assert.ok(options.dispatcher)
    }
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
