import { expect, test } from 'bun:test'
import { type JobRecord, resolveJob } from '../daemon/protocol.js'
import { formatBackgroundedHint, splitBgArgs } from './bg.js'

test('splitBgArgs drops --bg, the prompt and session args but keeps flags', () => {
  expect(
    splitBgArgs(['--bg', '--model', 'haiku', 'fix the build', '--permission-mode', 'acceptEdits'], 'fix the build'),
  ).toEqual({ flags: ['--model', 'haiku', '--permission-mode', 'acceptEdits'], resume: undefined })
  expect(splitBgArgs(['--background', '--resume', 'abc-123'], undefined)).toEqual({
    flags: [],
    resume: 'abc-123',
  })
  expect(splitBgArgs(['--resume=abc', '--session-id', 'x', '--bg'], undefined)).toEqual({ flags: [], resume: 'abc' })
})

test('splitBgArgs removes only one occurrence of a prompt that equals a flag value', () => {
  expect(splitBgArgs(['--name', 'review', 'review', '--bg'], 'review')).toEqual({
    flags: ['--name', 'review'],
    resume: undefined,
  })
})

const job = (id: string, name: string): JobRecord => ({
  id,
  sessionId: `${id}-0000`,
  name,
  intent: name,
  cwd: '/w',
  args: [],
  state: 'running',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
})

test('resolveJob matches id, id prefix and part of the name', () => {
  const jobs = [job('0dfccbf0', 'fix the build'), job('4bcd2e22', 'write release notes')]
  expect((resolveJob(jobs, '4bcd2e22') as JobRecord).id).toBe('4bcd2e22')
  expect((resolveJob(jobs, '0df') as JobRecord).id).toBe('0dfccbf0')
  expect((resolveJob(jobs, 'Release') as JobRecord).id).toBe('4bcd2e22')
  expect(resolveJob(jobs, 'zzz')).toContain('No background session matches "zzz"')
  expect(resolveJob([job('aa000000', 'build a'), job('ab000000', 'build b')], 'build')).toContain('matches 2 sessions')
})

test('backgrounded hint matches official wording', () => {
  expect(formatBackgroundedHint('0dfccbf0')).toBe(
    [
      'backgrounded · 0dfccbf0',
      '  claude agents             list sessions',
      '  claude attach 0dfccbf0    open in this terminal',
      '  claude logs 0dfccbf0      show recent output',
      '  claude stop 0dfccbf0      stop this session',
    ].join('\n'),
  )
})
