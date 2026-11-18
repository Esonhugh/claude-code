import { afterEach, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import { resetSettingsCache, setSessionSettingsCache } from './settingsCache.js'
import { DEFAULT_CLIENT_VERSIONS } from '../../constants/clientVersions.js'
import { getClientVersions, settingsMergeCustomizer } from './settings.js'
import mergeWith from 'lodash-es/mergeWith.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'
import { getMCPUserAgent, getUserAgent, getWebFetchUserAgent } from '../http.js'

afterEach(resetSettingsCache)

test.each(['', ' ', '1.2\r\nInjected: yes', '1.2\n', '1.2\u0000'])('versionNumber rejects unsafe header value %j', value => {
  for (const field of ['ClaudeOAuthClientVersion', 'ClaudeApiClientVersion', 'CodexVersion', 'ClaudeSDKVersion']) {
    expect(SettingsSchema().safeParse({ versionNumber: { [field]: value } }).success).toBe(false)
  }
})

test('versionNumber supports a partial object and preserves field casing in JSON schema', () => {
  expect(SettingsSchema().parse({ versionNumber: { CodexVersion: 'custom-dev+build' } }).versionNumber).toEqual({ CodexVersion: 'custom-dev+build' })
  const schema = JSON.parse(generateSettingsJSONSchema())
  expect(Object.keys(schema.properties.versionNumber.properties)).toEqual([
    'ClaudeOAuthClientVersion', 'ClaudeApiClientVersion', 'CodexVersion', 'ClaudeSDKVersion',
  ])
  expect(schema.properties.versionNumber.required ?? []).toEqual([])
})

test.each([null, [], '2.1.327', { CodexVersion: 170 }].map(value => [value]))('versionNumber rejects invalid object/field types %j', versionNumber => {
  expect(SettingsSchema().safeParse({ versionNumber }).success).toBe(false)
})

test('default versions do not depend on the build macro', () => {
  setSessionSettingsCache({ settings: {}, errors: [] })
  expect(getClientVersions()).toEqual(DEFAULT_CLIENT_VERSIONS)
  expect(getUserAgent()).toStartWith('claude-cli/2.1.327 ')
})

test('partial versions fall back per field and follow settings cache changes', () => {
  setSessionSettingsCache({ settings: { versionNumber: { CodexVersion: 'custom-next' } }, errors: [] })
  expect(getClientVersions()).toEqual({ ...DEFAULT_CLIENT_VERSIONS, CodexVersion: 'custom-next' })
  setSessionSettingsCache({ settings: { versionNumber: { ClaudeApiClientVersion: 'api-next' } }, errors: [] })
  expect(getClientVersions()).toEqual({ ...DEFAULT_CLIENT_VERSIONS, ClaudeApiClientVersion: 'api-next' })
  expect(getUserAgent()).toStartWith('claude-cli/api-next ')
  expect(getMCPUserAgent()).toStartWith('claude-code/api-next')
  expect(getClaudeCodeUserAgent(getClientVersions().ClaudeApiClientVersion)).toBe('claude-code/api-next')
  expect(getWebFetchUserAgent()).toContain('claude-code/api-next')
})

test('existing settings merge preserves partial version fields across sources', () => {
  const merged = mergeWith({},
    SettingsSchema().parse({ versionNumber: { ClaudeOAuthClientVersion: 'oauth-base', CodexVersion: 'codex-base' } }),
    SettingsSchema().parse({ versionNumber: { CodexVersion: 'codex-override', ClaudeSDKVersion: 'sdk-override' } }),
    settingsMergeCustomizer,
  )
  setSessionSettingsCache({ settings: merged, errors: [] })
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: 'oauth-base', ClaudeApiClientVersion: '2.1.327',
    CodexVersion: 'codex-override', ClaudeSDKVersion: 'sdk-override',
  })
})
