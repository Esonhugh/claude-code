import { expect, test } from 'bun:test'
import { buildMemoryLines } from './memdir.js'

test('excludes project instructions from auto-memory', () => {
  const prompt = buildMemoryLines('auto memory', '/tmp/memory/').join('\n')

  expect(prompt).toContain(
    'Anything already documented in AGENTS.md or CLAUDE.md files.',
  )
})
