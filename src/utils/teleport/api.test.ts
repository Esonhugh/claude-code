import { afterEach, beforeEach, expect, test } from 'bun:test'
import { DEFAULT_CLIENT_VERSIONS } from '../../constants/clientVersions.js'
import { resetSettingsCache, setSessionSettingsCache } from '../settings/settingsCache.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  ...(globalThis as typeof globalThis & { MACRO?: MacroGlobals }).MACRO,
  VERSION: '9.9.9',
} as MacroGlobals

beforeEach(() => setSessionSettingsCache({ settings: {}, errors: [] }))
afterEach(resetSettingsCache)

test('getOAuthHeaders uses the default API client version instead of the build version', async () => {
  const { getOAuthHeaders } = await import('./api.js')
  expect(getOAuthHeaders('tok')).toEqual({
    'User-Agent': `claude-code/${DEFAULT_CLIENT_VERSIONS.ClaudeApiClientVersion}`,
    Authorization: 'Bearer tok',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  })
})

test('getOAuthHeaders follows API client version overrides without using the OAuth model version', async () => {
  const { getOAuthHeaders } = await import('./api.js')
  for (const version of ['api-custom', 'api-next']) {
    setSessionSettingsCache({
      settings: {
        versionNumber: {
          ClaudeOAuthClientVersion: 'oauth-custom',
          ClaudeApiClientVersion: version,
        },
      },
      errors: [],
    })
    expect(getOAuthHeaders('tok')).toEqual({
      'User-Agent': `claude-code/${version}`,
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    })
  }
})

test('getOAuthHeaders preserves the API default when only another version is configured', async () => {
  const { getOAuthHeaders } = await import('./api.js')
  setSessionSettingsCache({
    settings: { versionNumber: { ClaudeOAuthClientVersion: 'oauth-custom' } },
    errors: [],
  })
  expect(getOAuthHeaders('tok')).toEqual({
    'User-Agent': `claude-code/${DEFAULT_CLIENT_VERSIONS.ClaudeApiClientVersion}`,
    Authorization: 'Bearer tok',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  })
})
