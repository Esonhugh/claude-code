import { describe, expect, test } from 'bun:test'
import {
  BRIDGE_DEVICE_BOUND_DETAIL,
  BRIDGE_FUSE_DETAIL,
  BRIDGE_KEEP_WORKING_HINT,
  BRIDGE_LOGIN_DETAIL,
  BRIDGE_RETRY_FOOTER,
  BRIDGE_RETRY_HINT,
  bridgeFailedDialogHint,
  bridgeFailedFooter,
  bridgeFailedTitle,
  describeCloseCode,
  detailSaysWhatToDo,
} from './bridgeFailure.js'

// Official 2.1.325 texts.
describe('Remote Control failure texts', () => {
  test('the toast says "disconnected" only once the session had connected', () => {
    expect(bridgeFailedTitle(true)).toBe('Remote Control disconnected')
    expect(bridgeFailedTitle(false)).toBe('Remote Control failed')
  })

  test.each([
    [undefined, 'no close code received'],
    [4090, 'this connection is no longer the active worker for the session (code 4090)'],
    [4091, 'transport init failed (code 4091)'],
    [4092, 'connection dropped — no close reason from server (code 4092)'],
    [4093, 'presence heartbeats to the server kept failing (code 4093)'],
    [4094, 'worker credential expired or rejected (code 4094)'],
    [401, 'auth token expired (code 401)'],
    [403, 'server rejected connection (code 403)'],
    [404, 'session not found on server (code 404)'],
    [1002, 'server rejected the connection handshake (code 1002)'],
    [4001, 'session expired or not found on server (code 4001)'],
    [4003, 'server rejected credentials (code 4003)'],
    [4500, 'code 4500'],
  ])('close code %p reads "%s"', (code, text) => {
    expect(describeCloseCode(code)).toBe(text)
  })

  test.each(['run /login', 'run /remote-control again', 'restart to retry', 'org policy', 'please update', BRIDGE_DEVICE_BOUND_DETAIL])(
    '"%s" already says what to do', detail => {
      expect(detailSaysWhatToDo(detail)).toBe(true)
    },
  )

  test('a plain detail does not', () => {
    expect(detailSaysWhatToDo('connection to server lost')).toBe(false)
    expect(detailSaysWhatToDo(undefined)).toBe(false)
  })
})

describe('Remote Control dialog footer while failed', () => {
  test('no retry footer when retrying cannot help', () => {
    expect(bridgeFailedFooter(BRIDGE_FUSE_DETAIL, 'terminal')).toBeUndefined()
    expect(bridgeFailedFooter(BRIDGE_DEVICE_BOUND_DETAIL, 'terminal')).toBeUndefined()
    expect(bridgeFailedFooter('session ended', 'ended_elsewhere')).toBeUndefined()
  })

  test('otherwise it offers /remote-control', () => {
    expect(bridgeFailedFooter('connection to server lost', 'terminal')).toBe(BRIDGE_RETRY_FOOTER)
    expect(bridgeFailedFooter(BRIDGE_LOGIN_DETAIL, 'auth')).toBe('Run /remote-control to retry')
    expect(bridgeFailedFooter('x', undefined)).toBe(BRIDGE_RETRY_FOOTER)
  })
})

describe('/remote-control dialog hint per kind', () => {
  test('auth points at /login', () => {
    expect(bridgeFailedDialogHint(BRIDGE_LOGIN_DETAIL, 'auth')).toBe('Run /login to restore Remote Control.')
    expect(bridgeFailedDialogHint('auth token expired (code 401)', 'auth')).toBe('Run /login to restore Remote Control.')
  })

  test('auth whose detail already names /login shows none', () => {
    expect(bridgeFailedDialogHint('OAuth token refresh failed — run /login to re-authenticate', 'auth')).toBe('')
  })

  test('terminal, network and unclassified explain the 10s wait', () => {
    expect(BRIDGE_RETRY_HINT).toBe(
      'To try again, choose Continue, wait about 10 seconds for Remote Control to switch off, then run /remote-control.',
    )
    expect(bridgeFailedDialogHint('connection to server lost', 'terminal')).toBe(BRIDGE_RETRY_HINT)
    expect(bridgeFailedDialogHint('connection to server lost', 'network')).toBe(BRIDGE_RETRY_HINT)
    expect(bridgeFailedDialogHint('connection to server lost', undefined)).toBe(BRIDGE_RETRY_HINT)
  })

  test('a terminal detail that says what to do drops the hint, unless it names /remote-control', () => {
    expect(bridgeFailedDialogHint(BRIDGE_FUSE_DETAIL, 'terminal')).toBe('')
    expect(bridgeFailedDialogHint('run `claude update` to upgrade', 'terminal')).toBe('')
    expect(bridgeFailedDialogHint('session expired · /remote-control to reconnect', 'terminal')).toBe(BRIDGE_RETRY_HINT)
  })

  test('ended elsewhere and device-bound say to keep working', () => {
    expect(bridgeFailedDialogHint('session ended', 'ended_elsewhere')).toBe('You can keep working here without Remote Control.')
    expect(bridgeFailedDialogHint(BRIDGE_DEVICE_BOUND_DETAIL, 'terminal')).toBe(BRIDGE_KEEP_WORKING_HINT)
  })
})
