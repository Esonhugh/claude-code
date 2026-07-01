#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalHome = process.env.HOME
const originalOpenAIAuthToken = process.env.OPENAI_AUTH_TOKEN
const originalOpenAIApiKey = process.env.OPENAI_API_KEY
const homeDir = await mkdtemp(join(tmpdir(), 'openai-auth-env-'))

try {
  process.env.OPENAI_AUTH_TOKEN = 'sk-env-token'

  const { decodeOpenAIIdTokenClaims, getOpenAIAuthInfo, getOpenAIApiKey } =
    await import('./auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()

  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'sk-env-token',
    isChatGPT: false,
  })
  assert.equal(getOpenAIApiKey(), 'sk-env-token')

  delete process.env.OPENAI_AUTH_TOKEN
  process.env.OPENAI_API_KEY = 'sk-openai-api-env-token'
  process.env.HOME = homeDir
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await writeFile(
    join(homeDir, '.codex', 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'sk-auth-json-token' }),
  )
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()

  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'sk-openai-api-env-token',
    isChatGPT: false,
  })
  assert.equal(getOpenAIApiKey(), 'sk-openai-api-env-token')

  const payload = Buffer.from(
    JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
  ).toString('base64url')
  assert.deepEqual(decodeOpenAIIdTokenClaims(`header.${payload}.signature`), {
    name: 'Alice',
    email: 'alice@example.com',
  })
} finally {
  const { getOpenAIAuthInfo, getOpenAIApiKey } = await import('./auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalOpenAIAuthToken === undefined) delete process.env.OPENAI_AUTH_TOKEN
  else process.env.OPENAI_AUTH_TOKEN = originalOpenAIAuthToken
  if (originalOpenAIApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAIApiKey
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-auth-env.test.ts passed')
