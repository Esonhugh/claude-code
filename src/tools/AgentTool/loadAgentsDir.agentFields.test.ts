import { expect, test } from 'bun:test'
import {
  parseAgentFromJson,
  parseAgentFromMarkdown,
} from './loadAgentsDir.js'

const base = { name: 'reviewer', description: 'Reviews code' }

test('markdown frontmatter reads omitClaudeMd and autoCompactWindow', () => {
  const agent = parseAgentFromMarkdown(
    '/repo/.claude/agents/reviewer.md',
    '/repo/.claude/agents',
    { ...base, omitClaudeMd: true, autoCompactWindow: 150000 },
    'Review the diff.',
    'projectSettings',
  )
  expect(agent?.omitClaudeMd).toBe(true)
  expect(agent?.autoCompactWindow).toBe(150_000)

  const quoted = parseAgentFromMarkdown(
    '/repo/.claude/agents/reviewer.md',
    '/repo/.claude/agents',
    { ...base, omitClaudeMd: 'true', autoCompactWindow: '200000' },
    'Review the diff.',
    'projectSettings',
  )
  expect(quoted?.omitClaudeMd).toBe(true)
  expect(quoted?.autoCompactWindow).toBe(200_000)
})

test('markdown frontmatter ignores out-of-range autoCompactWindow and false omitClaudeMd', () => {
  for (const autoCompactWindow of [50_000, 2_000_000, 'big', 150_000.5]) {
    const agent = parseAgentFromMarkdown(
      '/repo/.claude/agents/reviewer.md',
      '/repo/.claude/agents',
      { ...base, omitClaudeMd: false, autoCompactWindow },
      'Review the diff.',
      'projectSettings',
    )
    expect(agent).not.toBeNull()
    expect(agent?.autoCompactWindow).toBeUndefined()
    expect(agent?.omitClaudeMd).toBeUndefined()
  }
})

test('--agents JSON accepts autoCompactWindow within 100K to 1M', () => {
  const agent = parseAgentFromJson('reviewer', {
    description: 'Reviews code',
    prompt: 'Review the diff.',
    autoCompactWindow: 300_000,
    omitClaudeMd: true,
  })
  expect(agent?.autoCompactWindow).toBe(300_000)
  expect(agent?.omitClaudeMd).toBe(true)
  expect(
    parseAgentFromJson('reviewer', {
      description: 'Reviews code',
      prompt: 'Review the diff.',
      autoCompactWindow: 99_999,
    }),
  ).toBeNull()
})
