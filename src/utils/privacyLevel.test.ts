import { afterEach, expect, test } from 'bun:test'
import { getEssentialTrafficOnlyReason, getPrivacyLevel } from './privacyLevel.js'

const saved = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY,
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC follows env truthiness, so =0 keeps the default level', () => {
  delete process.env.DISABLE_TELEMETRY
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  expect(getPrivacyLevel()).toBe('default')
  expect(getEssentialTrafficOnlyReason()).toBeNull()
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  expect(getPrivacyLevel()).toBe('essential-traffic')
  expect(getEssentialTrafficOnlyReason()).toBe('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
})
