import { expect, test } from 'bun:test'
import type { Command } from '../../commands.js'
import {
  collectSkillRows,
  formatSkillDoctorReport,
  getListingTokens,
} from './skillDoctor.js'

const DAY = 86_400_000
const NOW = 100 * DAY

function skill(name: string, extra: Record<string, unknown> = {}): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    source: 'userSettings',
    loadedFrom: 'skills',
    progressMessage: '',
    contentLength: 0,
    getPromptForCommand: async () => [],
    ...extra,
  } as Command
}

const plugin = (name: string) => ({
  source: 'plugin',
  loadedFrom: 'plugin',
  pluginInfo: { pluginManifest: { name }, repository: `${name}@market` },
})

test('listing tokens are attributed per skill line', () => {
  const tokens = getListingTokens([skill('zeta'), skill('alpha')], 200_000)
  // "- alpha: alpha description" is 26 chars -> 7 tokens at 4 chars/token.
  expect(tokens.get('alpha')).toBe(7)
  expect(tokens.get('zeta')).toBe(6)
})

test('rows skip bundled/builtin/policy skills and workflows and sort never-used first', () => {
  const rows = collectSkillRows(
    [
      skill('used', {}),
      skill('never'),
      skill('bundled', { source: 'bundled', loadedFrom: 'bundled' }),
      skill('policy', { source: 'policySettings' }),
      skill('code-review', { source: 'projectSettings', kind: 'workflow' }),
      { type: 'local', name: 'help' } as Command,
    ],
    new Map([
      ['used', 5],
      ['never', 4],
    ]),
    { used: { usageCount: 3, lastUsedAt: NOW - 2 * DAY } },
    NOW,
  )
  expect(rows.map(r => [r.name, r.usageCount, r.daysSinceUse])).toEqual([
    ['never', 0, null],
    ['used', 3, 2],
  ])
})

test('report lists unused skills by owner with actionable hints', () => {
  const rows = collectSkillRows(
    [
      skill('mine'),
      skill('hidden'),
      skill('lint:fix', plugin('lint')),
      skill('docs:search', { source: 'mcp', loadedFrom: 'mcp' }),
    ],
    new Map([
      ['mine', 5],
      ['lint:fix', 6],
      ['docs:search', 7],
    ]),
    {},
    NOW,
  )
  const report = formatSkillDoctorReport(rows)
  expect(report).toContain('Skills loaded this session')
  expect(report).toMatch(/hidden\s+userSettings\s+-\s+0× {2}never/)
  expect(report).toContain(
    '1 skill loaded but never invoked. Each one adds to the system prompt every turn. Disable in /skills, or remove from .claude/skills.',
  )
  expect(report).toContain('1 plugin skill loaded but never invoked, from lint.')
  expect(report).toContain('1 MCP skill loaded but never invoked, from docs.')
  expect(report).not.toContain('\u001b[')
})

test('report congratulates when every skill was used and handles no skills', () => {
  const rows = collectSkillRows(
    [skill('mine')],
    new Map([['mine', 5]]),
    { mine: { usageCount: 1, lastUsedAt: NOW } },
    NOW,
  )
  const report = formatSkillDoctorReport(rows)
  expect(report).toMatch(/mine +userSettings +< 20 +1× +today/)
  expect(report).toContain('All loaded skills have been used at least once.')
  expect(formatSkillDoctorReport([])).toContain('(no skills loaded)')
})
