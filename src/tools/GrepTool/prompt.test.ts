import { afterEach, expect, test } from 'bun:test'
import { getDescription } from './prompt.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT
})

test('lean prompt mode uses the short official Grep description', () => {
  process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT = '1'
  const description = getDescription()
  expect(description).toStartWith('Content search built on ripgrep.')
  expect(description).toContain('`multiline: true` for patterns that span lines.')
  expect(description).not.toContain('ALWAYS use')
})

test('the full prompt keeps the long Grep description', () => {
  process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT = '0'
  expect(getDescription()).toStartWith('A powerful search tool built on ripgrep')
})
