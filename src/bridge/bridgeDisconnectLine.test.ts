import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { Message } from '../types/message.js'
import { createSystemMessage, createUserMessage } from '../utils/messages.js'
import { bridgeDisconnectedLine, withBridgeDisconnectedLine } from './bridgeDisconnectLine.js'

const CODE_MODE_REFUSAL =
  "Remote Control isn't available in Code Mode (experimental) yet. To use Remote Control, quit Claude Code and start it again with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE set to 0."

describe('Remote Control disconnected line (official 2.1.325 useReplBridge)', () => {
  test('adds the detail and the reconnect hint', () => {
    expect(bridgeDisconnectedLine('connection reset')).toBe(
      'Remote Control disconnected — connection reset — run /remote-control to reconnect',
    )
  })

  test('without a detail it still offers the hint', () => {
    expect(bridgeDisconnectedLine(undefined)).toBe('Remote Control disconnected — run /remote-control to reconnect')
  })

  test('the Code Mode refusal gets the hint, as in official', () => {
    expect(bridgeDisconnectedLine(CODE_MODE_REFUSAL)).toBe(
      `Remote Control disconnected — ${CODE_MODE_REFUSAL} — run /remote-control to reconnect`,
    )
  })

  test.each([
    'run /login to sign in again',
    'run /remote-control again',
    'restart to retry',
    'blocked by your organization policy',
    'try again after you update',
    "the session refused a request that only the computer it is bound to can sign, so signing in again won't fix it",
  ])('no hint when the detail already says what to do: %s', detail => {
    expect(bridgeDisconnectedLine(detail)).toBe(`Remote Control disconnected — ${detail}`)
  })

  test('is a warning-level system row', () => {
    const [row] = withBridgeDisconnectedLine([], 'x')
    expect(row).toMatchObject({ type: 'system', subtype: 'informational', level: 'warning', content: bridgeDisconnectedLine('x') })
  })

  test('is not repeated when the last row already says it', () => {
    const once = withBridgeDisconnectedLine([createUserMessage({ content: 'hi' })], 'x')
    expect(withBridgeDisconnectedLine(once, 'x')).toBe(once)
    expect(withBridgeDisconnectedLine(once, 'y')).toHaveLength(3)
  })

  test('a different row in between lets it show again', () => {
    const rows: Message[] = [createSystemMessage(bridgeDisconnectedLine('x'), 'warning'), createUserMessage({ content: 'hi' })]
    expect(withBridgeDisconnectedLine(rows, 'x')).toHaveLength(3)
  })
})

describe('the next-step hint follows the failure kind', () => {
  test('auth without a /login in the detail points at /login', () => {
    expect(bridgeDisconnectedLine('auth token expired (code 401)', 'auth')).toBe(
      'Remote Control disconnected — auth token expired (code 401) — run /login to restore Remote Control',
    )
  })

  test('auth whose detail already names /login adds nothing', () => {
    expect(bridgeDisconnectedLine('/login', 'auth')).toBe('Remote Control disconnected — /login')
    expect(bridgeDisconnectedLine('OAuth token refresh failed — run /login to re-authenticate', 'auth')).toBe(
      'Remote Control disconnected — OAuth token refresh failed — run /login to re-authenticate',
    )
  })

  test('ended elsewhere adds nothing', () => {
    expect(bridgeDisconnectedLine('session ended', 'ended_elsewhere')).toBe('Remote Control disconnected — session ended')
  })

  test('terminal is the default and offers /remote-control', () => {
    expect(bridgeDisconnectedLine('x', 'terminal')).toBe(bridgeDisconnectedLine('x'))
    expect(withBridgeDisconnectedLine([], 'x', 'auth')[0]).toMatchObject({
      content: 'Remote Control disconnected — x — run /login to restore Remote Control',
    })
  })
})

describe('useReplBridge writes the line where official does', () => {
  const source = readFileSync(new URL('../hooks/useReplBridge.tsx', import.meta.url), 'utf8')

  // The hook behaviour itself is covered by hooks/useReplBridge.failure.test.ts.
  test('an init that throws writes it instead of a "failed to connect" line', () => {
    expect(source).not.toContain('Remote Control failed to connect')
  })
})
