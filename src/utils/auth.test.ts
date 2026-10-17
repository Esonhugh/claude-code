import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'bun:test'
import {
  getAllowedSettingSources,
  resetStateForTests,
  setAllowedSettingSources,
  setApiKeyFromFd,
  setFlagSettingsInline,
  setOauthTokenFromFd,
} from '../bootstrap/state.js'
import {
  getAnthropicApiKeyWithSource,
  getConfiguredSettingsAuthHelper,
  getSubscriptionType,
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
const previousSettingSources = getAllowedSettingSources()

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
  setAllowedSettingSources(previousSettingSources)
  resetSettingsCache()
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

describe('CI api key guard', () => {
  const guardEnvKeys = [
    'CI',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK',
  ] as const
  let previousEnv: Partial<Record<(typeof guardEnvKeys)[number], string>> = {}

  beforeEach(() => {
    previousEnv = {}
    for (const key of guardEnvKeys) {
      previousEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CI = 'true'
    // No apiKeyHelper: the guard must decide on env vars and provider alone.
    setFlagSettingsInline(null)
    resetSettingsCache()
    // Pre-seed the FD credential caches so the CCR well-known files on this
    // host (if any) do not count as a credential source.
    setApiKeyFromFd(null)
    setOauthTokenFromFd(null)
  })

  afterEach(() => {
    for (const key of guardEnvKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previousEnv[key]
      }
    }
  })

  test('accepts ANTHROPIC_AUTH_TOKEN as the only credential', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-token'

    assert.deepEqual(getAnthropicApiKeyWithSource(), { key: null, source: 'none' })
    assert.equal(getSubscriptionType(), null)
  })

  test('does not require first-party credentials for a third-party provider', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    assert.deepEqual(getAnthropicApiKeyWithSource(), { key: null, source: 'none' })
    assert.equal(getSubscriptionType(), null)
  })

  test('still throws when no credential source is configured', () => {
    assert.throws(
      () => getAnthropicApiKeyWithSource(),
      /ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN/,
    )
  })
})
