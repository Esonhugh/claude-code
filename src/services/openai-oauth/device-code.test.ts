#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalPost = axios.post
const {
  requestOpenAIDeviceCode,
  pollOpenAIDeviceCode,
  loginOpenAIWithDeviceCode,
} = await import('./device-code.js')
const { getOpenAIAuthPath } = await import('./storage.js')

type AxiosRequest = {
  url: string
  body: unknown
  headers?: Record<string, string>
  proxy?: unknown
  signal?: AbortSignal
}

function parseJsonBody(body: unknown): unknown {
  assert.equal(typeof body, 'string')
  return JSON.parse(body as string)
}

try {
  const userCodeRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    userCodeRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    return {
      status: 200,
      data: {
        device_auth_id: 'device-auth-123',
        user_code: 'CODE-12345',
        interval: '0',
      },
    }
  }) as typeof axios.post

  const deviceCode = await requestOpenAIDeviceCode()
  assert.deepEqual(deviceCode, {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'CODE-12345',
    deviceAuthId: 'device-auth-123',
    interval: 0,
  })
  assert.equal(
    userCodeRequests[0]!.url,
    'https://auth.openai.com/api/accounts/deviceauth/usercode',
  )
  assert.deepEqual(parseJsonBody(userCodeRequests[0]!.body), {
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  })
  assert.equal(userCodeRequests[0]!.headers?.['Content-Type'], 'application/json')

  let pollAttempt = 0
  const pollRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    pollRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    pollAttempt += 1
    if (pollAttempt === 1) {
      return { status: 403, data: {} }
    }
    return {
      status: 200,
      data: {
        authorization_code: 'poll-code-321',
        code_challenge: 'code-challenge-321',
        code_verifier: 'code-verifier-321',
      },
    }
  }) as typeof axios.post

  const polled = await pollOpenAIDeviceCode({
    deviceAuthId: 'device-auth-123',
    userCode: 'CODE-12345',
    interval: 0,
    sleep: async () => {},
    maxWaitMs: 1000,
  })
  assert.deepEqual(polled, {
    authorizationCode: 'poll-code-321',
    codeChallenge: 'code-challenge-321',
    codeVerifier: 'code-verifier-321',
  })
  assert.equal(pollRequests.length, 2)
  assert.equal(
    pollRequests[0]!.url,
    'https://auth.openai.com/api/accounts/deviceauth/token',
  )
  assert.deepEqual(parseJsonBody(pollRequests[0]!.body), {
    device_auth_id: 'device-auth-123',
    user_code: 'CODE-12345',
  })

  const homeDir = await mkdtemp(join(tmpdir(), 'openai-device-code-'))
  const deviceCodeEvents: Array<{ verificationUrl: string; userCode: string }> = []
  const loginRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    loginRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    if (url.endsWith('/api/accounts/deviceauth/usercode')) {
      return {
        status: 200,
        data: {
          device_auth_id: 'device-auth-login',
          user_code: 'LOGIN-123',
          interval: '0',
        },
      }
    }
    if (url.endsWith('/api/accounts/deviceauth/token')) {
      return {
        status: 200,
        data: {
          authorization_code: 'login-code',
          code_challenge: 'login-challenge',
          code_verifier: 'login-verifier',
        },
      }
    }
    if (url.endsWith('/oauth/token')) {
      assert.equal(body instanceof URLSearchParams, true)
      assert.equal(
        (body as URLSearchParams).get('redirect_uri'),
        'https://auth.openai.com/deviceauth/callback',
      )
      assert.equal((body as URLSearchParams).get('code'), 'login-code')
      assert.equal((body as URLSearchParams).get('code_verifier'), 'login-verifier')
      return {
        status: 200,
        data: {
          id_token: 'id-token-device',
          access_token: 'access-token-device',
          refresh_token: 'refresh-token-device',
          account_id: 'account-device',
        },
      }
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof axios.post

  const authPath = await loginOpenAIWithDeviceCode({
    homeDir,
    sleep: async () => {},
    onDeviceCode: info => {
      deviceCodeEvents.push({
        verificationUrl: info.verificationUrl,
        userCode: info.userCode,
      })
    },
  })
  assert.equal(authPath, getOpenAIAuthPath(homeDir))
  assert.deepEqual(deviceCodeEvents, [
    {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'LOGIN-123',
    },
  ])
  const saved = JSON.parse(await readFile(authPath, 'utf-8'))
  assert.equal(saved.auth_mode, 'chatgpt')
  assert.equal(saved.tokens.access_token, 'access-token-device')
  assert.equal(saved.tokens.refresh_token, 'refresh-token-device')
  assert.equal(saved.tokens.id_token, 'id-token-device')
  assert.equal(saved.tokens.account_id, 'account-device')
  assert.equal(loginRequests.some(request => request.url.endsWith('/oauth/token')), true)

  axios.post = (async () => {
    return {
      status: 500,
      data: {},
    }
  }) as typeof axios.post
  await assert.rejects(
    requestOpenAIDeviceCode(),
    /device code request failed with status 500/,
  )

  axios.post = (async () => {
    return {
      status: 500,
      data: {},
    }
  }) as typeof axios.post
  await assert.rejects(
    pollOpenAIDeviceCode({
      deviceAuthId: 'device-auth-123',
      userCode: 'CODE-12345',
      interval: 0,
      sleep: async () => {},
      maxWaitMs: 1000,
    }),
    /device auth failed with status 500/,
  )

  const abortController = new AbortController()
  abortController.abort()
  await assert.rejects(
    pollOpenAIDeviceCode({
      deviceAuthId: 'device-auth-123',
      userCode: 'CODE-12345',
      interval: 0,
      signal: abortController.signal,
      sleep: async () => {},
      maxWaitMs: 1000,
    }),
    /device code login cancelled/,
  )
} finally {
  axios.post = originalPost
}

console.log('openai-oauth device-code.test.ts passed')
