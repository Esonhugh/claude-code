import { expect, test } from 'bun:test'
import type { Command } from '../../commands.js'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectSkillRows,
  formatSkillDoctorReport,
  getListingTokens,
  getWeekSkillTokens,
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
  expect(report).toMatch(/hidden\s+userSettings\s+-\s+-\s+0× {2}never/)
  expect(report).toMatch(/skill\s+source\s+context\s+7d tokens\s+uses {2}last used/)
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
  expect(report).toMatch(/mine +userSettings +< 20 +- +1× +today/)
  expect(report).toContain('All loaded skills have been used at least once.')
  expect(formatSkillDoctorReport([])).toContain('(no skills loaded)')
})

test('7d tokens sum attributed responses once per message within the week', async () => {
  const projects = mkdtempSync(join(tmpdir(), 'skill-doctor-'))
  const now = Date.parse('2026-10-24T12:00:00.000Z')
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
  const line = (id: string, skill: string, timestamp: string, output = 5) =>
    JSON.stringify({ type: 'assistant', uuid: `${id}-${output}`, timestamp, attributionSkill: skill, message: { id, usage: { ...usage, output_tokens: output } } })
  mkdirSync(join(projects, 'p', 's1', 'subagents'), { recursive: true })
  writeFileSync(
    join(projects, 'p', 's1.jsonl'),
    [
      line('msg_a', 'mine', '2026-10-24T10:00:00.000Z', 5),
      // Same response, later content block: counted once with the final usage.
      line('msg_a', 'mine', '2026-10-24T10:00:01.000Z', 20),
      line('msg_old', 'mine', '2026-10-01T10:00:00.000Z'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-24T10:00:00.000Z', message: { id: 'msg_none', usage } }),
    ].join('\n'),
  )
  writeFileSync(join(projects, 'p', 's1', 'subagents', 'agent-1.jsonl'), line('msg_b', 'forked', '2026-10-23T10:00:00.000Z'))
  writeFileSync(join(projects, 'p', 'stale.jsonl'), line('msg_c', 'mine', '2026-10-24T10:00:00.000Z'))
  utimesSync(join(projects, 'p', 'stale.jsonl'), new Date('2026-10-01'), new Date('2026-10-01'))

  const totals = await getWeekSkillTokens(projects, now)
  expect(Object.fromEntries(totals)).toEqual({ mine: 130, forked: 115 })

  const report = formatSkillDoctorReport(
    collectSkillRows([skill('mine')], new Map([['mine', 5]]), { mine: { usageCount: 1, lastUsedAt: now } }, now, totals),
  )
  expect(report).toMatch(/mine +userSettings +< 20 +130 +1× +today/)
})
