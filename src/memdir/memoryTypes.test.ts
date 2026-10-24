import { expect, test } from 'bun:test'
import { buildExtractAutoOnlyPrompt } from '../services/extractMemories/prompts.js'
import { buildMemoryLines } from './memdir.js'

test('excludes project instructions from auto-memory', () => {
  const prompt = buildMemoryLines('auto memory', '/tmp/memory/').join('\n')

  expect(prompt).toContain(
    'anything already documented in AGENTS.md or CLAUDE.md files',
  )
})

test('auto-memory prompts use the compact rules, not the long type taxonomy', () => {
  const system = buildMemoryLines('auto memory', '/tmp/memory/').join('\n')
  const extract = buildExtractAutoOnlyPrompt(2, '')

  for (const prompt of [system, extract]) {
    expect(prompt).not.toContain('<types>')
    expect(prompt).toContain('`feedback`: guidance the user has given')
    expect(prompt).toContain('add a one-line pointer in `MEMORY.md`')
  }
  expect(system.length).toBeLessThan(3500)
  expect(extract.length).toBeLessThan(3500)
})

test('skipIndex drops the MEMORY.md pointer rule', () => {
  const system = buildMemoryLines('auto memory', '/tmp/memory/', undefined, true).join('\n')
  expect(system).not.toContain('one-line pointer')
  expect(buildExtractAutoOnlyPrompt(2, '', true)).not.toContain('one-line pointer')
})
