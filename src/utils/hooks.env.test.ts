import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getSessionId, setIsInteractive } from '../bootstrap/state.js'
import { hookProcessEnv } from './hooks.js'

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
