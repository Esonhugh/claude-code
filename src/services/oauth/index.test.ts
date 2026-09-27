import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const exchangeCodeForTokens = mock(() =>
  Promise.resolve({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    scope: 'user:profile',
  }),
)

mock.module('./client.js', () => ({
  buildAuthUrl: ({ state, isManual }: { state: string; isManual: boolean }) =>
    `https://example.test/auth?state=${state}&manual=${isManual}`,
  exchangeCodeForTokens,
  fetchProfileInfo: () =>
    Promise.resolve({
      subscriptionType: null,
      rateLimitTier: null,
      rawProfile: undefined,
    }),
  parseScopes: () => ['user:profile'],
  shouldUseClaudeAIAuth: () => true,
}))
mock.module('./crypto.js', () => ({
  generateCodeVerifier: () => 'verifier',
  generateCodeChallenge: () => 'challenge',
  generateState: () => 'expected-state',
}))
mock.module('../../utils/browser.js', () => ({ openBrowser: mock(() => {}) }))
mock.module('src/services/analytics/index.js', () => ({ logEvent: mock(() => {}) }))

const { OAuthService } = await import('./index.js')

describe('OAuthService manual callback state', () => {
  let service: InstanceType<typeof OAuthService>

  beforeEach(() => {
    exchangeCodeForTokens.mockClear()
    service = new OAuthService()
  })

  afterEach(() => service.cleanup())

  test('rejects a mismatched state without exchanging the code', async () => {
    let submitCode!: (value: { authorizationCode: string; state: string }) => void
    const flow = service.startOAuthFlow(async () => {
      submitCode = value => service.handleManualAuthCodeInput(value)
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(() =>
      submitCode({ authorizationCode: 'wrong-code', state: 'wrong-state' }),
    ).toThrow('OAuth state mismatch')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()

    submitCode({ authorizationCode: 'right-code', state: 'expected-state' })
    await expect(flow).resolves.toMatchObject({ accessToken: 'access-token' })
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1)
  })
})
