import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import {
  codexAppAuthorizationLabel,
  codexAppListStatusLabel,
  codexAppUsabilityLabel,
  getCodexAppRuntimeStatus,
  getCodexAppStatusesRevision,
  parseCodexAppAuthFailure,
  recordCodexAppToolCancelled,
  recordCodexAppToolFailure,
  recordCodexAppToolStarted,
  recordCodexAppToolSuccess,
  resetCodexAppStatusesForTesting,
  shouldTrackCodexAppVerification,
} from './status.js'

const authFailureMeta = (connectorId = 'connector-calendar') => ({
  _codex_apps: {
    connector_auth_failure: {
      is_auth_failure: true,
      connector_id: connectorId,
      auth_reason: 'reauthentication_required',
    },
  },
})

describe('Codex App runtime status', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let temporaryConfigDir: string | undefined

  afterEach(() => {
    resetCodexAppStatusesForTesting()
    getOpenAIAuthInfo.cache.clear?.()
    if (temporaryConfigDir) {
      rmSync(temporaryConfigDir, { recursive: true, force: true })
      temporaryConfigDir = undefined
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  })

  test('accepts the upstream auth failure envelope for the expected connector', () => {
    expect(
      parseCodexAppAuthFailure('connector-calendar', authFailureMeta()),
    ).toEqual({ authReason: 'reauthentication_required' })
  })

  test('uses only explicitly read-only tools for health verification', () => {
    expect(shouldTrackCodexAppVerification(true)).toBe(true)
    expect(shouldTrackCodexAppVerification(false)).toBe(false)
    expect(shouldTrackCodexAppVerification(undefined)).toBe(false)
  })

  test('starts unchecked and advances the external-store revision on updates', () => {
    expect(getCodexAppRuntimeStatus('connector-calendar')).toEqual({
      kind: 'unchecked',
    })
    expect(getCodexAppStatusesRevision()).toBe(0)

    recordCodexAppToolStarted('connector-calendar')
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'checking',
    })
    expect(getCodexAppStatusesRevision()).toBe(1)

    recordCodexAppToolSuccess('connector-calendar')
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'ready',
    })
    expect(getCodexAppStatusesRevision()).toBe(2)
  })

  test('rejects auth metadata for a different connector', () => {
    expect(
      parseCodexAppAuthFailure(
        'connector-calendar',
        authFailureMeta('connector-mail'),
      ),
    ).toBeUndefined()
  })

  test('records auth failures and clears them after a successful call', () => {
    recordCodexAppToolFailure('connector-calendar', authFailureMeta())
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'needs-auth',
      authReason: 'reauthentication_required',
    })

    recordCodexAppToolSuccess('connector-calendar')
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'ready',
    })
  })

  test('transitions from ready to needs-auth when a later call loses authorization', () => {
    recordCodexAppToolSuccess('connector-calendar')
    recordCodexAppToolFailure('connector-calendar', authFailureMeta())

    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'needs-auth',
      authReason: 'reauthentication_required',
    })
  })

  test('distinguishes non-auth MCP failures from auth failures', () => {
    recordCodexAppToolFailure('connector-calendar', {
      unrelated: 'server error',
    })
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'error',
    })
  })

  test('records cancellation separately from server and auth failures', () => {
    recordCodexAppToolStarted('connector-calendar')
    recordCodexAppToolCancelled('connector-calendar')

    const status = getCodexAppRuntimeStatus('connector-calendar')
    expect(status).toMatchObject({ kind: 'cancelled' })
    expect(codexAppUsabilityLabel(status, true)).toBe(
      'Last tool call cancelled',
    )
  })

  test('reports disabled independently from the last observed auth state', () => {
    recordCodexAppToolFailure('connector-calendar', authFailureMeta())
    const status = getCodexAppRuntimeStatus('connector-calendar')

    expect(codexAppAuthorizationLabel(status)).toBe(
      'Re-authentication required',
    )
    expect(codexAppUsabilityLabel(status, false)).toBe('Disabled locally')
    expect(codexAppUsabilityLabel(status, true)).toBe(
      'Needs authentication',
    )
    expect(codexAppListStatusLabel(status, false)).toBe(
      'needs authentication',
    )
  })

  test('keeps observations scoped to the ChatGPT account', () => {
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'not-used',
      accountId: 'account-a',
      isChatGPT: true,
    })
    recordCodexAppToolSuccess('connector-calendar')

    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'not-used',
      accountId: 'account-b',
      isChatGPT: true,
    })
    expect(getCodexAppRuntimeStatus('connector-calendar')).toEqual({
      kind: 'unchecked',
    })
  })

  test('persists last-known status across CLI processes without credentials', () => {
    temporaryConfigDir = mkdtempSync(join(tmpdir(), 'codex-app-status-'))
    process.env.NODE_ENV = 'development'
    process.env.CLAUDE_CONFIG_DIR = temporaryConfigDir
    getOpenAIAuthInfo.cache.set(undefined, {
      accessToken: 'must-not-be-persisted',
      accountId: 'account-persistence-test',
      email: 'must-not-be-persisted@example.com',
      isChatGPT: true,
    })

    recordCodexAppToolSuccess('connector-calendar')
    const cachePath = join(
      temporaryConfigDir,
      'cache',
      'codex-app-status-v1.json',
    )
    const serialized = readFileSync(cachePath, 'utf-8')
    expect(serialized).not.toContain('must-not-be-persisted')
    expect(serialized).not.toContain('account-persistence-test')
    expect(statSync(cachePath).mode & 0o777).toBe(0o600)

    resetCodexAppStatusesForTesting()
    expect(getCodexAppRuntimeStatus('connector-calendar')).toMatchObject({
      kind: 'ready',
    })
  })
})
