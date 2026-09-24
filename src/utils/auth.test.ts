import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setAllowedSettingSources,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
import * as auth from './auth.js'
import {
  getConfiguredSettingsAuthHelper,
} from './auth.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const helperSettings = {
  apiKeyHelper: 'local-api-key-helper',
  awsAuthRefresh: 'local-aws-auth-refresh',
  awsCredentialExport: 'local-aws-credential-export',
  gcpAuthRefresh: 'local-gcp-auth-refresh',
} as const

const previousProviderManaged =
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
  resetStateForTests()
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsInline(helperSettings)
  resetSettingsCache()
})

afterEach(() => {
  if (previousProviderManaged === undefined) {
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
  } else {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = previousProviderManaged
  }
  setFlagSettingsInline(null)
  resetSettingsCache()
})

describe('Mods first-party credential selection', () => {
  const authVariables = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
  ] as const
  const saved = Object.fromEntries(
    authVariables.map(name => [name, process.env[name]]),
  )

  beforeEach(() => {
    for (const name of authVariables) delete process.env[name]
    setFlagSettingsInline(null)
    resetSettingsCache()
    auth.clearOAuthTokenCache()
  })

  afterEach(() => {
    for (const name of authVariables) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    auth.clearOAuthTokenCache()
  })

  test('prefers the current Claude OAuth access token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-only-oauth-token'

    expect(await auth.getFirstPartyCredential()).toEqual({
      kind: 'bearer',
      secret: 'test-only-oauth-token',
    })
  })

  test('uses an Anthropic API key when Claude OAuth is not active', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-only-api-key'

    expect(await auth.getFirstPartyCredential()).toEqual({
      kind: 'api-key',
      secret: 'test-only-api-key',
    })
  })

  test.each(['bedrock', 'vertex', 'foundry', 'openai'] as const)(
    'does not expose Anthropic credentials while using %s',
    async provider => {
      const variable = {
        bedrock: 'CLAUDE_CODE_USE_BEDROCK',
        vertex: 'CLAUDE_CODE_USE_VERTEX',
        foundry: 'CLAUDE_CODE_USE_FOUNDRY',
        openai: 'CLAUDE_CODE_USE_OPENAI',
      }[provider]
      process.env[variable] = '1'
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-only-oauth-token'
      process.env.ANTHROPIC_API_KEY = 'test-only-api-key'

      expect(await auth.getFirstPartyCredential()).toBeNull()
    },
  )
})

describe('host-managed inference auth helpers', () => {
  test('uses settings helpers in an ordinary local process', () => {
    for (const [name, command] of Object.entries(helperSettings)) {
      assert.equal(
        getConfiguredSettingsAuthHelper(
          name as keyof typeof helperSettings,
        ),
        command,
      )
    }
  })

  test('hides every settings auth helper from a host-managed child', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'

    for (const name of Object.keys(helperSettings)) {
      assert.equal(
        getConfiguredSettingsAuthHelper(
          name as keyof typeof helperSettings,
        ),
        undefined,
      )
    }
  })
})
