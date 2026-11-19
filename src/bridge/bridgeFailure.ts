import type { BridgeErrorKind } from './replBridge.js'

// Remote Control failure texts and per-kind hints (official 2.1.325).

/** Notification key shared by every Remote Control failure. */
export const BRIDGE_FAILED_NOTIFICATION_KEY = 'bridge-failed'

/** Detail when the bridge needs a claude.ai sign-in. */
export const BRIDGE_LOGIN_DETAIL = '/login'

/** Set when three inits in a row failed; the bridge stays off until restart. */
export const BRIDGE_FUSE_DETAIL = 'disabled after repeated failures · restart to retry'

/** Set when the session needs this machine's signature, which a new sign-in can't give. */
export const BRIDGE_DEVICE_BOUND_DETAIL =
  "the session refused a request that only the computer it is bound to can sign, so signing in again won't fix it"

export const BRIDGE_RETRY_FOOTER = 'Run /remote-control to retry'

/** Disconnect-dialog hint for terminal (and network) failures. */
export const BRIDGE_RETRY_HINT =
  'To try again, choose Continue, wait about 10 seconds for Remote Control to switch off, then run /remote-control.'

/** Disconnect-dialog hint when retrying won't help. */
export const BRIDGE_KEEP_WORKING_HINT = 'You can keep working here without Remote Control.'

const DIALOG_HINT_BY_KIND: Record<BridgeErrorKind, string> = {
  auth: 'Run /login to restore Remote Control.',
  network: BRIDGE_RETRY_HINT,
  terminal: BRIDGE_RETRY_HINT,
  ended_elsewhere: BRIDGE_KEEP_WORKING_HINT,
}

/** Details that already tell the user what to do next (official bxn). */
export function detailSaysWhatToDo(detail: string | undefined): boolean {
  return (
    detail === BRIDGE_DEVICE_BOUND_DETAIL ||
    detail?.includes('/login') === true ||
    detail?.includes('/remote-control') === true ||
    detail?.includes('restart') === true ||
    detail?.includes('policy') === true ||
    detail?.includes('update') === true
  )
}

/** Notification title: "disconnected" once the session had a live handle, "failed" before. */
export function bridgeFailedTitle(wasConnected: boolean): string {
  return `Remote Control ${wasConnected ? 'disconnected' : 'failed'}`
}

/**
 * Footer of the Remote Control dialog while an error is set. Undefined when
 * retrying can't help (fuse tripped, device-bound, ended elsewhere).
 */
export function bridgeFailedFooter(
  error: string,
  kind: BridgeErrorKind | undefined,
): string | undefined {
  if (error === BRIDGE_FUSE_DETAIL || error === BRIDGE_DEVICE_BOUND_DETAIL) return undefined
  if (kind === 'ended_elsewhere') return undefined
  return BRIDGE_RETRY_FOOTER
}

/** What to do next, shown under the error in the /remote-control dialog. */
export function bridgeFailedDialogHint(
  error: string,
  kind: BridgeErrorKind | undefined,
): string {
  if (error === BRIDGE_DEVICE_BOUND_DETAIL) return BRIDGE_KEEP_WORKING_HINT
  const hint = DIALOG_HINT_BY_KIND[kind ?? 'terminal']
  if (hint === BRIDGE_RETRY_HINT && detailSaysWhatToDo(error) && !error.includes('/remote-control')) {
    return ''
  }
  if (kind === 'auth' && error !== BRIDGE_LOGIN_DETAIL && error.includes('/login')) return ''
  return hint
}

/** Close code in words. Our transports report no close cause, so 4090 uses the generic text. */
export function describeCloseCode(code: number | undefined): string {
  switch (code) {
    case undefined:
      return 'no close code received'
    case 4090:
      return 'this connection is no longer the active worker for the session (code 4090)'
    case 4091:
      return 'transport init failed (code 4091)'
    case 4092:
      return 'connection dropped — no close reason from server (code 4092)'
    case 4093:
      return 'presence heartbeats to the server kept failing (code 4093)'
    case 4094:
      return 'worker credential expired or rejected (code 4094)'
    case 401:
      return 'auth token expired (code 401)'
    case 403:
      return 'server rejected connection (code 403)'
    case 404:
      return 'session not found on server (code 404)'
    case 1002:
      return 'server rejected the connection handshake (code 1002)'
    case 4001:
      return 'session expired or not found on server (code 4001)'
    case 4003:
      return 'server rejected credentials (code 4003)'
    default:
      return `code ${code}`
  }
}
