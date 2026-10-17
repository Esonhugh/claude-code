import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import axios from 'axios'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from './claudeai.js'

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalGet = axios.get

afterEach(() => {
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  axios.get = originalGet
  getClaudeAIOAuthTokens.cache.clear?.()
  clearClaudeAIMcpConfigsCache()
})

test('does not discover Claude AI Apps in OpenAI mode', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  getClaudeAIOAuthTokens.cache.set(undefined, {
    accessToken: 'claude-oauth-token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:mcp_servers'],
    subscriptionType: null,
    rateLimitTier: null,
  })
  let requests = 0
  axios.get = (async () => {
    requests++
    throw new Error('Claude AI Apps endpoint must not be called')
  }) as typeof axios.get

  assert.deepEqual(await fetchClaudeAIMcpConfigsIfEligible(), {})
  assert.equal(requests, 0)
})
