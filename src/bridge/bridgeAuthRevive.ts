import {
  getClaudeAIOAuthTokensAsync,
  getOauthAccountInfo,
} from '../utils/auth.js'

// Auth-revive watcher for Remote Control (official 2.1.325): after an auth
// failure, a fresh sign-in to the same account turns the bridge back on.

/** How often the watcher re-reads the stored credential. */
export const AUTH_REVIVE_POLL_MS = 300_000

/** Unattended revives allowed before only an in-process /login can revive. */
export const MAX_UNATTENDED_AUTH_REVIVES = 10

/** Baseline while the credential read at failure time is still in flight. */
export const AUTH_BASELINE_PENDING: unique symbol = Symbol('baseline-pending')

/** The token the bridge failed with; undefined means any token counts as fresh. */
export type AuthBaselineToken = string | undefined | typeof AUTH_BASELINE_PENDING

export type BridgeAccount = {
  accountUuid?: string
  organizationUuid?: string
}

export type BridgeCredential = BridgeAccount & { accessToken: string }

export function accountOfCurrentLogin(): BridgeAccount | undefined {
  const account = getOauthAccountInfo()
  if (!account) return undefined
  return {
    accountUuid: account.accountUuid,
    organizationUuid: account.organizationUuid,
  }
}

/** Reads the stored token (not the in-memory cache) and the account it belongs to. */
export async function readBridgeCredential(): Promise<BridgeCredential | undefined> {
  const tokens = await getClaudeAIOAuthTokensAsync().catch(() => null)
  if (!tokens?.accessToken) return undefined
  return { accessToken: tokens.accessToken, ...accountOfCurrentLogin() }
}

export function sameBridgeAccount(a: BridgeAccount, b: BridgeAccount): boolean {
  if (a.accountUuid !== b.accountUuid) return false
  if (a.organizationUuid !== undefined && b.organizationUuid !== undefined) {
    return a.organizationUuid === b.organizationUuid
  }
  return true
}

/** Past the cap, keep polling but revive only after an in-process /login. */
export function shouldBrakeAuthRevive(
  signedInSinceFailure: boolean,
  revives: number,
): boolean {
  return !signedInSinceFailure && revives >= MAX_UNATTENDED_AUTH_REVIVES
}

/**
 * One watcher tick. 'revive' for a fresh token on the same account,
 * 'disarm' for another account (that's /login's business), else 'wait'.
 */
export function decideAuthRevive({
  baseline,
  baselineAccount,
  credential,
}: {
  baseline: AuthBaselineToken
  baselineAccount: BridgeAccount | undefined
  credential: BridgeCredential | undefined
}): 'revive' | 'disarm' | 'wait' {
  if (baseline === AUTH_BASELINE_PENDING) return 'wait'
  if (
    credential === undefined ||
    credential.accessToken === baseline ||
    credential.accountUuid === undefined ||
    baselineAccount?.accountUuid === undefined
  ) {
    return 'wait'
  }
  return sameBridgeAccount(credential, baselineAccount) ? 'revive' : 'disarm'
}
