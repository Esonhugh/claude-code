import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'

const configDir = mkdtempSync(join(tmpdir(), 'policy-limits-ua-'))
const envKeys = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const
const savedEnv = envKeys.map(key => process.env[key])
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder'
// An env OAuth token has no refresh token, so the refresh check never reads the keychain.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-only-not-a-real-token'
delete process.env.ANTHROPIC_BASE_URL

const get = spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} } as never)
const { _resetPolicyLimitsForTesting, refreshPolicyLimits } = await import('./index.js')

afterEach(() => {
  get.mockClear()
  _resetPolicyLimitsForTesting()
  resetSettingsCache()
})
afterAll(() => {
  get.mockRestore()
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[i]
  })
  rmSync(configDir, { recursive: true, force: true })
})

test.each([
  [undefined, 'claude-code/2.1.327'],
  ['api-custom', 'claude-code/api-custom'],
])('policy limits request User-Agent follows ClaudeApiClientVersion %p', async (version, userAgent) => {
  setSessionSettingsCache({
    settings: version ? { versionNumber: { ClaudeApiClientVersion: version, ClaudeOAuthClientVersion: 'oauth-unused' } } : {},
    errors: [],
  })
  await refreshPolicyLimits()
  expect(get).toHaveBeenCalledTimes(1)
  const [url, config] = get.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
  expect(url).toEndWith('/api/claude_code/policy_limits')
  expect(config.headers['User-Agent']).toBe(userAgent)
  expect(config.headers['x-api-key']).toBe('sk-ant-test-placeholder')
})
