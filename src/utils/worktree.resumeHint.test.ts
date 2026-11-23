import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests } from '../bootstrap/state.js'
import {
  cleanupWorktree,
  getResumeHintWorktreeName,
  keepWorktree,
  restoreWorktreeSession,
  type WorktreeSession,
} from './worktree.js'

const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR'] as const
const cwd = process.cwd()
let root: string
let saved: (string | undefined)[]

function session(extra: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    originalCwd: root,
    worktreePath: join(root, '.claude', 'worktrees', 'wtJ'),
    worktreeName: 'wtJ',
    sessionId: '11111111-1111-4111-8111-111111111111',
    ...extra,
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'worktree-hint-')))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  resetStateForTests()
})

afterEach(async () => {
  restoreWorktreeSession(null)
  process.chdir(cwd)
  envKeys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  resetStateForTests()
  await rm(root, { recursive: true, force: true })
})

test('the resume hint names the worktree the session is in', () => {
  expect(getResumeHintWorktreeName()).toBeNull()
  restoreWorktreeSession(session())
  expect(getResumeHintWorktreeName()).toBe('wtJ')
})

test('a worktree the session only entered is not named', () => {
  restoreWorktreeSession(session({ enteredExisting: true }))
  expect(getResumeHintWorktreeName()).toBeNull()
})

test('a kept worktree is still named after the session leaves it', async () => {
  restoreWorktreeSession(session())
  await keepWorktree()
  expect(getResumeHintWorktreeName()).toBe('wtJ')
})

test('a removed worktree is no longer named', async () => {
  restoreWorktreeSession(session())
  await keepWorktree()
  restoreWorktreeSession(session({ hookBased: true }))
  await cleanupWorktree()
  expect(getResumeHintWorktreeName()).toBeNull()
})
