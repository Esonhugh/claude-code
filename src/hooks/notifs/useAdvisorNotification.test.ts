import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getAdvisorNotice } from './useAdvisorNotification.js'

const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_USE_OPENAI',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('the advisor notice follows the pairing', () => {
  expect(getAdvisorNotice('opus', 'claude-sonnet-4-6')).toBe('on')
  expect(getAdvisorNotice('claude-sonnet-4-6', 'claude-opus-5')).toBe('pairing')
  expect(getAdvisorNotice(undefined, 'claude-sonnet-4-6')).toBeUndefined()
  expect(getAdvisorNotice('opus', 'claude-opus-4-5')).toBeUndefined()
  expect(getAdvisorNotice('claude-opus-4-5', 'claude-sonnet-4-6')).toBeUndefined()
})

test('no notice when the advisor is off for the provider or by env', () => {
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
  expect(getAdvisorNotice('opus', 'claude-sonnet-4-6')).toBeUndefined()
  delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  expect(getAdvisorNotice('opus', 'claude-sonnet-4-6')).toBeUndefined()
})
