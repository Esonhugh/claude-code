import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, setCwdState } from '../bootstrap/state.js'
import * as settings from './settings/settings.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import {
  cleanupWorktree,
  createAgentWorktree,
  enterExistingWorktree,
  getCurrentWorktreeSession,
  removeAgentWorktree,
  resolveExistingWorktree,
  restoreWorktreeSession,
} from './worktree.js'

const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR'] as const
let root: string
let repo: string
let saved: (string | undefined)[]
let restoreSettings: (() => void) | undefined

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim()
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'worktree-baseref-')))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  resetSettingsCache()
  resetStateForTests()
  // origin has commit A; the local clone adds unpushed commit B.
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(root, 'clone', '-q', join(root, 'origin.git'), 'repo')
  repo = join(root, 'repo')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'A')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'B')
  setCwdState(repo)
})

afterEach(async () => {
  restoreSettings?.()
  restoreSettings = undefined
  restoreWorktreeSession(null)
  envKeys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  resetSettingsCache()
  resetStateForTests()
  await rm(root, { recursive: true, force: true })
})

function useBaseRef(baseRef: 'fresh' | 'head' | undefined): void {
  const spy = spyOn(settings, 'getInitialSettings').mockReturnValue(
    baseRef ? { worktree: { baseRef } } : {},
  )
  restoreSettings = () => spy.mockRestore()
}

test('worktree.baseRef "head" branches agent worktrees from local HEAD', async () => {
  useBaseRef('head')
  const head = git(repo, 'rev-parse', 'HEAD')
  const created = await createAgentWorktree('base-head')
  expect(created.headCommit).toBe(head)
  expect(git(created.worktreePath, 'rev-parse', 'HEAD')).toBe(head)
  await removeAgentWorktree(created.worktreePath, created.worktreeBranch, repo)
})

test('the default "fresh" base branches from origin/<default-branch>', async () => {
  useBaseRef(undefined)
  const originMain = git(repo, 'rev-parse', 'origin/main')
  expect(originMain).not.toBe(git(repo, 'rev-parse', 'HEAD'))
  const created = await createAgentWorktree('base-fresh')
  expect(git(created.worktreePath, 'rev-parse', 'HEAD')).toBe(originMain)
  await removeAgentWorktree(created.worktreePath, created.worktreeBranch, repo)
})

test('"head" from inside a linked worktree uses that worktree\'s HEAD', async () => {
  useBaseRef('head')
  const linked = join(root, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked)
  git(linked, 'commit', '-q', '--allow-empty', '-m', 'C')
  setCwdState(linked)
  const created = await createAgentWorktree('base-linked')
  expect(git(created.worktreePath, 'rev-parse', 'HEAD')).toBe(
    git(linked, 'rev-parse', 'HEAD'),
  )
  await removeAgentWorktree(created.worktreePath, created.worktreeBranch, repo)
})

test('entering an existing worktree by path never removes it on cleanup', async () => {
  const existing = join(root, 'existing')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', existing)

  const session = await enterExistingWorktree('session-1', '../existing')
  expect(session).toMatchObject({
    originalCwd: repo,
    worktreePath: existing,
    worktreeBranch: 'feature',
    enteredExisting: true,
  })
  expect(getCurrentWorktreeSession()?.enteredExisting).toBe(true)

  await cleanupWorktree()
  expect(getCurrentWorktreeSession()).toBeNull()
  expect(existsSync(existing)).toBe(true)
  expect(git(repo, 'branch', '--list', 'feature')).toContain('feature')
})

test('rejects paths that are not linked worktrees of the repository', async () => {
  await expect(resolveExistingWorktree(repo)).rejects.toThrow(
    'is the main working tree, not a linked worktree',
  )
  await expect(resolveExistingWorktree(root)).rejects.toThrow(
    'is not a worktree of the repository',
  )
  await expect(resolveExistingWorktree(join(root, 'missing'))).rejects.toThrow(
    'Cannot enter worktree',
  )
})

test('a worktree session may only switch into managed worktrees', async () => {
  const outside = join(root, 'outside')
  git(repo, 'worktree', 'add', '-q', '-b', 'outside', outside)
  const managed = join(repo, '.claude', 'worktrees', 'managed')
  git(repo, 'worktree', 'add', '-q', '-b', 'managed', managed)
  expect((await resolveExistingWorktree(outside)).managed).toBe(false)
  expect((await resolveExistingWorktree(managed)).managed).toBe(true)

  await enterExistingWorktree('session-1', managed)
  setCwdState(managed)
  await expect(enterExistingWorktree('session-1', outside)).rejects.toThrow(
    'not under .claude/worktrees/',
  )
  setCwdState(repo)
  const second = join(repo, '.claude', 'worktrees', 'second')
  git(repo, 'worktree', 'add', '-q', '-b', 'second', second)
  const switched = await enterExistingWorktree('session-1', second)
  // The original directory is kept across switches.
  expect(switched.originalCwd).toBe(repo)
})
