#!/usr/bin/env node
import assert from 'node:assert/strict'
import axios from 'axios'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

function jwtWithExp(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp })}.signature`
}

const originalPost = axios.post
const originalHome = process.env.HOME
const originalOpenAIBaseToken = process.env.OPENAI_AUTH_TOKEN
const originalHttpsProxy = process.env.https_proxy
const homeDir = await mkdtemp(join(tmpdir(), 'openai-refresh-'))
process.env.HOME = homeDir
delete process.env.OPENAI_AUTH_TOKEN
process.env.https_proxy = 'http://127.0.0.1:8080'

const authModule = await import('../../utils/auth.js')
const { saveOpenAIAuth, saveOpenAIApiKey, getOpenAIAuthPath } = await import('./storage.js')
const { checkAndRefreshOpenAITokenIfNeeded } = await import('./refresh.js')

try {
  const nowSeconds = Math.floor(Date.now() / 1000)

  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'old-id-token',
        access_token: jwtWithExp(nowSeconds + 60),
        refresh_token: 'old-refresh-token',
        account_id: 'account-123',
      },
      last_refresh: '2026-01-01T00:00:00.000Z',
    },
    { homeDir },
  )

  const requests: Array<{
    url: string
    body: unknown
    headers?: Record<string, string>
    proxy?: unknown
  }> = []
  axios.post = (async (
    url: string,
    body: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown },
  ) => {
    requests.push({ url, body, headers: config?.headers, proxy: config?.proxy })
    return {
      status: 200,
      data: {
        id_token: 'new-id-token',
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      },
    }
  }) as typeof axios.post

  assert.equal(await checkAndRefreshOpenAITokenIfNeeded({ homeDir }), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, 'https://auth.openai.com/oauth/token')
  assert.deepEqual(requests[0]!.body, {
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    grant_type: 'refresh_token',
    refresh_token: 'old-refresh-token',
  })
  assert.equal(requests[0]!.headers?.['Content-Type'], 'application/json')
  assert.deepEqual(requests[0]!.proxy, {
    protocol: 'http',
    host: '127.0.0.1',
    port: 8080,
  })

  const refreshed = JSON.parse(await readFile(getOpenAIAuthPath(homeDir), 'utf-8'))
  assert.equal(refreshed.tokens.id_token, 'new-id-token')
  assert.equal(refreshed.tokens.access_token, 'new-access-token')
  assert.equal(refreshed.tokens.refresh_token, 'new-refresh-token')
  assert.notEqual(refreshed.last_refresh, '2026-01-01T00:00:00.000Z')

  requests.length = 0
  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwtWithExp(nowSeconds + 3600),
        refresh_token: 'fresh-refresh-token',
      },
      last_refresh: new Date().toISOString(),
    },
    { homeDir },
  )
  assert.equal(await checkAndRefreshOpenAITokenIfNeeded({ homeDir }), false)
  assert.equal(requests.length, 0)

  await saveOpenAIApiKey('sk-test-api-key', { homeDir })
  assert.equal(await checkAndRefreshOpenAITokenIfNeeded({ homeDir }), false)
  assert.equal(requests.length, 0)
} finally {
  axios.post = originalPost
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getOpenAIApiKey.cache.clear?.()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalOpenAIBaseToken === undefined) delete process.env.OPENAI_AUTH_TOKEN
  else process.env.OPENAI_AUTH_TOKEN = originalOpenAIBaseToken
  if (originalHttpsProxy === undefined) delete process.env.https_proxy
  else process.env.https_proxy = originalHttpsProxy
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-oauth refresh.test.ts passed')
