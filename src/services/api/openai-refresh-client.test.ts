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
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV
const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalHome = process.env.HOME
const originalOpenAIBaseToken = process.env.OPENAI_BASE_TOKEN
const originalBunOpenAIBaseToken = Bun.env.OPENAI_BASE_TOKEN
const homeDir = await mkdtemp(join(tmpdir(), 'openai-refresh-client-'))

try {
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'
  process.env.NODE_ENV = 'test'
  delete process.env.OPENAI_BASE_TOKEN
  delete Bun.env.OPENAI_BASE_TOKEN

  const { saveOpenAIAuth, getOpenAIAuthPath } = await import('../openai-oauth/storage.js')
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getOpenAIApiKey.cache.clear?.()

  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 60),
        refresh_token: 'old-refresh-token',
      },
      last_refresh: '2026-01-01T00:00:00.000Z',
    },
    { homeDir },
  )

  const requests: Array<{ body: unknown }> = []
  axios.post = (async (_url: string, body: unknown) => {
    requests.push({ body })
    return {
      status: 200,
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      },
    }
  }) as typeof axios.post

  assert.match(authModule.getOpenAIApiKey() ?? '', /signature$/)

  const { getAPIProvider } = await import('../../utils/model/providers.js')
  assert.equal(getAPIProvider(), 'openai')

  const { getAnthropicClient } = await import('./client.js')
  await getAnthropicClient({ maxRetries: 0 })

  const refreshed = JSON.parse(await readFile(getOpenAIAuthPath(homeDir), 'utf-8'))
  assert.equal(process.env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(requests.length, 1)
  assert.equal(refreshed.tokens.access_token, 'new-access-token')
} finally {
  axios.post = originalPost
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getOpenAIApiKey.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalOpenAIBaseToken === undefined) delete process.env.OPENAI_BASE_TOKEN
  else process.env.OPENAI_BASE_TOKEN = originalOpenAIBaseToken
  if (originalBunOpenAIBaseToken === undefined) delete Bun.env.OPENAI_BASE_TOKEN
  else Bun.env.OPENAI_BASE_TOKEN = originalBunOpenAIBaseToken
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-refresh-client.test.ts passed')
