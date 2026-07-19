#!/usr/bin/env node
import assert from 'node:assert/strict'
import axios from 'axios'

const originalAxiosGet = axios.get
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'

  const authModule = await import('../../utils/auth.js')
  const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
  const { fetchBootstrapData } = await import('./bootstrap.js')

  saveGlobalConfig(current => ({
    ...current,
    openAIModelOptionsCache: undefined,
  }))
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

  const requests: Array<{
    url: string
    headers: Record<string, string> | undefined
    params: Record<string, string> | undefined
  }> = []
  axios.get = (async (
    url: string,
    options?: {
      headers?: Record<string, string>
      params?: Record<string, string>
    },
  ) => {
    requests.push({ url, headers: options?.headers, params: options?.params })
    return {
      data: {
        data: [{ id: 'gpt-bootstrap', display_name: 'GPT Bootstrap' }],
      },
    }
  }) as typeof axios.get

  await fetchBootstrapData()

  assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(
    requests[0]!.headers?.['chatgpt-account-id'],
    'account-123',
  )
  assert.deepEqual(requests[0]!.params, { client_version: 'test' })
  assert.deepEqual(getGlobalConfig().openAIModelOptionsCache, [
    { value: 'gpt-bootstrap', label: 'GPT Bootstrap', description: 'OpenAI model' },
  ])
} finally {
  axios.get = originalAxiosGet
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
}

console.log('bootstrap-openai.test.ts passed')
