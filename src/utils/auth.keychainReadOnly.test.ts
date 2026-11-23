import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { OAuthTokens } from '../services/oauth/types.js'
import { createFallbackStorage } from './secureStorage/fallbackStorage.js'
import type { SecureStorageData } from './secureStorage/types.js'

// A Keychain that can be read but takes no write (#1420): the refresh token
// it holds is what every other session reads, so this session must not spend
// it on a refresh it cannot save.
const expired: OAuthTokens = {
  accessToken: 'old-access-token',
  refreshToken: 'old-refresh-token',
  expiresAt: Date.now() - 60_000,
  scopes: ['user:profile', 'user:inference'],
  subscriptionType: null,
  rateLimitTier: null,
}

let keychain: SecureStorageData | null
let keychainDeletes: boolean
let plaintext: SecureStorageData | null
const keychainStore = {
  name: 'keychain',
  read: () => keychain,
  readAsync: async () => keychain,
  update: () => ({ success: false }),
  delete: () => {
    if (keychainDeletes) keychain = null
    return keychainDeletes
  },
  probeWrite: async () => ({ success: false, exitCode: 1 }),
}
const plaintextStore = {
  name: 'plaintext',
  read: () => plaintext,
  readAsync: async () => plaintext,
  update: (data: SecureStorageData) => {
    plaintext = data
    return { success: true }
  },
  delete: () => {
    plaintext = null
    return true
  },
}
// The recovered SecureStorage type does not describe these methods.
const storage = createFallbackStorage(
  // @ts-ignore - test doubles cover the methods the fallback storage calls
  keychainStore,
  plaintextStore,
) as unknown as {
  read(): unknown
  update(data: SecureStorageData): { success: boolean }
}

// The server rotates the refresh token: the one sent is dead afterwards.
let liveRefreshToken: string
const refreshOAuthToken = mock(async (refreshToken: string) => {
  if (refreshToken !== liveRefreshToken) throw new Error('invalid_grant')
  liveRefreshToken = 'new-refresh-token'
  return {
    ...expired,
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
})

const oauthClient = await import('../services/oauth/client.js')
const authFileDescriptor = await import('./authFileDescriptor.js')
mock.module('../services/oauth/client.js', () => ({
  ...oauthClient,
  isOAuthTokenExpired: (expiresAt: number | null) =>
    expiresAt !== null && expiresAt <= Date.now(),
  refreshOAuthToken,
  shouldUseClaudeAIAuth: (scopes?: string[]) =>
    scopes?.includes('user:profile') ?? false,
}))
mock.module('./secureStorage/index.js', () => ({
  getSecureStorage: () => storage,
}))
mock.module('./authFileDescriptor.js', () => ({
  ...authFileDescriptor,
  getOAuthTokenFromFileDescriptor: () => null,
  getApiKeyFromFileDescriptor: () => null,
}))
const lockfile = { ...(await import('./lockfile.js')) }
mock.module('./lockfile.js', () => ({
  ...lockfile,
  lock: async () => async () => {},
}))

const auth = await import('./auth.js')
const fallbackStorage = await import('./secureStorage/fallbackStorage.js')

describe('OAuth refresh with a Keychain that takes no write', () => {
  beforeEach(() => {
    keychain = { claudeAiOauth: expired as unknown as string }
    keychainDeletes = false
    plaintext = null
    liveRefreshToken = expired.refreshToken!
    refreshOAuthToken.mockClear()
    // Optional so the old code fails on behaviour, not on a missing export.
    fallbackStorage._resetWriteProofForTesting?.()
    auth._resetHeldBackRefreshForTesting?.()
    auth.clearOAuthTokenCache()
  })

  test('sends no refresh token, so other sessions keep a working one', async () => {
    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    expect(refreshOAuthToken).not.toHaveBeenCalled()

    // Another session reads the same store and can still refresh with it.
    const other = storage.read() as { claudeAiOauth: OAuthTokens }
    await expect(
      refreshOAuthToken(other.claudeAiOauth.refreshToken!),
    ).resolves.toMatchObject({ refreshToken: 'new-refresh-token' })
  })

  test('does not ask again right away after a refusal', async () => {
    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    keychainDeletes = true
    auth.clearOAuthTokenCache()
    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    expect(keychain).not.toBeNull()
  })

  test('moves the credentials to the fallback first when the Keychain item can be removed', async () => {
    keychainDeletes = true

    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(refreshOAuthToken).toHaveBeenCalledTimes(1)
    expect(keychain).toBeNull()
    const other = storage.read() as { claudeAiOauth: OAuthTokens }
    expect(other.claudeAiOauth.refreshToken).toBe('new-refresh-token')
  })
})

describe('fallback storage write', () => {
  beforeEach(() => {
    keychain = { claudeAiOauth: expired as unknown as string }
    keychainDeletes = false
    plaintext = null
  })

  test('fails when the Keychain keeps an older entry that would shadow the fallback', () => {
    expect(storage.update({ claudeAiOauth: 'new' }).success).toBe(false)
  })

  test('succeeds when the older Keychain entry is removed', () => {
    keychainDeletes = true
    expect(storage.update({ claudeAiOauth: 'new' }).success).toBe(true)
    expect(storage.read()).toEqual({ claudeAiOauth: 'new' })
  })
})
