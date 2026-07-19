#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalHome = process.env.HOME
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalNodeEnv = process.env.NODE_ENV
const originalAxiosGet = axios.get
const tempHome = mkdtempSync(join(tmpdir(), 'claude-openai-model-options-'))

try {
  process.env.HOME = tempHome
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.ANTHROPIC_MODEL

  const authModule = await import('../auth.js')
  const { saveGlobalConfig } = await import('../config.js')
  const openAIModelOptions = await import('./openaiModelOptions.js')
  const { getModelOptions } = await import('./modelOptions.js')

  assert.deepEqual(
    openAIModelOptions.parseOpenAIModelOptions({
      data: [
        { id: 'gpt-5.6', display_name: 'GPT-5.6', description: 'Online' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
        { id: 'codex-auto-review', visibility: 'hide' },
        { id: 'gpt-disabled', supported_in_api: false },
      ],
    }),
    [
      { value: 'gpt-5.6', label: 'GPT-5.6', description: 'Online' },
      {
        value: 'codex-auto-review',
        label: 'codex-auto-review (Hidden)',
        description: 'Hidden by OpenAI; API support is enabled.',
      },
    ],
  )
  assert.deepEqual(
    openAIModelOptions.parseOpenAIModelOptions({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
        {
          slug: 'codex-auto-review',
          visibility: 'hide',
          description: 'Internal review model',
        },
      ],
    }),
    [
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'OpenAI model' },
      {
        value: 'codex-auto-review',
        label: 'codex-auto-review (Hidden)',
        description:
          'Hidden by OpenAI; API support is enabled. Internal review model',
      },
    ],
  )

  assert.deepEqual(
    getModelOptions()
      .map(option => option.value)
      .filter(value => value === 'gpt-5.5' || value === 'gpt-5.4-mini'),
    ['gpt-5.5', 'gpt-5.4-mini'],
  )
  assert.equal(getModelOptions().some(option => option.value === 'sonnet'), false)
  assert.equal(getModelOptions().some(option => option.value === 'opus'), false)

  saveGlobalConfig(current => ({
    ...current,
    openAIModelOptionsCache: [
      { value: 'gpt-online', label: 'GPT Online', description: 'From API' },
    ],
  }))
  assert.equal(getModelOptions()[0]?.value, 'gpt-online')

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
        data: [{ id: 'gpt-api', display_name: 'GPT API' }],
      },
    }
  }) as typeof axios.get

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'api-token',
    isChatGPT: false,
  })
  assert.deepEqual(await openAIModelOptions.fetchOpenAIModelOptions(), [
    { value: 'gpt-api', label: 'GPT API', description: 'OpenAI model' },
  ])
  assert.equal(requests[0]!.url, 'https://api.openai.com/v1/models')
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer api-token')

  requests.length = 0
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'chatgpt-token',
    accountId: 'account-123',
    isChatGPT: true,
  })
  await openAIModelOptions.fetchOpenAIModelOptions()
  assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(requests[0]!.headers?.['chatgpt-account-id'], 'account-123')
  assert.deepEqual(requests[0]!.params, { client_version: 'test' })
} finally {
  axios.get = originalAxiosGet
  const authModule = await import('../auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = originalAnthropicModel
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  rmSync(tempHome, { recursive: true, force: true })
}

console.log('openaiModelOptions.test.ts passed')
