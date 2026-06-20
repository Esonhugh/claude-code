#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { saveOpenAIAuth, saveOpenAIApiKey, getOpenAIAuthPath } = await import(
  './storage.js'
)
const authModule = await import('../../utils/auth.js')

const homeDir = await mkdtemp(join(tmpdir(), 'openai-oauth-storage-'))

try {
  const authPath = getOpenAIAuthPath(homeDir)
  assert.equal(authPath, join(homeDir, '.codex', 'auth.json'))

  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-123',
      },
      last_refresh: '2026-06-20T00:00:00.000Z',
    },
    { homeDir },
  )

  const raw = await readFile(authPath, 'utf-8')
  assert.deepEqual(JSON.parse(raw), {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'id-token',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      account_id: 'account-123',
    },
    last_refresh: '2026-06-20T00:00:00.000Z',
  })

  const fileStat = await stat(authPath)
  assert.equal(fileStat.mode & 0o077, 0)

  await saveOpenAIApiKey('sk-test-api-key', {
    homeDir,
    now: new Date('2026-06-20T00:00:02.000Z'),
  })
  const apiKeyRaw = await readFile(authPath, 'utf-8')
  assert.deepEqual(JSON.parse(apiKeyRaw), {
    auth_mode: 'apikey',
    tokens: {
      access_token: 'sk-test-api-key',
    },
    last_refresh: '2026-06-20T00:00:02.000Z',
  })
  const apiKeyFileStat = await stat(authPath)
  assert.equal(apiKeyFileStat.mode & 0o077, 0)

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'stale-token',
    isChatGPT: true,
  })
  authModule.getOpenAIApiKey.cache.set(undefined, null)
  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'new-id-token',
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      },
      last_refresh: '2026-06-20T00:00:01.000Z',
    },
    { homeDir },
  )
  assert.equal(authModule.getOpenAIAuthInfo.cache.get(undefined), undefined)
  assert.equal(authModule.getOpenAIApiKey.cache.get(undefined), undefined)
} finally {
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getOpenAIApiKey.cache.clear?.()
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-oauth storage.test.ts passed')
