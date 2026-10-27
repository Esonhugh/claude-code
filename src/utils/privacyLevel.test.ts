import { afterEach, expect, test } from 'bun:test'
import { getEssentialTrafficOnlyReason, getPrivacyLevel } from './privacyLevel.js'

const saved = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('privacy env vars count as set by presence, like official, so =0 still restricts', () => {
  delete process.env.DISABLE_TELEMETRY
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  expect(getPrivacyLevel()).toBe('essential-traffic')
  expect(getEssentialTrafficOnlyReason()).toBe('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  expect(getEssentialTrafficOnlyReason()).toBeNull()
  process.env.DISABLE_TELEMETRY = '0'
  expect(getPrivacyLevel()).toBe('no-telemetry')
})

test('DO_NOT_TRACK=1 disables telemetry like DISABLE_TELEMETRY', () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  delete process.env.DISABLE_TELEMETRY
  process.env.DO_NOT_TRACK = '1'
  expect(getPrivacyLevel()).toBe('no-telemetry')
  process.env.DO_NOT_TRACK = '0'
  expect(getPrivacyLevel()).toBe('default')
})
