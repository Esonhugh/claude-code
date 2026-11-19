import { describe, expect, test } from 'bun:test'
import {
  AUTH_BASELINE_PENDING,
  decideAuthRevive,
  MAX_UNATTENDED_AUTH_REVIVES,
  sameBridgeAccount,
  shouldBrakeAuthRevive,
} from './bridgeAuthRevive.js'

const acct1 = { accountUuid: 'acct-1', organizationUuid: 'org-1' }

describe('auth-revive decision (official 2.1.325)', () => {
  test('waits while the baseline read is still in flight', () => {
    expect(decideAuthRevive({ baseline: AUTH_BASELINE_PENDING, baselineAccount: acct1, credential: { accessToken: 'new', ...acct1 } })).toBe('wait')
  })

  test('waits with no credential or the same token that failed', () => {
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: acct1, credential: undefined })).toBe('wait')
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: acct1, credential: { accessToken: 'old', ...acct1 } })).toBe('wait')
  })

  test('waits while either account is unknown', () => {
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: undefined, credential: { accessToken: 'new', ...acct1 } })).toBe('wait')
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: acct1, credential: { accessToken: 'new' } })).toBe('wait')
  })

  test('revives on a fresh token for the same account', () => {
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: acct1, credential: { accessToken: 'new', ...acct1 } })).toBe('revive')
    // A baseline of undefined (no token at failure time) counts any token as fresh.
    expect(decideAuthRevive({ baseline: undefined, baselineAccount: acct1, credential: { accessToken: 'new', ...acct1 } })).toBe('revive')
  })

  test('disarms on a different account', () => {
    expect(decideAuthRevive({ baseline: 'old', baselineAccount: acct1, credential: { accessToken: 'new', accountUuid: 'acct-2' } })).toBe('disarm')
  })
})

describe('account match', () => {
  test('compares the org only when both sides know it', () => {
    expect(sameBridgeAccount(acct1, { accountUuid: 'acct-1' })).toBe(true)
    expect(sameBridgeAccount(acct1, { accountUuid: 'acct-1', organizationUuid: 'org-2' })).toBe(false)
    expect(sameBridgeAccount(acct1, { accountUuid: 'acct-2', organizationUuid: 'org-1' })).toBe(false)
  })
})

describe('revive brake', () => {
  test('engages after the cap unless /login ran since the failure', () => {
    expect(MAX_UNATTENDED_AUTH_REVIVES).toBe(10)
    expect(shouldBrakeAuthRevive(false, 9)).toBe(false)
    expect(shouldBrakeAuthRevive(false, 10)).toBe(true)
    expect(shouldBrakeAuthRevive(true, 10)).toBe(false)
  })
})
