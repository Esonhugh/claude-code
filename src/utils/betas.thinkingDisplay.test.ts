import { afterEach, expect, test } from 'bun:test'
import { modelSupportsThinkingDisplay } from './betas.js'

const keys = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
function useEnv(env: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, env)
}
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('first party sends thinking.display except on Claude 3 and Haiku 4.5', () => {
  useEnv({})
  expect(modelSupportsThinkingDisplay('claude-sonnet-4-6')).toBe(true)
  expect(modelSupportsThinkingDisplay('claude-haiku-4-5')).toBe(false)
  expect(modelSupportsThinkingDisplay('claude-3-7-sonnet-20250219')).toBe(false)
})

test('Vertex and Bedrock send it only from Claude Opus 4.7 on', () => {
  useEnv({ CLAUDE_CODE_USE_VERTEX: '1' })
  expect(modelSupportsThinkingDisplay('claude-sonnet-4-6')).toBe(false)
  expect(modelSupportsThinkingDisplay('claude-opus-4-7')).toBe(true)
  useEnv({ CLAUDE_CODE_USE_BEDROCK: '1' })
  expect(modelSupportsThinkingDisplay('us.anthropic.claude-sonnet-4-6')).toBe(false)
  expect(modelSupportsThinkingDisplay('us.anthropic.claude-opus-4-7')).toBe(true)
})

test('Foundry always sends it; disabled experimental betas never do', () => {
  useEnv({ CLAUDE_CODE_USE_FOUNDRY: '1' })
  expect(modelSupportsThinkingDisplay('claude-sonnet-4-6')).toBe(true)
  useEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' })
  expect(modelSupportsThinkingDisplay('claude-sonnet-4-6')).toBe(false)
})
