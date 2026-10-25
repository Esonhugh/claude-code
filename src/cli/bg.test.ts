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

test('removeJob keeps a worktree with uncommitted or unpushed work and removes a clean one', async () => {
  const { execFileSync } = await import('child_process')
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { removeJob } = await import('./bg.js')
  const root = mkdtempSync(join(tmpdir(), 'bg-rm-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const repo = join(root, 'repo')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const base = git(repo, 'rev-parse', 'HEAD')

  const worktreeJob = (id: string): JobRecord => {
    const path = join(repo, '.claude', 'worktrees', id)
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${id}`, path)
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, 'jobs', id), { recursive: true })
    return {
      ...job(id, id),
      state: 'stopped',
      worktree: { worktreePath: path, worktreeBranch: `worktree-${id}`, originalCwd: repo, originalHeadCommit: base },
    }
  }

  const clean = worktreeJob('clean')
  expect(await removeJob(clean)).toEqual({ worktreePath: clean.worktree!.worktreePath })
  expect(existsSync(clean.worktree!.worktreePath)).toBe(false)
  expect(git(repo, 'branch', '--list', 'worktree-clean')).toBe('')

  const dirty = worktreeJob('dirty')
  writeFileSync(join(dirty.worktree!.worktreePath, 'new.txt'), 'x')
  const kept = await removeJob(dirty)
  expect(kept.kept?.reason).toBe('uncommitted')
  expect(existsSync(dirty.worktree!.worktreePath)).toBe(true)

  const ahead = worktreeJob('ahead')
  writeFileSync(join(ahead.worktree!.worktreePath, 'b.txt'), 'b')
  git(ahead.worktree!.worktreePath, 'add', '-A')
  git(ahead.worktree!.worktreePath, 'commit', '-qm', 'add b')
  const refused = await removeJob(ahead)
  expect(refused.kept?.reason).toBe('unpushed')
  expect(refused.kept?.detail).toMatch(/^1 unpushed commit on worktree-ahead: [0-9a-f]+ add b$/)
  // The value the refusal reported discards the commits.
  expect((await removeJob(ahead, refused.kept!.discard)).kept).toBeUndefined()
  expect(existsSync(ahead.worktree!.worktreePath)).toBe(false)
  delete process.env.CLAUDE_CONFIG_DIR
})
