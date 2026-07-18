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
const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const homeDir = await mkdtemp(join(tmpdir(), 'openai-auth-env-'))

try {
  process.env.HOME = homeDir
  process.env.OPENAI_AUTH_TOKEN = 'sk-env-token'

  const {
    decodeOpenAIIdTokenClaims,
    formatOpenAIPlanName,
    getOpenAIAuthInfo,
    getOpenAIApiKey,
  } = await import('./auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()

  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'sk-env-token',
    isChatGPT: false,
  })
  assert.equal(getOpenAIApiKey(), 'sk-env-token')

  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await writeFile(
    join(homeDir, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'chatgpt-token' },
    }),
  )
  getOpenAIAuthInfo.cache.clear?.()
  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'chatgpt-token',
    accountId: undefined,
    isChatGPT: true,
    accountName: undefined,
    email: undefined,
    planType: undefined,
    planDisplayName: undefined,
  })

  delete process.env.OPENAI_AUTH_TOKEN
  process.env.OPENAI_API_KEY = 'sk-openai-api-env-token'
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
    JSON.stringify({
      name: 'Alice',
      email: 'alice@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    }),
  ).toString('base64url')
  assert.deepEqual(decodeOpenAIIdTokenClaims(`header.${payload}.signature`), {
    name: 'Alice',
    email: 'alice@example.com',
    chatgptPlanType: 'plus',
  })
  assert.equal(formatOpenAIPlanName('plus'), 'Plus')
  assert.equal(formatOpenAIPlanName('pro'), 'Pro')
  assert.equal(formatOpenAIPlanName('team'), 'Team')
  assert.equal(
    formatOpenAIPlanName('self_serve_business_usage_based'),
    'Business',
  )
  assert.equal(formatOpenAIPlanName('enterprise_cbp_usage_based'), 'Enterprise')
  assert.equal(formatOpenAIPlanName('hc'), 'Enterprise')

  delete process.env.OPENAI_API_KEY
  await writeFile(
    join(homeDir, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'chatgpt-token',
        id_token: `header.${payload}.signature`,
      },
    }),
  )
  getOpenAIAuthInfo.cache.clear?.()
  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'chatgpt-token',
    accountId: undefined,
    isChatGPT: true,
    accountName: 'Alice',
    email: 'alice@example.com',
    planType: 'plus',
    planDisplayName: 'Plus',
  })

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const { getLogoDisplayData } = await import('./logoV2Utils.js')
  assert.equal(getLogoDisplayData().billingType, 'ChatGPT Plus')
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
  if (originalUseOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-auth-env.test.ts passed')
