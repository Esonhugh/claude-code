#!/usr/bin/env node
import assert from 'node:assert/strict'
import axios from 'axios'
import { OpenAIAuthCodeListener } from './auth-code-listener.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalPost = axios.post
const {
  buildOpenAIAuthUrl,
  exchangeOpenAICodeForTokens,
  createOpenAIPKCE,
  loginOpenAIWithOAuth,
} = await import('./client.js')

try {
  const pkce = createOpenAIPKCE()
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
  assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]+$/)
  assert.equal(pkce.state.length >= 32, true)

  const authUrl = new URL(
    buildOpenAIAuthUrl({
      codeChallenge: 'challenge-123',
      state: 'state-123',
      port: 1455,
    }),
  )
  assert.equal(authUrl.origin, 'https://auth.openai.com')
  assert.equal(authUrl.pathname, '/oauth/authorize')
  assert.equal(
    authUrl.searchParams.get('client_id'),
    'app_EMoamEEZ73f0CkXaXp7hrann',
  )
  assert.equal(authUrl.searchParams.get('response_type'), 'code')
  assert.equal(
    authUrl.searchParams.get('scope'),
    'openid profile email offline_access api.connectors.read api.connectors.invoke',
  )
  assert.equal(authUrl.searchParams.get('code_challenge'), 'challenge-123')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('id_token_add_organizations'), 'true')
  assert.equal(authUrl.searchParams.get('codex_cli_simplified_flow'), 'true')
  assert.equal(authUrl.searchParams.get('originator'), 'codex_cli_rs')
  assert.equal(authUrl.searchParams.get('state'), 'state-123')
  assert.equal(
    authUrl.searchParams.get('redirect_uri'),
    'http://localhost:1455/auth/callback',
  )

  const requests: Array<{
    url: string
    body: URLSearchParams
    headers?: Record<string, string>
    proxy?: false | {
      protocol?: string
      host: string
      port?: number
    }
    hasHttpsAgent?: boolean
  }> = []
  axios.post = (async (
    url: string,
    body: URLSearchParams,
    config?: { headers?: Record<string, string>; proxy?: false; httpsAgent?: unknown },
  ) => {
    requests.push({
      url,
      body,
      headers: config?.headers,
      proxy: config?.proxy,
      hasHttpsAgent: Boolean(config?.httpsAgent),
    })
    return {
      status: 200,
      data: {
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-123',
      },
    }
  }) as typeof axios.post

  const tokenResponse = await exchangeOpenAICodeForTokens({
    authorizationCode: 'auth-code',
    codeVerifier: 'verifier-123',
    port: 1455,
  })

  assert.deepEqual(tokenResponse, {
    id_token: 'id-token',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    account_id: 'account-123',
  })
  assert.equal(requests[0]!.url, 'https://auth.openai.com/oauth/token')
  assert.equal(requests[0]!.body instanceof URLSearchParams, true)
  assert.equal(requests[0]!.body.get('grant_type'), 'authorization_code')
  assert.equal(requests[0]!.body.get('code'), 'auth-code')
  assert.equal(requests[0]!.body.get('code_verifier'), 'verifier-123')
  assert.equal(
    requests[0]!.body.get('client_id'),
    'app_EMoamEEZ73f0CkXaXp7hrann',
  )
  assert.equal(
    requests[0]!.body.get('redirect_uri'),
    'http://localhost:1455/auth/callback',
  )
  assert.equal(
    requests[0]!.headers?.['Content-Type'],
    'application/x-www-form-urlencoded',
  )
  assert.equal(requests[0]!.proxy, undefined)
  assert.equal(requests[0]!.hasHttpsAgent, false)

  const originalHttpsProxy = process.env.https_proxy
  process.env.https_proxy = 'http://127.0.0.1:7890'
  try {
    await exchangeOpenAICodeForTokens({
      authorizationCode: 'auth-code-with-proxy',
      codeVerifier: 'verifier-with-proxy',
      port: 1455,
    })
  } finally {
    if (originalHttpsProxy === undefined) {
      delete process.env.https_proxy
    } else {
      process.env.https_proxy = originalHttpsProxy
    }
  }
  assert.deepEqual(requests[1]!.proxy, {
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
  })
  assert.equal(requests[1]!.hasHttpsAgent, false)

  axios.post = (async () => {
    const error = new Error('Request failed with status code 403') as Error & {
      response?: { status: number; data: string }
    }
    error.response = {
      status: 403,
      data: '{"error":"invalid_grant","error_description":"bad verifier"}',
    }
    throw error
  }) as typeof axios.post
  await assert.rejects(
    exchangeOpenAICodeForTokens({
      authorizationCode: 'bad-code',
      codeVerifier: 'bad-verifier',
      port: 1455,
    }),
    /token endpoint returned status 403: .*bad verifier/,
  )

  const defaultPortListener = new OpenAIAuthCodeListener('/auth/callback')
  assert.equal(await defaultPortListener.start(), 1455)
  defaultPortListener.close()

  const listener = new OpenAIAuthCodeListener('/auth/callback')
  await listener.start(0)
  await assert.rejects(
    listener.waitForAuthorization('state-456', async () => {
      throw new Error('browser launch failed')
    }),
    /browser launch failed/,
  )
  listener.close()

  const successListener = new OpenAIAuthCodeListener('/auth/callback')
  const successPort = await successListener.start(0)
  const authorizationPromise = successListener.waitForAuthorization(
    'state-success',
    async () => {
      await fetch(
        `http://localhost:${successPort}/auth/callback?code=auth-code-success&state=state-success`,
      )
    },
  )
  assert.equal(await authorizationPromise, 'auth-code-success')
  successListener.close()

  let observedAuthUrl = ''
  await assert.rejects(
    loginOpenAIWithOAuth({
      onAuthUrl: url => {
        observedAuthUrl = url
      },
      openBrowser: async url => {
        throw new Error(`stop after url ${url}`)
      },
    }),
    /stop after url/,
  )
  assert.match(observedAuthUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
  assert.equal(new URL(observedAuthUrl).searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(new URL(observedAuthUrl).searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
} finally {
  axios.post = originalPost
}

console.log('openai-oauth client.test.ts passed')
