import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'bun:test'

import {
  resetStateForTests,
  setAllowedSettingSources,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from './managedEnv.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const keys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OPENAI_AUTH_MODE',
  'CLAUDE_CODE_OPENAI_UNIX_SOCKET',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'SSH_TEST_PASSTHROUGH',
] as const

const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  resetStateForTests()
  setAllowedSettingSources(['flagSettings'])
  for (const key of keys) delete process.env[key]
  resetSettingsCache()
})

afterEach(() => {
  for (const key of keys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setFlagSettingsInline(null)
  resetSettingsCache()
})

test('SSH tunnel routing is not overridden by settings env', () => {
  process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/host-api.sock'
  setFlagSettingsInline({
    env: {
      ANTHROPIC_API_KEY: 'settings-key',
      ANTHROPIC_BASE_URL: 'https://settings.example',
      ANTHROPIC_UNIX_SOCKET: '/tmp/settings-api.sock',
      CLAUDE_CODE_OPENAI_AUTH_MODE: 'platform',
      CLAUDE_CODE_OPENAI_UNIX_SOCKET: '/tmp/settings-openai.sock',
      OPENAI_API_KEY: 'settings-openai-key',
      OPENAI_BASE_URL: 'https://openai.example',
      SSH_TEST_PASSTHROUGH: 'kept',
    },
  })
  resetSettingsCache()

  applySafeConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()

  assert.equal(process.env.ANTHROPIC_UNIX_SOCKET, '/tmp/host-api.sock')
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(process.env.CLAUDE_CODE_OPENAI_AUTH_MODE, undefined)
  assert.equal(process.env.CLAUDE_CODE_OPENAI_UNIX_SOCKET, undefined)
  assert.equal(process.env.OPENAI_API_KEY, undefined)
  assert.equal(process.env.OPENAI_BASE_URL, undefined)
  assert.equal(process.env.SSH_TEST_PASSTHROUGH, 'kept')
})

test('host-managed provider routing is not overridden by settings env', () => {
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  setFlagSettingsInline({
    env: {
      ANTHROPIC_API_KEY: 'settings-key',
      ANTHROPIC_BASE_URL: 'https://settings.example',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'settings-model',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0',
      CLAUDE_CODE_USE_OPENAI: '0',
      OPENAI_API_KEY: 'settings-openai-key',
      SSH_TEST_PASSTHROUGH: 'kept',
    },
  })
  resetSettingsCache()

  applySafeConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()

  assert.equal(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
  assert.equal(process.env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined)
  assert.equal(process.env.OPENAI_API_KEY, undefined)
  assert.equal(process.env.SSH_TEST_PASSTHROUGH, 'kept')
})
