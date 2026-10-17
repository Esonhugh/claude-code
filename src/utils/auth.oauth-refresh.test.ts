import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { OAuthTokens } from '../services/oauth/types.js'

const failedTokens: OAuthTokens = {
  accessToken: 'failed-access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  scopes: ['user:profile'],
  subscriptionType: null,
  rateLimitTier: null,
}
let storedTokens = failedTokens
let onLock: (() => void) | undefined

const refreshOAuthToken = mock(() =>
  Promise.resolve({
    ...failedTokens,
    accessToken: 'refreshed-access-token',
  }),
)
const update = mock((data: { claudeAiOauth?: OAuthTokens }) => {
  storedTokens = data.claudeAiOauth!
  return { success: true }
})

mock.module('../services/oauth/client.js', () => ({
  isOAuthTokenExpired: (expiresAt: number | null) =>
    expiresAt !== null && expiresAt <= Date.now(),
  refreshOAuthToken,
  shouldUseClaudeAIAuth: (scopes?: string[]) =>
    scopes?.includes('user:profile') ?? false,
}))
mock.module('./secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    name: 'test',
    read: () => ({ claudeAiOauth: storedTokens }),
    readAsync: () => Promise.resolve({ claudeAiOauth: storedTokens }),
    update,
  }),
}))
mock.module('./lockfile.js', () => ({
  lock: async () => {
    onLock?.()
    return async () => {}
  },
}))

const auth = await import('./auth.js')

describe('forced OAuth refresh after a 401', () => {
  beforeEach(() => {
    storedTokens = { ...failedTokens }
    onLock = undefined
    refreshOAuthToken.mockClear()
    update.mockClear()
    auth.clearOAuthTokenCache()
  })

  test('refreshes the rejected token even when its local expiry is in the future', async () => {
    expect(await auth.handleOAuth401Error(failedTokens.accessToken)).toBe(true)
    expect(refreshOAuthToken).toHaveBeenCalledTimes(1)
  })

  test('reuses a token replaced by another process while waiting for the lock', async () => {
    onLock = () => {
      storedTokens = {
        ...failedTokens,
        accessToken: 'other-process-access-token',
      }
    }

    expect(await auth.handleOAuth401Error(failedTokens.accessToken)).toBe(true)
    expect(refreshOAuthToken).not.toHaveBeenCalled()
  })

  test('reports failure when the refreshed token cannot be persisted', async () => {
    update.mockImplementationOnce(() => ({ success: false }))

    expect(await auth.handleOAuth401Error(failedTokens.accessToken)).toBe(false)
  })
})
