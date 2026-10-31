import { afterEach, expect, mock, test } from 'bun:test'

let settings: { includeGitInstructions?: boolean } = {}
const real = await import('./settings/settings.js')
mock.module('./settings/settings.js', () => ({
  ...real,
  getInitialSettings: () => settings,
}))
const { shouldIncludeGitInstructions } = await import('./gitSettings.js')

const saved = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  else process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = saved
  settings = {}
})

test('git instructions are off unless turned on (personal agent, not only for repos)', () => {
  delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  expect(shouldIncludeGitInstructions()).toBe(false)
  settings = { includeGitInstructions: true }
  expect(shouldIncludeGitInstructions()).toBe(true)
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
  expect(shouldIncludeGitInstructions()).toBe(false)
  settings = {}
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '0'
  expect(shouldIncludeGitInstructions()).toBe(true)
})
