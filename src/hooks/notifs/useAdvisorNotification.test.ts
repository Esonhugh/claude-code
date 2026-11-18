import { afterEach, beforeEach, expect, test } from 'bun:test'
import { hasAdvisorNotice } from './useAdvisorNotification.js'

const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  SWITCH,
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

test('the advisor notice shows for any advisor that is set', () => {
  process.env[SWITCH] = '1'
  expect(hasAdvisorNotice('opus')).toBe(true)
  expect(hasAdvisorNotice('claude-haiku-4-5')).toBe(true)
  expect(hasAdvisorNotice('Opus 5.5')).toBe(true)
  expect(hasAdvisorNotice(undefined)).toBe(false)
  // Another provider still has the local advisor.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  expect(hasAdvisorNotice('opus')).toBe(true)
})

test('no notice when the advisor is off', () => {
  expect(hasAdvisorNotice('opus')).toBe(false)
  process.env[SWITCH] = '1'
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
  expect(hasAdvisorNotice('opus')).toBe(false)
})
