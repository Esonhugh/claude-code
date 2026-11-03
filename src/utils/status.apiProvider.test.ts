import { afterEach, expect, test } from 'bun:test'
import { buildAPIProviderProperties } from './status.js'

const saved = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('the OpenAI provider shows its custom base URL like the other providers', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://gw.example.com/v1'
  expect(buildAPIProviderProperties()).toContainEqual({
    label: 'OpenAI base URL',
    value: 'https://gw.example.com/v1',
  })
})
