import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lstatSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { getSessionId, setIsInteractive } from '../bootstrap/state.js'
import { hookProcessEnv } from './hooks.js'
import { getProjectTempDir } from './permissions/filesystem.js'

const keys = [
  'CLAUDE_CODE_BUILTIN_MODS_ARCHIVE',
  'CLAUDE_CODE_EMBEDDED_RIPGREP_PATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_KIND',
]
const saved = new Map<string, string | undefined>()
beforeEach(() => {
  for (const key of keys) saved.set(key, process.env[key])
  for (const key of keys) delete process.env[key]
})
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setIsInteractive(true)
  rmSync(join(getProjectTempDir(), getSessionId()), { recursive: true, force: true })
})

test('hooks see the session that ran them (official 2.1.329)', () => {
  setIsInteractive(false)
  const env = hookProcessEnv()
  expect(env).toMatchObject({
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: getSessionId(),
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ATTENDED: '0',
    CLAUDE_PID: String(process.pid),
  })
})

test('an interactive session, or one in the desktop app, is attended', () => {
  setIsInteractive(true)
  expect(hookProcessEnv().CLAUDE_CODE_SESSION_ATTENDED).toBe('1')
  setIsInteractive(false)
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
  expect(hookProcessEnv().CLAUDE_CODE_SESSION_ATTENDED).toBe('1')
  process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
  expect(hookProcessEnv().CLAUDE_CODE_SESSION_ATTENDED).toBe('0')
})

test('the packaged binary locations stay out of hook processes', () => {
  process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE = '/$bunfs/root/mods.zip'
  process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = '/$bunfs/root/rg'
  const env = hookProcessEnv()
  expect(env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE).toBeUndefined()
  expect(env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH).toBeUndefined()
})

test('hooks get a private directory for the notes of sessions they start (official 2.1.329)', () => {
  const dir = join(getProjectTempDir(), getSessionId(), 'started')
  expect(hookProcessEnv().CLAUDE_CODE_CHILD_NOTES_DIR).toBe(dir)
  expect(lstatSync(dir).isDirectory()).toBe(true)
  if (process.platform !== 'win32') expect(lstatSync(dir).mode & 0o777).toBe(0o700)
})

test.skipIf(process.platform === 'win32')('a symlink where the notes directory belongs is not handed to hooks', () => {
  const sessionDir = join(getProjectTempDir(), getSessionId())
  hookProcessEnv()
  rmSync(sessionDir, { recursive: true, force: true })
  symlinkSync(getProjectTempDir(), sessionDir)
  expect(hookProcessEnv().CLAUDE_CODE_CHILD_NOTES_DIR).toBeUndefined()
})
