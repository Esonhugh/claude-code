import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'bun:test'
import {
  resetStateForTests,
  setAllowedSettingSources,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
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
